import mongoose from "mongoose";

import { BookingLock, type BookingLockDoc } from "./model.js";
import { connectMongo } from "../../config/db.js";

export type LockBucketsInput = {
  listingId: string;
  buckets: string[]; // strings like "YYYY-MM-DDTHH" or "YYYY-MM-DD"
  granularity: "hour" | "day";
  createdBy?: string; // userId
  reason?: string;
  holdUntil?: Date; // set for PI-held locks (TTL)
  /**
   * When booking within a transaction later:
   *   pass the session so lock + booking can be atomic.
   */
  session?: mongoose.ClientSession | null;
};

/** Try to write all locks. If any exists -> throw code "LOCK_CONFLICT". */
export async function lockBuckets(input: LockBucketsInput): Promise<BookingLockDoc[]> {
  await connectMongo();

  const docs = input.buckets.map((b) => ({
    listingId: new mongoose.Types.ObjectId(input.listingId),
    dateBucket: b,
    granularity: input.granularity,
    createdBy: input.createdBy ? new mongoose.Types.ObjectId(input.createdBy) : undefined,
    reason: input.reason,
    holdUntil: input.holdUntil,
  }));

  try {
    const created = await BookingLock.insertMany(docs, {
      ordered: true,
      session: input.session ?? undefined,
    });
    return created;
  } catch (err: any) {
    // Duplicate key => at least one bucket is already locked
    // MongoServerError: code 11000
    if (err?.code === 11000 || err?.name === "MongoBulkWriteError") {
      const e = new Error("One or more buckets are already locked");
      (e as any).code = "LOCK_CONFLICT";
      throw e;
    }
    throw err;
  }
}

/** Remove specific buckets for a listing (used on cancel/failure). */
export async function unlockBuckets(
  listingId: string,
  buckets: string[],
  session?: mongoose.ClientSession | null
): Promise<number> {
  await connectMongo();
  const res = await BookingLock.deleteMany(
    {
      listingId: new mongoose.Types.ObjectId(listingId),
      dateBucket: { $in: buckets },
    },
    { session: session ?? undefined } as any
  );
  return res.deletedCount ?? 0;
}

/** Utility: check if any of the buckets are already locked. */
export async function anyLocked(listingId: string, buckets: string[]): Promise<boolean> {
  await connectMongo();
  const count = await BookingLock.countDocuments({
    listingId: new mongoose.Types.ObjectId(listingId),
    dateBucket: { $in: buckets },
  }).exec();
  return count > 0;
}

/** Remove locks by an exact reason (e.g., "pi:<id>" or "booking:<id>"). */
export async function unlockByReason(listingId: string, reason: string): Promise<number> {
  await connectMongo();
  const res = await BookingLock.deleteMany({
    listingId: new mongoose.Types.ObjectId(listingId),
    reason,
  });
  return res.deletedCount ?? 0;
}

/** Retag existing locks (e.g., from "pi:<piId>" to "booking:<bookingId>") and clear TTL. */
export async function retagLocks(
  listingId: string,
  fromReason: string,
  toReason: string
): Promise<number> {
  await connectMongo();
  const res = await BookingLock.updateMany(
    { listingId: new mongoose.Types.ObjectId(listingId), reason: fromReason },
    { $set: { reason: toReason }, $unset: { holdUntil: "" } }
  );
  return res.modifiedCount ?? 0;
}
