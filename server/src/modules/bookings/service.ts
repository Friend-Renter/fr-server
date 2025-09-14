// src/modules/bookings/service.ts
import crypto from "crypto";

import mongoose from "mongoose";


import { Booking, type BookingDoc } from "./model.js";
import { stripe } from "../../lib/stripe.js";
import { toUtcMidnight, enumerateBuckets } from "../../utils/dates.js";
import { Listing } from "../listings/model.js";
import { BookingLock } from "../locks/model.js";
import { lockBuckets, unlockBuckets, unlockByReason, retagLocks } from "../locks/service.js";

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
export async function buildBucketsAndGranularity(listing: any, start: Date, end: Date) {
  const category = await getCategory(listing);
  const granularity: Granularity = HOUR_CATS.has(category) ? "hour" : "day";
  const s = start.getTime();
  const e = end.getTime();
  const buckets = enumerateBuckets(s, e, granularity);
  return { granularity, buckets };
}

export function priceSnapshotByDays(listing: any, start: Date, end: Date) {
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

/** Create booking from a **succeeded** Stripe PaymentIntent (pay-first). */
export async function createBooking(args: { renterId: string; paymentIntentId: string }) {
  const { renterId, paymentIntentId } = args;

  // Load PI and validate
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  if (!pi || pi.object !== "payment_intent")
    throw Object.assign(new Error("Invalid paymentIntent"), { code: "INVALID_PI", status: 400 });
  if (pi.status !== "succeeded")
    throw Object.assign(new Error("Payment not completed"), {
      code: "PI_NOT_SUCCEEDED",
      status: 409,
    });

  const md: any = pi.metadata || {};
  const listingId = String(md.listingId || "");
  const startISO = String(md.startISO || "");
  const endISO = String(md.endISO || "");
  const snapshotTotalCents = Number(md.totalCents || 0);

  if (!mongoose.isValidObjectId(listingId)) {
    throw Object.assign(new Error("Invalid listingId in PI metadata"), { code: "INVALID_ID" });
  }
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (
    !(start instanceof Date) ||
    isNaN(start.getTime()) ||
    !(end instanceof Date) ||
    isNaN(end.getTime())
  ) {
    throw Object.assign(new Error("Invalid dates in PI metadata"), { code: "INVALID_WINDOW" });
  }
  if (end <= start) {
    throw Object.assign(new Error("end must be after start"), { code: "INVALID_WINDOW" });
  }
  if (String(md.renterId || "") !== renterId) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 });
  }

  // Load listing & recompute amount to defend against tampering
  const listing = await Listing.findById(listingId).lean();
  if (!listing || listing.status !== "active") {
    throw Object.assign(new Error("Listing not found"), { code: "LISTING_NOT_FOUND" });
  }
  const { granularity, buckets } = await buildBucketsAndGranularity(listing, start, end);
  const { pricingSnapshot } = priceSnapshotByDays(listing, start, end);

  if (pricingSnapshot.totalCents !== snapshotTotalCents || pi.amount !== snapshotTotalCents) {
    throw Object.assign(new Error("Amount mismatch"), { code: "AMOUNT_MISMATCH", status: 409 });
  }

  // Verify PI locks exist for all buckets
  const piReason = `pi:${pi.id}`;
  const locks = await BookingLock.find({
    listingId: listing._id,
    reason: piReason,
    dateBucket: { $in: buckets },
  }).lean();
  if (!locks || locks.length !== buckets.length) {
    await unlockByReason(String(listing._id), piReason).catch(() => {});
    throw Object.assign(new Error("Requested window is unavailable"), {
      code: "UNAVAILABLE",
      status: 409,
    });
  }

  // Create booking; rely on unique index to prevent duplicates per PI
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
    paymentRefs: {
      rentalIntentId: pi.id,
      chargeId:
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge?.id ?? undefined),
    },
    paymentStatus: "paid",
  } as Partial<BookingDoc>);

  // Retag locks from "pi:<id>" -> "booking:<bid>" and clear TTL
  await retagLocks(String(listing._id), piReason, `booking:${doc._id.toString()}`);

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

/** Host declines a pending booking → declined (unlock + refund). */
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

  if (b.paymentStatus === "paid" && b.paymentRefs?.chargeId) {
    try {
      await stripe.refunds.create({ charge: b.paymentRefs.chargeId });
      b.paymentStatus = "refunded";
    } catch {
      // log if you want
    }
  }

  await unlockBuckets(String(b.listingId), buckets);
  b.state = "declined";
  await b.save();
  return b;
}

/** Renter cancels a pending booking → cancelled (unlock + refund). */
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

  if (b.paymentStatus === "paid" && b.paymentRefs?.chargeId) {
    try {
      await stripe.refunds.create({ charge: b.paymentRefs.chargeId });
      b.paymentStatus = "refunded";
    } catch {
      // log if you want
    }
  }

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
