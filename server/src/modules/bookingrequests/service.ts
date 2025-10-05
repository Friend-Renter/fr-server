import { Types } from "mongoose";

import { BookingRequest } from "./model.js";
import { guardFriendshipOrEnsurePending } from "../friends/controller.js";
// NOTE: adjust these imports to your actual friends controller if different:
import { acceptFriendRequestById } from "../friends/service.js"; // <-- if not exported, see comment below
import { Listing } from "../listings/model.js";

type Id = string | Types.ObjectId;

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
