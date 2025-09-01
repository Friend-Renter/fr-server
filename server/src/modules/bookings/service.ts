import mongoose from "mongoose";

import { Booking, type BookingDoc, type Granularity, type BookingState } from "./model.js";
import { connectMongo } from "../../config/db.js";
import { Listing } from "../listings/model.js";

export type PricingSnapshot = {
  currency?: string;
  baseCents: number;
  feeCents?: number;
  taxCents?: number;
  depositCents?: number;
  totalCents: number;
  lineItems?: Array<{ code: string; label: string; amountCents: number }>;
};

export type CreateBookingInput = {
  listingId: string;
  renterId: string;
  start: Date | string | number; // ISO or ms ok
  end: Date | string | number;
  granularity: Granularity;
  pricingSnapshot: PricingSnapshot;
  instant?: boolean; // if true => state "accepted"
  locks?: Array<{ lockId: string; dateBucket: string }>;
};

export async function createBookingPending(input: CreateBookingInput): Promise<BookingDoc> {
  await connectMongo();

  const listing = await Listing.findById(input.listingId).lean();
  if (!listing) {
    throw Object.assign(new Error("Listing not found"), { code: "LISTING_NOT_FOUND" });
  }

  const doc = new Booking({
    listingId: new mongoose.Types.ObjectId(input.listingId),
    assetId: new mongoose.Types.ObjectId(String((listing as any).assetId)),
    hostId: new mongoose.Types.ObjectId(String((listing as any).hostId)),
    renterId: new mongoose.Types.ObjectId(input.renterId),

    start: new Date(input.start),
    end: new Date(input.end),
    granularity: input.granularity,

    pricingSnapshot: {
      currency: input.pricingSnapshot.currency ?? "USD",
      baseCents: input.pricingSnapshot.baseCents,
      feeCents: input.pricingSnapshot.feeCents ?? 0,
      taxCents: input.pricingSnapshot.taxCents ?? 0,
      depositCents: input.pricingSnapshot.depositCents ?? 0,
      totalCents: input.pricingSnapshot.totalCents,
      lineItems: input.pricingSnapshot.lineItems ?? [],
    },

    state: input.instant ? ("accepted" as BookingState) : ("pending" as BookingState),

    locks: (input.locks ?? []).map((l) => ({
      lockId: new mongoose.Types.ObjectId(l.lockId),
      dateBucket: l.dateBucket,
    })),
  } as Partial<BookingDoc>);

  await doc.save();
  return doc;
}

export async function findBookingById(id: string): Promise<BookingDoc | null> {
  await connectMongo();
  return Booking.findById(id).exec();
}

export async function getBookingsByRole(
  userId: string,
  role: "host" | "renter",
  state?: BookingState
): Promise<BookingDoc[]> {
  await connectMongo();
  const q: any =
    role === "host"
      ? { hostId: new mongoose.Types.ObjectId(userId) }
      : { renterId: new mongoose.Types.ObjectId(userId) };
  if (state) q.state = state;
  return Booking.find(q).sort({ createdAt: -1 }).exec();
}

export async function cancelBooking(id: string, actorId: string): Promise<BookingDoc | null> {
  await connectMongo();
  // For now, simple transition. Unlocking handled in C7.
  return Booking.findByIdAndUpdate(
    id,
    { $set: { state: "cancelled" as BookingState } },
    { new: true }
  ).exec();
}

/** Public shape for API responses */
export function toPublicBooking(b: BookingDoc) {
  return {
    id: b.id,
    listingId: b.listingId.toString(),
    assetId: b.assetId.toString(),
    hostId: b.hostId.toString(),
    renterId: b.renterId.toString(),
    start: b.start,
    end: b.end,
    granularity: b.granularity,
    pricingSnapshot: b.pricingSnapshot,
    state: b.state,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}
