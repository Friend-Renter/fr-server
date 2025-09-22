// src/modules/bookings/service.ts
import crypto from "crypto";

import mongoose from "mongoose";

import { Booking, type BookingDoc } from "./model.js";
import { logger } from "../../config/logger.js";
import { stripe } from "../../lib/stripe.js";
import { toUtcMidnight, enumerateBuckets } from "../../utils/dates.js";
import { writeAudit } from "../audit/service.js";
import { Listing } from "../listings/model.js";
import { BookingLock } from "../locks/model.js";
import { unlockBuckets, unlockByReason, retagLocks } from "../locks/service.js";
import { computeQuote } from "../pricing/calc.js"; // <-- C8

type Granularity = "hour" | "day";
const HOUR_CATS = new Set(["car", "boat", "jetski"]);

// --- C7: types for check-in/out ---
type ReadingInput = {
  odometer?: number;
  odometerUnit?: "mi" | "km";
  fuelPercent?: number;
  batteryPercent?: number;
  hoursMeter?: number;
  rangeEstimate?: number;
  cleanliness?: "poor" | "fair" | "good" | "excellent";
  extras?: Record<string, unknown>;
  [k: string]: unknown; // allow future keys
};

type PhotoInput = { url: string; key?: string; label?: string };

type CheckpointInput = {
  photos?: PhotoInput[];
  notes?: string;
  readings?: ReadingInput;
};

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

// --- C7: helpers ---
const CDN_DOMAIN = process.env.CDN_DOMAIN;
const S3_PUBLIC_HOST =
  process.env.S3_PUBLIC_HOST || process.env.ASSETS_PUBLIC_HOST || process.env.S3_BUCKET_HOST;

function isHttpOrHttps(u: string) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function photoUrlAllowed(u: string) {
  try {
    const parsed = new URL(u);
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) return false;
    if (CDN_DOMAIN) return parsed.host === CDN_DOMAIN;
    if (S3_PUBLIC_HOST) return parsed.host === S3_PUBLIC_HOST;
    return true;
  } catch {
    return false;
  }
}

function logTransition(kind: "checkin" | "checkout", b: BookingDoc, actorId: string) {
  logger.info(`booking.${kind}`, {
    bookingId: String(b._id),
    actorId,
    state: b.state,
    at: new Date().toISOString(),
  });
}

function validateCheckpointInput(input: CheckpointInput) {
  if (input.notes !== undefined) {
    if (typeof input.notes !== "string") {
      const e: any = new Error("notes must be a string.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    if (input.notes.length > 2000) {
      const e: any = new Error("notes must be ≤ 2000 characters.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
  }

  if (!input || (!input.photos && !input.notes && !input.readings)) {
    const err: any = new Error("Provide at least one of photos|notes|readings.");
    err.code = "INVALID_BODY";
    err.status = 422;
    throw err;
  }

  if (input.photos) {
    if (!Array.isArray(input.photos)) {
      const e: any = new Error("photos must be an array.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    if (input.photos.length > 20) {
      const e: any = new Error("Maximum 20 photos per checkpoint.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    for (const p of input.photos) {
      if (!p?.url || !isHttpOrHttps(p.url) || !photoUrlAllowed(p.url)) {
        const e: any = new Error("Photo URL must be http/https and from an allowed host.");
        e.code = "INVALID_BODY";
        e.status = 422;
        throw e;
      }
      if (p.key && typeof p.key !== "string") {
        const e: any = new Error("Photo key must be a string when provided.");
        e.code = "INVALID_BODY";
        e.status = 422;
        throw e;
      }
      if (p.label && typeof p.label !== "string") {
        const e: any = new Error("Photo label must be a string when provided.");
        e.code = "INVALID_BODY";
        e.status = 422;
        throw e;
      }
    }
  }

  const r = input.readings;
  if (r) {
    const num = (v: unknown) => (typeof v === "number" && !Number.isNaN(v) ? v : undefined);

    if (r.odometer !== undefined && (num(r.odometer) ?? -1) < 0) {
      const e: any = new Error("odometer must be >= 0.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    if (r.odometerUnit && r.odometerUnit !== "mi" && r.odometerUnit !== "km") {
      const e: any = new Error('odometerUnit must be "mi" or "km".');
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    if (r.fuelPercent !== undefined) {
      const v = num(r.fuelPercent);
      if (v === undefined || v < 0 || v > 100) {
        const e: any = new Error("fuelPercent must be between 0 and 100.");
        e.code = "INVALID_BODY";
        e.status = 422;
        throw e;
      }
    }
    if (r.batteryPercent !== undefined) {
      const v = num(r.batteryPercent);
      if (v === undefined || v < 0 || v > 100) {
        const e: any = new Error("batteryPercent must be between 0 and 100.");
        e.code = "INVALID_BODY";
        e.status = 422;
        throw e;
      }
    }
    if (r.hoursMeter !== undefined && (num(r.hoursMeter) ?? -1) < 0) {
      const e: any = new Error("hoursMeter must be >= 0.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    if (r.rangeEstimate !== undefined && (num(r.rangeEstimate) ?? -1) < 0) {
      const e: any = new Error("rangeEstimate must be >= 0.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
    if (r.cleanliness && !["poor", "fair", "good", "excellent"].includes(String(r.cleanliness))) {
      const e: any = new Error("cleanliness must be one of poor|fair|good|excellent.");
      e.code = "INVALID_BODY";
      e.status = 422;
      throw e;
    }
  }
}

function isParticipant(b: BookingDoc, actorId: string) {
  return String(b.hostId) === actorId || String(b.renterId) === actorId;
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

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  if (!pi || pi.object !== "payment_intent") {
    throw Object.assign(new Error("Invalid paymentIntent"), { code: "INVALID_PI", status: 400 });
  }
  if (pi.status !== "succeeded") {
    throw Object.assign(new Error("Payment not completed"), {
      code: "PI_NOT_SUCCEEDED",
      status: 409,
    });
  }

  const md: any = pi.metadata || {};
  const listingId = String(md.listingId || "");
  const startISO = String(md.startISO || "");
  const endISO = String(md.endISO || "");
  const snapshotTotalCents = Number(md.totalCents || 0);
  const promoCode = (md.promoCode ? String(md.promoCode) : null) as string | null;

  if (!mongoose.isValidObjectId(listingId)) {
    throw Object.assign(new Error("Invalid listingId in PI metadata"), { code: "INVALID_ID" });
  }
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    throw Object.assign(new Error("Invalid dates in PI metadata"), { code: "INVALID_WINDOW" });
  }
  if (String(md.renterId || "") !== renterId) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 });
  }

  // Load listing twice: lean for availability, doc for calc typing
  const listingLean = await Listing.findById(listingId).lean();
  if (!listingLean || listingLean.status !== "active") {
    throw Object.assign(new Error("Listing not found"), { code: "LISTING_NOT_FOUND" });
  }
  const { granularity, buckets } = await buildBucketsAndGranularity(listingLean, start, end);

  const listingDoc = await Listing.findById(listingId); // doc for calc (has getters/types)
  const quote = await computeQuote({ listing: listingDoc as any, start, end, promoCode });

  if (quote.totalCents !== snapshotTotalCents || pi.amount !== snapshotTotalCents) {
    throw Object.assign(new Error("Amount mismatch"), { code: "AMOUNT_MISMATCH", status: 409 });
  }

  // Verify PI locks exist for all buckets
  const piReason = `pi:${pi.id}`;
  const locks = await BookingLock.find({
    listingId: listingLean._id,
    reason: piReason,
    dateBucket: { $in: buckets },
  }).lean();
  if (!locks || locks.length !== buckets.length) {
    await unlockByReason(String(listingLean._id), piReason).catch(() => {});
    throw Object.assign(new Error("Requested window is unavailable"), {
      code: "UNAVAILABLE",
      status: 409,
    });
  }

  // Use real ObjectIds — do NOT pass FlattenMaps from lean docs
  const doc = await Booking.create({
    renterId: new mongoose.Types.ObjectId(renterId),
    hostId: listingLean.hostId as mongoose.Types.ObjectId,
    listingId: new mongoose.Types.ObjectId(listingId),
    assetId: new mongoose.Types.ObjectId(String(listingLean.assetId)),
    start,
    end,
    granularity,
    pricingSnapshot: {
      currency: quote.currency,
      totalCents: quote.totalCents,
      baseCents: quote.baseCents,
      feeCents: quote.feeCents,
      discountCents: quote.discountCents,
      taxCents: quote.taxCents,
      depositCents: quote.depositCents,
      promoCode,
      lineItems: quote.lineItems,
    },
    state: (listingLean as any).instantBook ? "accepted" : "pending",
    paymentRefs: {
      rentalIntentId: pi.id,
      chargeId:
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge?.id ?? undefined),
    },
    paymentStatus: "paid",
  });

  await retagLocks(String(listingLean._id), piReason, `booking:${doc._id.toString()}`);
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

// --- C7: Check-in ---
export async function checkIn(actorId: string, bookingId: string, input: CheckpointInput) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw Object.assign(new Error("Invalid booking id"), { code: "INVALID_ID" });
  }
  validateCheckpointInput(input);

  const b = await Booking.findById(bookingId);
  if (!b) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (!isParticipant(b, actorId)) {
    throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  }
  if (b.checkin?.at) return b; // idempotent

  if (b.state !== "accepted") {
    throw Object.assign(new Error("Check-in allowed only when accepted."), {
      code: "INVALID_STATE",
      status: 409,
    });
  }
  if (b.paymentStatus !== "paid") {
    throw Object.assign(new Error("Check-in requires a paid booking."), {
      code: "INVALID_STATE",
      status: 409,
    });
  }

  const now = Date.now();
  const start = new Date(b.start).getTime();
  const end = new Date(b.end).getTime(); // inclusive
  if (!(now >= start && now <= end)) {
    throw Object.assign(new Error("Check-in allowed from start through end (inclusive)."), {
      code: "INVALID_WINDOW",
      status: 422,
    });
  }

  const update = {
    $set: {
      state: "in_progress",
      checkin: {
        by: new mongoose.Types.ObjectId(actorId),
        at: new Date(),
        photos: input.photos ?? [],
        notes: input.notes,
        readings: input.readings,
      },
      updatedAt: new Date(),
    },
  };

  const updated =
    (await Booking.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(bookingId),
        state: "accepted",
        "checkin.at": { $exists: false },
      },
      update,
      { new: true }
    )) || (await Booking.findById(bookingId));

  if (!updated) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (!isParticipant(updated, actorId)) {
    throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  }

  // best-effort audit
  void writeAudit({
    actorId: new mongoose.Types.ObjectId(actorId),
    action: "booking.checkin",
    target: { type: "user", id: updated.renterId },
    diff: {
      bookingId: updated._id,
      stateFrom: "accepted",
      stateTo: updated.state,
      checkinAt: updated.checkin?.at,
    },
  } as any);

  logTransition("checkin", updated, actorId);
  return updated;
}

// --- C7: Check-out ---
export async function checkOut(actorId: string, bookingId: string, input: CheckpointInput) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw Object.assign(new Error("Invalid booking id"), { code: "INVALID_ID" });
  }
  validateCheckpointInput(input);

  const b = await Booking.findById(bookingId);
  if (!b) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (!isParticipant(b, actorId)) {
    throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  }
  if (b.checkout?.at) return b; // idempotent

  if (b.state !== "in_progress") {
    throw Object.assign(new Error("Check-out allowed only when in_progress."), {
      code: "INVALID_STATE",
      status: 409,
    });
  }
  if (!b.checkin?.at) {
    throw Object.assign(new Error("Check-out not allowed before check-in."), {
      code: "INVALID_STATE",
      status: 409,
    });
  }

  const now = Date.now();
  const windowStart = new Date(b.checkin.at).getTime();
  const windowEnd = new Date(b.end).getTime() + 12 * 60 * 60 * 1000; // +12h
  if (!(now >= windowStart && now <= windowEnd)) {
    throw Object.assign(
      new Error("Check-out allowed from check-in time through end + 12h (inclusive)."),
      { code: "INVALID_WINDOW", status: 422 }
    );
  }

  const update = {
    $set: {
      state: "completed",
      checkout: {
        by: new mongoose.Types.ObjectId(actorId),
        at: new Date(),
        photos: input.photos ?? [],
        notes: input.notes,
        readings: input.readings,
      },
      updatedAt: new Date(),
    },
  };

  const updated =
    (await Booking.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(bookingId),
        state: "in_progress",
        "checkout.at": { $exists: false },
      },
      update,
      { new: true }
    )) || (await Booking.findById(bookingId));

  if (!updated) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  if (!isParticipant(updated, actorId)) {
    throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });
  }

  // best-effort audit
  void writeAudit({
    actorId: new mongoose.Types.ObjectId(actorId),
    action: "booking.checkout",
    target: { type: "user", id: updated.renterId },
    diff: {
      bookingId: updated._id,
      stateFrom: "in_progress",
      stateTo: updated.state,
      checkoutAt: updated.checkout?.at,
    },
  } as any);

  logTransition("checkout", updated, actorId);
  return updated;
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
