import { FriendRequest, Friendship, sortPair, type FriendRequestDoc } from "./model.js";

/** Are two users already friends? */
export async function areFriends(u1: string, u2: string) {
  const [userA, userB] = sortPair(u1, u2);
  const found = await Friendship.findOne({ userA, userB }).lean();
  return !!found;
}

/** Ensure a pending request exists from `from` to `to`. Return the doc. (Idempotent) */
export async function ensurePendingRequest(from: string, to: string) {
  if (from === to)
    throw Object.assign(new Error("Cannot friend yourself"), { code: "INVALID_SELF" });

  // If already friends, short-circuit
  if (await areFriends(from, to)) {
    return { alreadyFriends: true as const };
  }

  // If an existing pending (any direction) exists, return it
  const existing = await FriendRequest.findOne({
    $or: [
      { fromUserId: from, toUserId: to, status: "pending" },
      { fromUserId: to, toUserId: from, status: "pending" },
    ],
  });
  if (existing) return { request: existing };

  // Create new pending from -> to
  const created = await FriendRequest.create({ fromUserId: from, toUserId: to, status: "pending" });
  return { request: created };
}

/** Accept a request (toUserId must be me). Also create Friendship idempotently. */
export async function acceptRequest(reqDoc: FriendRequestDoc) {
  if (reqDoc.status !== "pending") return reqDoc;

  reqDoc.status = "accepted";
  await reqDoc.save();

  const [userA, userB] = sortPair(reqDoc.fromUserId, reqDoc.toUserId);
  try {
    await Friendship.updateOne(
      { userA, userB },
      { $setOnInsert: { userA, userB } },
      { upsert: true }
    );
  } catch {
    /* ignore duplicate */
  }

  // Optionally clean up opposite pending if any
  await FriendRequest.deleteMany({
    $or: [
      { fromUserId: reqDoc.fromUserId, toUserId: reqDoc.toUserId, status: "pending" },
      { fromUserId: reqDoc.toUserId, toUserId: reqDoc.fromUserId, status: "pending" },
    ],
    _id: { $ne: reqDoc._id },
  });

  return reqDoc;
}

function httpError(status: number, code: string, message?: string) {
  const err: any = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

export async function acceptFriendRequestById(actorId: string, requestId: string) {
  const fr = await FriendRequest.findById(requestId);
  if (!fr || fr.status !== "pending") throw httpError(404, "REQUEST_NOT_FOUND");
  if (fr.toUserId !== actorId) throw httpError(403, "FORBIDDEN");
  await acceptRequest(fr);
  return fr;
}
