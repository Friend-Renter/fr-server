import type { Request, Response } from "express";

import { sortPair, FriendRequest, Friendship } from "./model.js";
import { areFriends, ensurePendingRequest, acceptRequest } from "./service.js";
import { getAuth } from "../../middlewares/auth.js";
import { User } from "../users/model.js";

function pubUser(u: any) {
  if (!u) return null;
  return {
    id: String(u._id),
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: u.fullName,
    email: u.email,
  };
}

export async function listFriends(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const status = String(req.query.status || "accepted");

  if (status === "accepted") {
    const docs = await Friendship.find({ $or: [{ userA: userId }, { userB: userId }] }).lean();
    const otherIds = docs.map((d) => (d.userA === userId ? d.userB : d.userA));
    const users = await User.find({ _id: { $in: otherIds } }).lean();
    const map = new Map(users.map((u) => [String(u._id), u]));
    return res.json({ items: otherIds.map((id) => ({ user: pubUser(map.get(id)) })) });
  }

  if (status === "incoming") {
    const docs = await FriendRequest.find({ toUserId: userId, status: "pending" }).lean();
    const users = await User.find({ _id: { $in: docs.map((d) => d.fromUserId) } }).lean();
    const map = new Map(users.map((u) => [String(u._id), u]));
    return res.json({
      items: docs.map((d) => ({
        requestId: String(d._id),
        fromUserId: d.fromUserId,
        user: pubUser(map.get(d.fromUserId)),
      })),
    });
  }

  if (status === "outgoing") {
    const docs = await FriendRequest.find({ fromUserId: userId, status: "pending" }).lean();
    const users = await User.find({ _id: { $in: docs.map((d) => d.toUserId) } }).lean();
    const map = new Map(users.map((u) => [String(u._id), u]));
    return res.json({
      items: docs.map((d) => ({
        requestId: String(d._id),
        toUserId: d.toUserId,
        user: pubUser(map.get(d.toUserId)),
      })),
    });
  }

  return res
    .status(400)
    .json({ error: { code: "BAD_STATUS", message: "status must be accepted|incoming|outgoing" } });
}

export async function postRequest(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId)
    return res.status(422).json({
      error: {
        code: "VALIDATION",
        details: [{ path: ["toUserId"], message: "toUserId is required" }],
      },
    });
  if (toUserId === userId)
    return res
      .status(422)
      .json({ error: { code: "INVALID_SELF", message: "Cannot friend yourself" } });

  const ensured = await ensurePendingRequest(userId, toUserId);
  if ("alreadyFriends" in ensured && ensured.alreadyFriends) {
    return res.json({ alreadyFriends: true });
  }
  return res.status(ensured.request?.wasNew ? 201 : 200).json({
    request: { id: String(ensured.request!._id), fromUserId: userId, toUserId, status: "pending" },
  });
}

export async function acceptFriendRequest(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const id = String(req.params.id);
  const fr = await FriendRequest.findById(id);
  if (!fr || fr.status !== "pending")
    return res.status(404).json({ error: { code: "REQUEST_NOT_FOUND" } });
  if (fr.toUserId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN" } });

  await acceptRequest(fr);
  return res.json({ ok: true });
}

export async function declineFriendRequest(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const id = String(req.params.id);
  const fr = await FriendRequest.findById(id);
  if (!fr || fr.status !== "pending")
    return res.status(404).json({ error: { code: "REQUEST_NOT_FOUND" } });
  if (fr.toUserId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN" } });

  fr.status = "declined";
  await fr.save();
  return res.json({ ok: true });
}

/** DELETE /friends/requests/:id  (requester cancels their own pending request) */
export async function cancelFriendRequest(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const id = String(req.params.id);
  const fr = await FriendRequest.findById(id);
  if (!fr || fr.status !== "pending") {
    return res.status(404).json({ error: { code: "REQUEST_NOT_FOUND" } });
  }
  if (fr.fromUserId !== userId) {
    return res
      .status(403)
      .json({ error: { code: "FORBIDDEN", message: "Only requester can cancel" } });
  }
  fr.status = "canceled";
  await fr.save();
  return res.json({ ok: true });
}

/** DELETE /friends/:userId  (unfriend both ways) */
export async function unfriend(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const otherId = String(req.params.userId);
  const [a, b] = sortPair(userId, otherId);

  const r = await Friendship.deleteOne({ userA: a, userB: b });
  // Optional: clean up any stale pending requests between these two (any direction)
  await FriendRequest.deleteMany({
    $or: [
      { fromUserId: userId, toUserId: otherId, status: "pending" },
      { fromUserId: otherId, toUserId: userId, status: "pending" },
    ],
  });

  if (r.deletedCount === 0) {
    // Not friends; treat as idempotent “ok”
    return res.json({ ok: true, removed: false });
  }
  return res.json({ ok: true, removed: true });
}

export async function searchUsers(req: Request, res: Response) {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ items: [] });

  // very simple text search for now (email or name contains)
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const users = await (
    await import("../users/model.js")
  ).User.find({
    $or: [{ email: rx }, { firstName: rx }, { lastName: rx }],
  })
    .limit(25)
    .lean();

  return res.json({ items: users.map(pubUser) });
}

export async function getUserPublic(req: Request, res: Response) {
  const id = String(req.params.id);
  const u = await (await import("../users/model.js")).User.findById(id).lean();
  if (!u) return res.status(404).json({ error: { code: "NOT_FOUND" } });
  return res.json(pubUser(u));
}

/** Helper the booking routes can use to return 403 + ensure pending request */
export async function guardFriendshipOrEnsurePending(guestId: string, hostId: string) {
  if (await areFriends(guestId, hostId)) return null;
  const ensured = await ensurePendingRequest(guestId, hostId);
  return {
    code: "NOT_FRIENDS",
    requiresFriendship: true,
    relatedRequestId: "request" in ensured ? String(ensured.request?._id) : undefined,
  };
}
