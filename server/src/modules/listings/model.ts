import mongoose, { Schema, type Model } from "mongoose";

import type { CancellationPolicy, ListingStatus } from "../../domain/index.js";

/** Pricing (all integer cents). Either daily or hourly must be provided. */
const PricingSchema = new Schema(
  {
    baseDailyCents: { type: Number, min: 0 }, // e.g., 4500 => $45.00/day
    baseHourlyCents: { type: Number, min: 0 }, // e.g., 900  => $9.00/hour
    minHours: { type: Number, min: 1, default: 1 },
    depositCents: { type: Number, min: 0, default: 0 },
    feeCents: { type: Number, min: 0, default: 0 }, // platform/cleaning/etc.
  },
  { _id: false }
);

/** Blackout range (UTC). Excluded from availability. */
const BlackoutSchema = new Schema(
  {
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    reason: { type: String },
  },
  { _id: false }
);

export interface ListingDoc extends mongoose.Document {
  assetId: mongoose.Types.ObjectId; // Asset._id
  hostId: mongoose.Types.ObjectId; // denormalized from Asset for fast queries

  pricing: {
    baseDailyCents?: number;
    baseHourlyCents?: number;
    minHours: number;
    depositCents: number;
    feeCents: number;
  };

  instantBook: boolean;
  blackouts: Array<{ start: Date; end: Date; reason?: string }>;
  cancellationPolicy: CancellationPolicy;
  status: ListingStatus;
  moderationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ListingSchema = new Schema<ListingDoc>(
  {
    assetId: { type: Schema.Types.ObjectId, ref: "Asset", required: true, index: true },
    hostId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    pricing: { type: PricingSchema, required: true },

    instantBook: { type: Boolean, default: false },
    blackouts: { type: [BlackoutSchema], default: [] },

    cancellationPolicy: {
      type: String,
      enum: ["flexible", "moderate", "strict"],
      default: "moderate",
    },
    moderationReason: { type: String },
    status: {
      type: String,
      enum: ["draft", "active", "suspended", "archived"],
      default: "draft",
      index: true,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** Validation: require at least one base price (daily or hourly) */
ListingSchema.pre("validate", function (next) {
  const p = (this as ListingDoc).pricing || ({} as ListingDoc["pricing"]);
  if (p.baseDailyCents == null && p.baseHourlyCents == null) {
    return next(new Error("pricing.baseDailyCents or pricing.baseHourlyCents is required"));
  }
  next();
});

/** Helpful compound for host moderation views */
ListingSchema.index({ hostId: 1, status: 1 });

export const Listing: Model<ListingDoc> =
  mongoose.models.Listing || mongoose.model<ListingDoc>("Listing", ListingSchema);
