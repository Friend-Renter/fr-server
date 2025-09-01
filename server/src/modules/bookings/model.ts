import mongoose, { Schema, type Model } from "mongoose";

/** Narrow type aliases kept local (we can move to /domain later) */
export type BookingState =
  | "draft"
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "in_progress"
  | "completed";

export type Granularity = "hour" | "day";

/** Optional line item breakdown (all cents). */
const LineItemSchema = new Schema(
  {
    code: { type: String, required: true }, // e.g., "BASE", "FEE", "TAX"
    label: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/** Immutable pricing snapshot at time of booking/quote. */
const PricingSnapshotSchema = new Schema(
  {
    currency: { type: String, default: "USD" },
    baseCents: { type: Number, required: true, min: 0 },
    feeCents: { type: Number, default: 0, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    depositCents: { type: Number, default: 0, min: 0 },
    totalCents: { type: Number, required: true, min: 0 },
    lineItems: { type: [LineItemSchema], default: [] },
  },
  { _id: false }
);

const PhotoSchema = new Schema(
  {
    url: { type: String, required: true },
    key: { type: String },
  },
  { _id: false }
);

const CheckpointSchema = new Schema(
  {
    at: { type: Date },
    photos: { type: [PhotoSchema], default: [] },
    notes: { type: String },
    readings: { type: Schema.Types.Mixed }, // e.g., odometer, fuel, etc.
  },
  { _id: false }
);

const LockRefSchema = new Schema(
  {
    lockId: { type: Schema.Types.ObjectId, ref: "BookingLock", required: true },
    dateBucket: { type: String, required: true },
  },
  { _id: false }
);

const PaymentRefsSchema = new Schema(
  {
    rentalIntentId: { type: String },
    depositIntentId: { type: String },
    chargeId: { type: String },
    transferId: { type: String },
  },
  { _id: false }
);

export interface BookingDoc extends mongoose.Document {
  listingId: mongoose.Types.ObjectId;
  assetId: mongoose.Types.ObjectId;
  hostId: mongoose.Types.ObjectId;
  renterId: mongoose.Types.ObjectId;

  start: Date;
  end: Date;
  granularity: Granularity;

  pricingSnapshot: {
    currency: string;
    baseCents: number;
    feeCents: number;
    taxCents: number;
    depositCents: number;
    totalCents: number;
    lineItems: Array<{ code: string; label: string; amountCents: number }>;
  };

  state: BookingState;

  locks?: Array<{ lockId: mongoose.Types.ObjectId; dateBucket: string }>;
  paymentRefs?: {
    rentalIntentId?: string;
    depositIntentId?: string;
    chargeId?: string;
    transferId?: string;
  };

  checkin?: {
    at?: Date;
    photos?: Array<{ url: string; key?: string }>;
    notes?: string;
    readings?: Record<string, unknown>;
  };

  checkout?: {
    at?: Date;
    photos?: Array<{ url: string; key?: string }>;
    notes?: string;
    readings?: Record<string, unknown>;
  };

  createdAt: Date;
  updatedAt: Date;
}

const BookingSchema = new Schema<BookingDoc>(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    assetId: { type: Schema.Types.ObjectId, ref: "Asset", required: true },
    hostId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    renterId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    start: { type: Date, required: true },
    end: { type: Date, required: true },
    granularity: { type: String, enum: ["hour", "day"], required: true },

    pricingSnapshot: { type: PricingSnapshotSchema, required: true },

    state: {
      type: String,
      enum: ["draft", "pending", "accepted", "declined", "cancelled", "in_progress", "completed"],
      default: "pending",
      index: true,
    },

    locks: { type: [LockRefSchema], default: [] },
    paymentRefs: { type: PaymentRefsSchema, required: false },

    checkin: { type: CheckpointSchema, required: false },
    checkout: { type: CheckpointSchema, required: false },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** Basic time validation */
BookingSchema.pre("validate", function (next) {
  const self = this as BookingDoc;
  if (self.start >= self.end) {
    return next(new Error("end must be after start"));
  }
  if (self.pricingSnapshot && self.pricingSnapshot.totalCents < 0) {
    return next(new Error("pricingSnapshot.totalCents must be >= 0"));
  }
  next();
});

/** Range + dashboards */
BookingSchema.index({ listingId: 1, start: 1, end: 1 });
BookingSchema.index({ hostId: 1, state: 1 });
BookingSchema.index({ renterId: 1, state: 1 });

export const Booking: Model<BookingDoc> =
  mongoose.models.Booking || mongoose.model<BookingDoc>("Booking", BookingSchema);
