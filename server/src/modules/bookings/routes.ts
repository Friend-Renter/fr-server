import { Router } from "express";
import { z } from "zod";

import { type BookingDoc } from "./model.js";
import { checkIn, checkOut } from "./service.js";
import {
  createBooking,
  listBookings,
  acceptBooking,
  declineBooking,
  cancelPendingBooking,
} from "./service.js";
import { key as rkey } from "../../config/redis.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { requireFlag } from "../../middlewares/flags.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { getOrSetIdempotent } from "../../utils/idemptoency.js";
import { guardFriendshipOrEnsurePending } from "../friends/controller.js";
import { Listing } from "../listings/model.js";

const router = Router();

const CreateSchema = z.object({
  paymentIntentId: z.string().min(1),
});

router.post(
  "/",
  requireAuth,
  requireFlag("bookings.enabled"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { paymentIntentId } = CreateSchema.parse(req.body);

    // 1) Fetch PI from Stripe; we rely on metadata set in /payments/intents
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId).catch(() => null);
    if (!pi) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_PI", message: "Unknown PaymentIntent" } });
    }
    const listingId = String(pi.metadata?.listingId || "");
    if (!listingId || !/^[0-9a-f]{24}$/i.test(listingId)) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_PI", message: "Missing listingId metadata" } });
    }

    // 2) Resolve hostId from listing
    const listing = await Listing.findById(listingId, { hostId: 1, status: 1 }).lean();
    if (!listing || listing.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }
    const hostId = String(listing.hostId);

    // 3) Enforce friendship (idempotent helper will auto-create/ensure pending request)
    const guard = await guardFriendshipOrEnsurePending(userId, hostId);
    if (guard) {
      return res.status(403).json({ error: guard });
    }

    const doc = await createBooking({ renterId: userId, paymentIntentId });
    jsonOk(res, {
      id: doc.id,
      state: doc.state,
      start: doc.start,
      end: doc.end,
      granularity: doc.granularity,
      pricingSnapshot: doc.pricingSnapshot,
      paymentStatus: doc.paymentStatus,
    });
  })
);

const ListQuery = z.object({
  state: z
    .enum(["pending", "accepted", "declined", "cancelled", "in_progress", "completed"])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  role: z.enum(["renter", "host"]).optional(),
});

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role: myRole } = getAuth(req);
    const q = ListQuery.parse(req.query);
    const role = q.role ?? myRole;
    const out = await listBookings({
      userId,
      role: role === "host" ? "host" : "renter",
      state: q.state,
      page: q.page,
      limit: q.limit,
    });
    jsonOk(res, out);
  })
);

const IdParam = z.object({ id: z.string().length(24) });

router.post(
  "/:id/accept",
  requireAuth,
  requireRole("host"),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { userId } = getAuth(req);
    const doc = await acceptBooking(userId, id);
    jsonOk(res, { id: doc.id, state: doc.state });
  })
);

router.post(
  "/:id/decline",
  requireAuth,
  requireRole("host"),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { userId } = getAuth(req);
    const doc = await declineBooking(userId, id);
    jsonOk(res, { id: doc.id, state: doc.state });
  })
);

router.post(
  "/:id/cancel",
  requireAuth,
  requireRole("renter"),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { userId } = getAuth(req);
    const doc = await cancelPendingBooking(userId, id);
    jsonOk(res, { id: doc.id, state: doc.state });
  })
);

function shapeCheckpoint(cp?: BookingDoc["checkin"]) {
  if (!cp) return undefined;
  return {
    at: cp.at,
    by: cp.by ? String(cp.by) : undefined,
    notes: cp.notes,
    readings: cp.readings,
    photos: (cp.photos || []).map((p) => ({
      url: p.url,
      key: p.key,
      label: (p as any).label, // optional
    })),
  };
}

// POST /bookings/:id/checkin
router.post(
  "/:id/checkin",
  requireAuth,
  requireFlag("checkin.enabled"),
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { userId } = getAuth(req);

    const payload = {
      photos: req.body?.photos,
      notes: req.body?.notes,
      readings: req.body?.readings,
    };

    const idempHeader = String(req.get("X-Idempotency-Key") || "").trim();
    if (idempHeader) {
      const cacheKey = rkey("idemp", "bookings", "checkin", id, idempHeader);
      const { value } = await getOrSetIdempotent(cacheKey, 24 * 60 * 60, async () => {
        const b = await checkIn(userId, id, payload);
        return {
          status: 200,
          body: {
            id: String(b._id),
            state: b.state,
            checkin: shapeCheckpoint(b.checkin),
          },
        };
      });
      return res.status(value.status).json(value.body);
    }

    const b = await checkIn(userId, id, payload);
    return jsonOk(res, {
      id: String(b._id),
      state: b.state,
      checkin: shapeCheckpoint(b.checkin),
    });
  })
);

// POST /bookings/:id/checkout
router.post(
  "/:id/checkout",
  requireFlag("checkout.enabled"),
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { userId } = getAuth(req);

    const payload = {
      photos: req.body?.photos,
      notes: req.body?.notes,
      readings: req.body?.readings,
    };

    const idempHeader = String(req.get("X-Idempotency-Key") || "").trim();
    if (idempHeader) {
      const cacheKey = rkey("idemp", "bookings", "checkout", id, idempHeader);
      const { value } = await getOrSetIdempotent(cacheKey, 24 * 60 * 60, async () => {
        const b = await checkOut(userId, id, payload);
        return {
          status: 200,
          body: {
            id: String(b._id),
            state: b.state,
            checkout: shapeCheckpoint(b.checkout),
          },
        };
      });
      return res.status(value.status).json(value.body);
    }

    const b = await checkOut(userId, id, payload);
    return jsonOk(res, {
      id: String(b._id),
      state: b.state,
      checkout: shapeCheckpoint(b.checkout),
    });
  })
);

export default router;
