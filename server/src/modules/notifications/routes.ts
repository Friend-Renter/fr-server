import { Router } from "express";
import { z } from "zod";

import { DeviceToken } from "./deviceModel.js";
import { Notification } from "./model.js";
import { getAuth, requireAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

/** Register device token */
router.post(
  "/devices/register",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const Body = z.object({
      token: z.string().min(10),
      platform: z.enum(["ios", "android"]),
      apnsEnv: z.enum(["dev", "prod"]).optional(),
    });
    const { token, platform, apnsEnv } = Body.parse(req.body);

    await DeviceToken.findOneAndUpdate(
      { token },
      { $set: { userId, platform, ...(platform === "ios" ? { apnsEnv: apnsEnv || "dev" } : {}) } },
      { upsert: true }
    );

    jsonOk(res, { ok: true });
  })
);

/** Unregister device token */
router.post(
  "/devices/unregister",
  requireAuth,
  asyncHandler(async (req, res) => {
    const Body = z.object({ token: z.string().min(10) });
    const { token } = Body.parse(req.body);
    await DeviceToken.deleteOne({ token });
    jsonOk(res, { ok: true });
  })
);

/** List notifications (cursor pagination, newest first) */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const Q = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().optional(),
    });
    const { limit, cursor } = Q.parse(req.query);

    const find: any = { userId };
    if (cursor) find._id = { $lt: cursor }; // naive cursor by _id

    const items = await Notification.find(find)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const nextCursor = items.length > limit ? String(items[limit]._id) : null;
    const page = items.slice(0, limit).map((n) => ({
      id: String(n._id),
      type: n.type,
      actor: n.actor || null,
      context: n.context || null,
      createdAt: n.createdAt,
      readAt: n.readAt || null,
    }));

    jsonOk(res, { items: page, nextCursor });
  })
);

/** Counts (unread) */
router.get(
  "/counts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const unread = await Notification.countDocuments({ userId, readAt: null });
    jsonOk(res, { unread });
  })
);

/** Mark single read */
router.post(
  "/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const id = String(req.params.id);
    await Notification.updateOne({ _id: id, userId }, { $set: { readAt: new Date() } });
    jsonOk(res, { ok: true });
  })
);

/** Mark all read */
router.post(
  "/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
    jsonOk(res, { ok: true });
  })
);

export default router;
