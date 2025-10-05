import type { Request, Response } from "express";
import mongoose from "mongoose"; // 👈 add this

import { sortPair, FriendRequest, Friendship } from "./model.js";
import { areFriends, ensurePendingRequest, acceptRequest } from "./service.js";
import { getAuth } from "../../middlewares/auth.js";
import { notify } from "../notifications/service.js";
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

// 👇 helper: keep only valid objectIds and convert to ObjectId instances
function toObjectIds(ids: string[]): mongoose.Types.ObjectId[] {
  return ids
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

export async function listFriends(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const status = String(req.query.status || "accepted");

  if (status === "accepted") {
    const docs = await Friendship.find({ $or: [{ userA: userId }, { userB: userId }] }).lean();
    const otherIds = docs.map((d) => (d.userA === userId ? d.userB : d.userA));
    const valid = toObjectIds(otherIds);
    const users = valid.length ? await User.find({ _id: { $in: valid } }).lean() : [];
    const map = new Map(users.map((u) => [String(u._id), u]));
    return res.json({ items: otherIds.map((id) => ({ user: pubUser(map.get(id)) })) });
  }

  if (status === "incoming") {
    const docs = await FriendRequest.find({ toUserId: userId, status: "pending" }).lean();
    const fromIds = docs.map((d) => d.fromUserId);
    const valid = toObjectIds(fromIds);
    const users = valid.length ? await User.find({ _id: { $in: valid } }).lean() : [];
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
    const toIds = docs.map((d) => d.toUserId);
    const valid = toObjectIds(toIds);
    const users = valid.length ? await User.find({ _id: { $in: valid } }).lean() : [];
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
  const toUserId = String(req.body?.toUserId || "").trim();

  // Basic validation
  if (!toUserId) {
    return res.status(422).json({
      error: {
        code: "VALIDATION",
        details: [{ path: ["toUserId"], message: "toUserId is required" }],
      },
    });
  }
  if (toUserId === userId) {
    return res
      .status(422)
      .json({ error: { code: "INVALID_SELF", message: "Cannot friend yourself" } });
  }

  // Only allow requests to real users with valid ObjectIds
  if (!mongoose.isValidObjectId(toUserId)) {
    return res.status(422).json({ error: { code: "INVALID_USER_ID", message: "Invalid user id" } });
  }
  const exists = await User.exists({ _id: new mongoose.Types.ObjectId(toUserId) });
  if (!exists) {
    return res.status(404).json({ error: { code: "USER_NOT_FOUND" } });
  }

  // Idempotent ensure
  const ensured = await ensurePendingRequest(userId, toUserId);
  if ("alreadyFriends" in ensured && ensured.alreadyFriends) {
    return res.json({ alreadyFriends: true });
  }

  // NOTE: ensurePendingRequest now returns { request, wasNew }
  const statusCode = ensured.wasNew ? 201 : 200;
  res.status(statusCode).json({
    request: {
      id: String(ensured.request!._id),
      fromUserId: userId,
      toUserId,
      status: "pending",
    },
  });

  // Fire-and-forget notification (best-effort)
  (async () => {
    try {
      const actor = await User.findById(userId, { fullName: 1 }).lean();
      await notify({
        userId: toUserId,
        type: "friend.request_created",
        actor: { id: userId, name: actor?.fullName },
        context: { requestId: String(ensured.request!._id) },
        uniqKey: `friend.request_created:${ensured.request!._id}`,
      });
    } catch {
      // swallow
    }
  })();
}

export async function acceptFriendRequest(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const id = String(req.params.id);
  const fr = await FriendRequest.findById(id);
  if (!fr || fr.status !== "pending")
    return res.status(404).json({ error: { code: "REQUEST_NOT_FOUND" } });
  if (fr.toUserId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN" } });

  await acceptRequest(fr);
  // notify original requester
  (async () => {
    try {
      const actor = await User.findById(userId, { fullName: 1 }).lean();
      await notify({
        userId: fr.fromUserId,
        type: "friend.request_accepted",
        actor: { id: userId, name: actor?.fullName },
        context: { requestId: String(fr._id) },
        uniqKey: `friend.request_accepted:${fr._id}`,
      });
    } catch (e) {}
  })();

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

export async function searchUsers(req: Request, res: Response) {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ items: [] });

  const { userId: me } = getAuth(req);
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const users = await (
    await import("../users/model.js")
  ).User.find({
    _id: { $ne: new mongoose.Types.ObjectId(me) }, // 👈 exclude me safely
    $or: [{ email: rx }, { firstName: rx }, { lastName: rx }],
  })
    .limit(25)
    .lean();

  return res.json({ items: users.map(pubUser) });
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

export async function getUserPublic(req: Request, res: Response) {
  const id = String(req.params.id);
  // 👇 Harden: 404 on invalid ObjectId instead of throwing CastError
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ error: { code: "NOT_FOUND" } });
  }
  const u = await (await import("../users/model.js")).User.findById(id).lean();
  if (!u) return res.status(404).json({ error: { code: "NOT_FOUND" } });
  return res.json(pubUser(u));
}

type FriendshipGuard = null | {
  code: "FRIENDSHIP_REQUIRED";
  relatedRequestId?: string;
  direction: "incoming" | "outgoing" | "none";
  otherUser: { id: string; name?: string };
};

export async function guardFriendshipOrEnsurePending(
  guestId: string,
  hostId: string
): Promise<FriendshipGuard> {
  if (await areFriends(guestId, hostId)) return null;

  // 1) Find existing pending as a Document (no .lean())
  let pending = await FriendRequest.findOne({
    status: "pending",
    $or: [
      { fromUserId: guestId, toUserId: hostId },
      { fromUserId: hostId, toUserId: guestId },
    ],
  });

  // 2) Ensure/create (guest -> host) if none; also a Document
  if (!pending) {
    const ensured = await ensurePendingRequest(guestId, hostId);
    if ("request" in ensured && ensured.request) {
      pending = ensured.request; // still a Document
    }
  }

  let direction: "incoming" | "outgoing" | "none" = "none";
  let relatedRequestId: string | undefined;

  if (pending) {
    relatedRequestId = String(pending._id);
    direction = pending.fromUserId === guestId ? "outgoing" : "incoming";
  }

  const host = await User.findById(hostId, { fullName: 1, firstName: 1, lastName: 1 }).lean();
  const hostName =
    host?.fullName || [host?.firstName, host?.lastName].filter(Boolean).join(" ") || undefined;

  return {
    code: "FRIENDSHIP_REQUIRED",
    relatedRequestId,
    direction,
    otherUser: { id: hostId, name: hostName },
  };
}

export async function statusWith(req: Request, res: Response) {
  const me = getAuth(req).userId;
  const other = String(req.params.otherId);

  // already friends?
  const friends = await areFriends(me, other);
  if (friends) return res.json({ areFriends: true });

  // any pending?
  const pending = await FriendRequest.findOne({
    status: "pending",
    $or: [
      { fromUserId: me, toUserId: other },
      { fromUserId: other, toUserId: me },
    ],
  }).lean();

  if (!pending) return res.json({ areFriends: false, pending: null });

  const direction = pending.fromUserId === me ? "outgoing" : "incoming";
  return res.json({
    areFriends: false,
    pending: { id: String(pending._id), direction },
  });
}

export async function counts(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const [incoming, outgoing, accepted] = await Promise.all([
    FriendRequest.countDocuments({ toUserId: userId, status: "pending" }),
    FriendRequest.countDocuments({ fromUserId: userId, status: "pending" }),
    Friendship.countDocuments({ $or: [{ userA: userId }, { userB: userId }] }),
  ]);
  res.json({ incoming, outgoing, accepted });
}
