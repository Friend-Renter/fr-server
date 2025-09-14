import { Router } from "express";
import { z } from "zod";

import {
  createBooking,
  listBookings,
  acceptBooking,
  declineBooking,
  cancelPendingBooking,
} from "./service.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

const CreateSchema = z.object({
  paymentIntentId: z.string().min(1),
});

router.post(
  "/",
  requireAuth,
  requireRole("renter"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { paymentIntentId } = CreateSchema.parse(req.body);

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
  state: z.enum(["pending", "accepted", "declined", "cancelled"]).optional(),
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

export default router;
