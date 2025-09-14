// src/modules/bookings/service.ts
import mongoose from "mongoose";

import { Booking, type BookingDoc } from "./model.js";
import { toUtcMidnight, enumerateBuckets } from "../../utils/dates.js";
import { Listing } from "../listings/model.js";
import { BookingLock } from "../locks/model.js";
import { lockBuckets, unlockBuckets } from "../locks/service.js";

type Granularity = "hour" | "day";
const HOUR_CATS = new Set(["car", "boat", "jetski"]);

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

function buildBucketsFromBooking(b: BookingDoc): string[] {
  const s = b.granularity === "hour" ? b.start.getTime() : toUtcMidnight(b.start).getTime();
  const e = b.granularity === "hour" ? b.end.getTime() : toUtcMidnight(b.end).getTime();
  return enumerateBuckets(s, e, b.granularity);
}

async function getCategory(listing: any): Promise<string> {
  if (!mongoose.connection.db) throw new Error("DB not ready");
  const asset = await mongoose.connection.db
    .collection("assets")
    .findOne({ _id: listing.assetId }, { projection: { category: 1 } });
  return asset?.category || "misc";
}

// Decide granularity using pricing OR asset category
async function resolveGranularity(listing: any): Promise<Granularity> {
  if (listing?.pricing?.baseHourlyCents) return "hour";

  // fetch asset category to infer hourly categories
  if (!mongoose.connection.db) throw new Error("DB not ready");
  const asset = await mongoose.connection.db
    .collection("assets")
    .findOne({ _id: listing.assetId }, { projection: { category: 1 } });

  return HOUR_CATS.has(asset?.category) ? "hour" : "day";
}

// Build buckets after we know the granularity
async function buildBucketsAndGranularity(listing: any, start: Date, end: Date) {
  const category = await getCategory(listing);
  const granularity: Granularity = HOUR_CATS.has(category) ? "hour" : "day";
  const s = start.getTime();
  const e = end.getTime();
  const buckets = enumerateBuckets(s, e, granularity);
  return { granularity, buckets };
}

function priceSnapshotByDays(listing: any, start: Date, end: Date) {
  const p = listing?.pricing || {};
  const feeCents = p.feeCents ?? 0;
  const depositCents = p.depositCents ?? 0;
  const taxCents = 0;

  const daily =
    (p.baseDailyCents as number | undefined) ??
    ((p.baseHourlyCents as number | undefined) ?? 0) * 24;
  if (!daily)
    throw Object.assign(new Error("Missing daily/hourly pricing"), { code: "NO_PRICING" });

  const durationMs = end.getTime() - start.getTime();
  const billableDays = Math.max(1, Math.ceil(durationMs / (24 * 3600 * 1000)));

  const baseCents = billableDays * daily;
  const totalCents = baseCents + feeCents + taxCents;

  return {
    nUnits: billableDays, // you can keep hours here if you prefer, but days is clearer for billing
    pricingSnapshot: { baseCents, feeCents, depositCents, taxCents, totalCents },
  };
}

async function assertAvailable(
  listing: any,
  start: Date,
  end: Date,
  granularity: Granularity,
  buckets: string[]
) {
  if (!buckets.length) {
    throw Object.assign(new Error("Empty or invalid time window"), { code: "INVALID_WINDOW" });
  }

  // Locks conflict?
  const lockDocs = await BookingLock.find(
    { listingId: listing._id, dateBucket: { $in: buckets } },
    { dateBucket: 1, _id: 0 }
  ).lean();

  // Blackouts conflict?
  const blackoutHits =
    (listing.blackouts || []).filter((b: any) =>
      overlaps(start, end, new Date(b.start), new Date(b.end))
    ) || [];

  if (lockDocs.length || blackoutHits.length) {
    const err: any = new Error("Requested window is unavailable");
    err.code = "UNAVAILABLE";
    err.conflictBuckets = lockDocs.map((d) => d.dateBucket);
    err.conflictBlackouts = blackoutHits.map((b: any) => ({
      start: b.start,
      end: b.end,
      reason: b.reason,
    }));
    throw err;
  }
}

/** Create booking (pending or confirmed if instantBook). Locks are acquired; on failure we roll back the booking. */
export async function createBooking(args: {
  renterId: string;
  listingId: string;
  start: Date;
  end: Date;
  // optional knobs for later (protection plan, promoCode, etc.)
}) {
  const { renterId, listingId, start, end } = args;

  if (!mongoose.isValidObjectId(listingId)) {
    throw Object.assign(new Error("Invalid listingId"), { code: "INVALID_ID" });
  }
  if (end <= start) {
    throw Object.assign(new Error("end must be after start"), { code: "INVALID_WINDOW" });
  }
  // Limit absurdly large range (31d)
  if (end.getTime() - start.getTime() > 31 * 24 * 3600 * 1000) {
    throw Object.assign(new Error("range too large"), { code: "INVALID_WINDOW" });
  }

  const listing = await Listing.findById(listingId).lean();
  if (!listing || listing.status !== "active") {
    throw Object.assign(new Error("Listing not found"), { code: "LISTING_NOT_FOUND" });
  }

  const { granularity, buckets } = await buildBucketsAndGranularity(listing, start, end);
  await assertAvailable(listing, start, end, granularity, buckets);

  const { nUnits, pricingSnapshot } = priceSnapshotByDays(listing, start, end);

  // Create booking doc first to have an id for the lock reason.
  const doc = await Booking.create({
    renterId: new mongoose.Types.ObjectId(renterId),
    hostId: listing.hostId,
    listingId: listing._id,
    assetId: listing.assetId,
    start,
    end,
    granularity,
    pricingSnapshot,
    state: listing.instantBook ? "accepted" : "pending",
  } as Partial<BookingDoc>);

  try {
    await lockBuckets({
      listingId: String(listing._id),
      buckets,
      granularity,
      reason: `booking:${doc._id.toString()}`,
    });
  } catch (e: any) {
    // On lock conflict, delete the just-created booking to avoid orphaned docs.
    await Booking.deleteOne({ _id: doc._id }).catch(() => {});
    if (e?.code === "LOCK_CONFLICT") {
      const err: any = new Error("Requested window is unavailable");
      err.code = "UNAVAILABLE";
      throw err;
    }
    throw e;
  }

  return doc;
}

/** Host accepts a pending booking → confirmed (keeps locks). */
export async function acceptBooking(hostId: string, bookingId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw Object.assign(new Error("Invalid booking id"), { code: "INVALID_ID" });
  }
  const b = await Booking.findById(bookingId);
  if (!b) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (String(b.hostId) !== hostId)
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 });
  if (b.state !== "pending")
    throw Object.assign(new Error("Invalid state"), { code: "INVALID_STATE", status: 409 });

  b.state = "accepted";
  await b.save();
  return b;
}

/** Host declines a pending booking → declined (unlock buckets). */
export async function declineBooking(hostId: string, bookingId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw Object.assign(new Error("Invalid booking id"), { code: "INVALID_ID" });
  }
  const b = await Booking.findById(bookingId);
  if (!b) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (String(b.hostId) !== hostId)
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 });
  if (b.state !== "pending")
    throw Object.assign(new Error("Invalid state"), { code: "INVALID_STATE", status: 409 });

  const buckets = buildBucketsFromBooking(b);
  await unlockBuckets(String(b.listingId), buckets);
  b.state = "declined";
  await b.save();
  return b;
}

/** Renter cancels a pending booking → cancelled (unlock buckets). */
export async function cancelPendingBooking(renterId: string, bookingId: string) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw Object.assign(new Error("Invalid booking id"), { code: "INVALID_ID" });
  }
  const b = await Booking.findById(bookingId);
  if (!b) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (String(b.renterId) !== renterId)
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 });
  if (b.state !== "pending")
    throw Object.assign(new Error("Invalid state"), { code: "INVALID_STATE", status: 409 });

  const buckets = buildBucketsFromBooking(b);
  await unlockBuckets(String(b.listingId), buckets);
  b.state = "cancelled";
  await b.save();
  return b;
}

/** List bookings by role/state with simple pagination */
// src/modules/bookings/service.ts
export async function listBookings(opts: {
  userId: string;
  role: "renter" | "host";
  state?: "draft" | "pending" | "accepted" | "declined" | "cancelled" | "in_progress" | "completed"; // <-- match your schema words
  page?: number;
  limit?: number;
}) {
  const { userId, role, state, page = 1, limit = 20 } = opts;

  const q: any =
    role === "renter"
      ? { renterId: new mongoose.Types.ObjectId(userId) }
      : { hostId: new mongoose.Types.ObjectId(userId) };
  if (state) q.state = state;

  const raw = await Booking.find(q)
    .sort({ start: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const items = raw.map((b: any) => ({
    id: String(b._id),
    state: b.state,
    start: b.start,
    end: b.end,
    granularity: b.granularity,
    listingId: String(b.listingId),
    renterId: String(b.renterId),
    hostId: String(b.hostId),
    pricingSnapshot: b.pricingSnapshot,
  }));

  return { page, limit, items, hasMore: raw.length === limit };
}
