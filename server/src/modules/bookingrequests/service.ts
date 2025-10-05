import { Types } from "mongoose";

import { BookingRequest } from "./model.js";
import { guardFriendshipOrEnsurePending } from "../friends/controller.js";
// NOTE: adjust these imports to your actual friends controller if different:
import { acceptFriendRequestById } from "../friends/service.js"; // <-- if not exported, see comment below
import { Listing } from "../listings/model.js";
import { User } from "../users/model.js";

type Id = string | Types.ObjectId;
type View = "host" | "renter";
type State = "all" | "pending" | "accepted" | "declined";

function toStateFilter(state: State) {
  if (state === "all") return {};
  if (state === "pending") return { state: "request_pending" };
  if (state === "accepted") return { state: "request_accepted" };
  return { state: "request_declined" };
}

// Cursor = base64("{createdAt}:{_id}")
function encodeCursor(doc: { createdAt: Date; _id: Types.ObjectId }) {
  return Buffer.from(`${doc.createdAt.toISOString()}:${doc._id.toString()}`).toString("base64");
}
function decodeCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, "base64").toString("utf8").split(":");
    return { createdAt: new Date(iso), _id: new Types.ObjectId(id) };
  } catch {
    return null;
  }
}

export async function listBookingRequests(params: {
  me: string;
  view: View;
  state: State;
  limit: number;
  cursor?: string;
}) {
  const { me, view, state, limit, cursor } = params;

  const base: any = view === "host" ? { hostId: me } : { renterId: me };
  Object.assign(base, toStateFilter(state));

  const c = decodeCursor(cursor);
  if (c) {
    base.$or = [
      { createdAt: { $lt: c.createdAt } },
      { createdAt: c.createdAt, _id: { $lt: c._id } },
    ];
  }

  const docs = await BookingRequest.find(base)
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.max(1, Math.min(100, limit)))
    .lean();

  // hydrate small user/listing projections for cards
  const userIds = new Set<string>();
  const listingIds = new Set<string>();
  docs.forEach((d) => {
    userIds.add(String(d.renterId));
    userIds.add(String(d.hostId));
    listingIds.add(String(d.listingId));
  });

  const [users, listings] = await Promise.all([
    User.find(
      { _id: { $in: Array.from(userIds).map((id) => new Types.ObjectId(id)) } },
      { fullName: 1, firstName: 1, lastName: 1, avatarUrl: 1 }
    ).lean(),
    Listing.find(
      { _id: { $in: Array.from(listingIds).map((id) => new Types.ObjectId(id)) } },
      { _id: 1, title: 1, photos: 1 }
    ).lean(),
  ]);

  const userMap = new Map<string, any>(users.map((u) => [String(u._id), u]));
  const listingMap = new Map<string, any>(listings.map((l) => [String(l._id), l]));

  const items = docs.map((d) => {
    const renter = userMap.get(String(d.renterId));
    const host = userMap.get(String(d.hostId));
    const listing = listingMap.get(String(d.listingId));
    const toName = (u: any) =>
      u?.fullName || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "User";
    const photo =
      Array.isArray(listing?.photos) && listing.photos.length ? listing.photos[0] : null;

    return {
      id: String(d._id),
      state: d.state,
      createdAt: d.createdAt,
      start: d.start || null,
      end: d.end || null,
      renter: {
        id: String(d.renterId),
        name: toName(renter),
        avatarUrl: renter?.avatarUrl || null,
      },
      host: { id: String(d.hostId), name: toName(host), avatarUrl: host?.avatarUrl || null },
      listing: { id: String(d.listingId), title: listing?.title || "Listing", photo },
    };
  });

  const nextCursor = docs.length ? encodeCursor(docs[docs.length - 1]) : null;
  return { items, nextCursor };
}

export async function bookingRequestCounts(me: string) {
  const [
    hostAll,
    hostPending,
    hostAccepted,
    hostDeclined,
    renterAll,
    renterPending,
    renterAccepted,
    renterDeclined,
  ] = await Promise.all([
    BookingRequest.countDocuments({ hostId: me }),
    BookingRequest.countDocuments({ hostId: me, state: "request_pending" }),
    BookingRequest.countDocuments({ hostId: me, state: "request_accepted" }),
    BookingRequest.countDocuments({ hostId: me, state: "request_declined" }),
    BookingRequest.countDocuments({ renterId: me }),
    BookingRequest.countDocuments({ renterId: me, state: "request_pending" }),
    BookingRequest.countDocuments({ renterId: me, state: "request_accepted" }),
    BookingRequest.countDocuments({ renterId: me, state: "request_declined" }),
  ]);

  return {
    host: { all: hostAll, pending: hostPending, accepted: hostAccepted, declined: hostDeclined },
    renter: {
      all: renterAll,
      pending: renterPending,
      accepted: renterAccepted,
      declined: renterDeclined,
    },
  };
}

export async function createBookingRequest(params: {
  renterId: Id;
  listingId: Id;
  start: Date;
  end: Date;
  promoCode?: string | null;
  noteToHost?: string | null;
}) {
  const { renterId, listingId, start, end, promoCode, noteToHost } = params;

  const listing = await Listing.findById(listingId, { hostId: 1, status: 1 }).lean();
  if (!listing || listing.status !== "active") {
    const err: any = new Error("LISTING_NOT_FOUND");
    err.code = "LISTING_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  const hostId = String(listing.hostId);

  // Ensure/locate friendship (but do NOT block booking request creation)
  const guard = await guardFriendshipOrEnsurePending(String(renterId), hostId);
  // guard is either null (already friends) or an object like:
  // { code: 'FRIENDSHIP_REQUIRED', relatedRequestId, direction, otherUser }

  const doc = await BookingRequest.create({
    renterId,
    hostId,
    listingId,
    start,
    end,
    promoCode: promoCode ?? null,
    noteToHost: noteToHost ?? null,
    state: "request_pending",
  });

  return {
    doc,
    friendship: guard
      ? {
          areFriends: false,
          direction: guard.direction || "none",
          relatedRequestId: guard.relatedRequestId || null,
        }
      : { areFriends: true, direction: null, relatedRequestId: null },
  };
}

export async function acceptBookingRequest(params: {
  hostId: Id;
  requestId: Id;
  friendRequestId?: string | null; // pass when host wants combo-accept in one click
}) {
  const { hostId, requestId, friendRequestId } = params;

  const br = await BookingRequest.findById(requestId);
  if (!br) {
    const err: any = new Error("NOT_FOUND");
    err.code = "NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (String(br.hostId) !== String(hostId)) {
    const err: any = new Error("FORBIDDEN");
    err.code = "FORBIDDEN";
    err.status = 403;
    throw err;
  }
  if (br.state !== "request_pending") {
    return br; // idempotent
  }

  // --- Combo Accept: accept the friend request if provided ---
  // If your friends controller doesn't export accept-by-id, replace this block with
  // a local helper that accepts by id or accepts pairwise (renterId->hostId).
  if (friendRequestId) {
    try {
      await acceptFriendRequestById(String(hostId), String(friendRequestId));
    } catch (e) {
      // if it fails because already accepted, that's fine; otherwise let it bubble if you prefer strictness
    }
  }

  br.state = "request_accepted";
  await br.save();

  return br;
}

export async function declineBookingRequest(params: { hostId: Id; requestId: Id }) {
  const { hostId, requestId } = params;

  const br = await BookingRequest.findById(requestId);
  if (!br) {
    const err: any = new Error("NOT_FOUND");
    err.code = "NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (String(br.hostId) !== String(hostId)) {
    const err: any = new Error("FORBIDDEN");
    err.code = "FORBIDDEN";
    err.status = 403;
    throw err;
  }
  if (br.state !== "request_pending") {
    return br; // idempotent
  }

  br.state = "request_declined";
  await br.save();

  return br;
}
