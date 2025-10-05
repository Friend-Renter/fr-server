import { Router } from "express";
import { z } from "zod";

import {
  createBookingRequest,
  acceptBookingRequest,
  declineBookingRequest,
  listBookingRequests,
  bookingRequestCounts,
} from "./service.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { requireFlag } from "../../middlewares/flags.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

const ListQuery = z.object({
  view: z.enum(["host", "renter"]).default("host"),
  state: z.enum(["all", "pending", "accepted", "declined"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const CreateSchema = z.object({
  listingId: z.string().length(24),
  start: z.coerce.date(),
  end: z.coerce.date(),
  promoCode: z.string().trim().min(1).optional(),
  noteToHost: z.string().trim().max(1000).optional(),
});

router.post(
  "/",
  requireAuth,
  requireRole("renter"),
  requireFlag("bookings.enabled"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const body = CreateSchema.parse(req.body);
    const { doc, friendship } = await createBookingRequest({
      renterId: userId,
      listingId: body.listingId,
      start: body.start,
      end: body.end,
      promoCode: body.promoCode,
      noteToHost: body.noteToHost,
    });
    return jsonOk(res, {
      id: String(doc._id),
      state: doc.state,
      listingId: String(doc.listingId),
      start: doc.start,
      end: doc.end,
      friendship,
    });
  })
);

const IdParam = z.object({ id: z.string().length(24) });

const AcceptSchema = z.object({
  friendRequestId: z.string().length(24).optional(), // allow combo-accept
});

router.post(
  "/:id/accept",
  requireAuth,
  requireRole("host"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { id } = IdParam.parse(req.params);
    const { friendRequestId } = AcceptSchema.parse(req.body || {});
    const doc = await acceptBookingRequest({
      hostId: userId,
      requestId: id,
      friendRequestId,
    });
    return jsonOk(res, { id: String(doc._id), state: doc.state });
  })
);

router.post(
  "/:id/decline",
  requireAuth,
  requireRole("host"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { id } = IdParam.parse(req.params);
    const doc = await declineBookingRequest({ hostId: userId, requestId: id });
    return jsonOk(res, { id: String(doc._id), state: doc.state });
  })
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const q = ListQuery.parse(req.query);
    const out = await listBookingRequests({
      me: userId,
      view: q.view,
      state: q.state,
      limit: q.limit,
      cursor: q.cursor,
    });
    return jsonOk(res, out);
  })
);

router.get(
  "/counts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const out = await bookingRequestCounts(userId);
    return jsonOk(res, out);
  })
);

export default router;
