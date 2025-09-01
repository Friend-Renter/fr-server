import mongoose, { Schema, type Model } from "mongoose";

/**
 * BookingLock
 * - One row per (listingId, dateBucket)
 * - dateBucket is a string bucket:
 *    * hour: "YYYY-MM-DDTHH" (e.g., "2025-09-01T06")
 *    * day:  "YYYY-MM-DD"    (e.g., "2025-09-01")
 */
export interface BookingLockDoc extends mongoose.Document {
  listingId: mongoose.Types.ObjectId;
  dateBucket: string; // hour/day bucket string
  granularity: "hour" | "day"; // matches bucket type
  createdBy?: mongoose.Types.ObjectId; // userId who initiated (optional)
  reason?: string; // "quote" | "booking" | etc.

  createdAt: Date;
  updatedAt: Date;
}

const BookingLockSchema = new Schema<BookingLockDoc>(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    dateBucket: { type: String, required: true, trim: true },
    granularity: { type: String, enum: ["hour", "day"], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    reason: { type: String },
  },
  { timestamps: true }
);

/** Prevent double-booking a bucket for a listing */
BookingLockSchema.index({ listingId: 1, dateBucket: 1 }, { unique: true });

/** Helpful for scanning locks across time */
BookingLockSchema.index({ dateBucket: 1 });

export const BookingLock: Model<BookingLockDoc> =
  mongoose.models.BookingLock || mongoose.model<BookingLockDoc>("BookingLock", BookingLockSchema);
