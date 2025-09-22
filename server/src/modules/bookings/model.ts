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
// src/modules/bookings/model.ts
// (inside your PricingSnapshot sub-schema)
const PricingSnapshotSchema = new Schema(
  {
    currency: { type: String, required: true },
    totalCents: { type: Number, required: true },

    // C8 additions
    baseCents: { type: Number },
    feeCents: { type: Number },
    discountCents: { type: Number },
    taxCents: { type: Number },
    depositCents: { type: Number },
    promoCode: { type: String, default: null },
    lineItems: [
      {
        code: { type: String, enum: ["BASE", "FEE", "PROMO", "TAX"], required: true },
        label: { type: String, required: true },
        amountCents: { type: Number, required: true },
      },
    ],
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

/** Typed-but-flexible readings (strict:false keeps extra keys). */
const ReadingsSchema = new Schema(
  {
    odometer: { type: Number, min: 0 },
    odometerUnit: { type: String, enum: ["mi", "km"] },
    fuelPercent: { type: Number, min: 0, max: 100 },
    batteryPercent: { type: Number, min: 0, max: 100 },
    hoursMeter: { type: Number, min: 0 },
    rangeEstimate: { type: Number, min: 0 },
    cleanliness: { type: String, enum: ["poor", "fair", "good", "excellent"] },
    extras: { type: Schema.Types.Mixed },
  },
  { _id: false, strict: false }
);

const CheckpointSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: "User" },
    at: { type: Date },
    photos: { type: [PhotoSchema], default: [] },
    notes: { type: String, maxlength: 2000 },
    readings: { type: ReadingsSchema }, // typed but allows extra keys
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
  // inside BookingSchema definition:
  paymentRefs?: {
    rentalIntentId?: string;
    depositIntentId?: string;
    chargeId?: string;
    transferId?: string;
  };

  paymentStatus: "unpaid" | "requires_action" | "paid" | "refunded";

  checkin?: {
    by?: mongoose.Types.ObjectId;
    at?: Date;
    photos?: Array<{ url: string; key?: string; label?: string }>;
    notes?: string;
    readings?: {
      odometer?: number;
      odometerUnit?: "mi" | "km";
      fuelPercent?: number;
      batteryPercent?: number;
      hoursMeter?: number;
      rangeEstimate?: number;
      cleanliness?: "poor" | "fair" | "good" | "excellent";
      extras?: Record<string, unknown>;
      [k: string]: unknown;
    };
  };

  checkout?: {
    by?: mongoose.Types.ObjectId;
    at?: Date;
    photos?: Array<{ url: string; key?: string; label?: string }>;
    notes?: string;
    readings?: {
      odometer?: number;
      odometerUnit?: "mi" | "km";
      fuelPercent?: number;
      batteryPercent?: number;
      hoursMeter?: number;
      rangeEstimate?: number;
      cleanliness?: "poor" | "fair" | "good" | "excellent";
      extras?: Record<string, unknown>;
      [k: string]: unknown;
    };
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
    paymentStatus: {
      type: String,
      enum: ["unpaid", "requires_action", "paid", "refunded"],
      default: "unpaid",
      index: true,
    },

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
// Efficient role/state queries
BookingSchema.index({ renterId: 1, state: 1, start: 1 });
BookingSchema.index({ hostId: 1, state: 1, start: 1 });
// For availability/calendar views
BookingSchema.index({ listingId: 1, start: 1 });
// after BookingSchema is defined:
BookingSchema.index({ "paymentRefs.rentalIntentId": 1 }, { unique: true, sparse: true });

export const Booking: Model<BookingDoc> =
  mongoose.models.Booking || mongoose.model<BookingDoc>("Booking", BookingSchema);
