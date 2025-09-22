import mongoose, { Schema, type Model } from "mongoose";

import type { CancellationPolicy, ListingStatus } from "../../domain/index.js";

/** GeoJSON Point (WGS84). Store as [lng, lat]. */
const GeoPointSchema = new Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point", required: true },
    coordinates: {
      type: [Number], // [lng, lat]
      validate: {
        validator: (v: number[]) => Array.isArray(v) && v.length === 2,
        message: "coordinates must be [lng, lat]",
      },
      required: true,
    },
  },
  { _id: false }
);

/** Minimal location for taxation + future geo */
const ListingLocationSchema = new Schema(
  {
    point: { type: GeoPointSchema, required: false }, // optional; may mirror asset.location
    state: {
      type: String,
      minlength: 2,
      maxlength: 2,
      uppercase: true,
      trim: true,
      required: false, // required only when status is 'active' (see pre-validate)
    },
  },
  { _id: false }
);

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

  /** Minimal location for taxes + geo */
  location?: {
    point?: { type: "Point"; coordinates: [number, number] }; // [lng, lat]
    state?: string; // "TX", "NE", ...
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

    /** NEW: location */
    location: { type: ListingLocationSchema, required: false },

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

/** Validation: require at least one base price (daily or hourly) and state for active listings */
ListingSchema.pre("validate", function (next) {
  const doc = this as ListingDoc;

  const p = doc.pricing || ({} as ListingDoc["pricing"]);
  if (p.baseDailyCents == null && p.baseHourlyCents == null) {
    return next(new Error("pricing.baseDailyCents or pricing.baseHourlyCents is required"));
  }

  if (doc.status === "active") {
    const state = doc.location?.state?.toUpperCase?.();
    if (!state || state.length !== 2) {
      return next(new Error("location.state (2-letter) is required for active listings"));
    }
    // normalize to uppercase
    doc.location = { ...(doc.location || {}), state };
  }

  next();
});

// --- Option A: default listing.location.point from asset on CREATE only ---
ListingSchema.pre("save", async function (next) {
  const doc = this as ListingDoc & { isNew: boolean };

  // Only on initial create; never re-sync later
  if (!doc.isNew) return next();

  // If a point is already provided, respect it
  if (doc.location?.point) return next();

  try {
    // Pull asset.location (GeoJSON Point) directly from the collection
    const col = mongoose.connection.db?.collection("assets");
    if (!col) return next();

    const raw = await col.findOne({ _id: doc.assetId }, { projection: { location: 1 } });

    const point = (raw as any)?.location;
    if (
      point &&
      point.type === "Point" &&
      Array.isArray(point.coordinates) &&
      point.coordinates.length === 2
    ) {
      doc.location = { ...(doc.location || {}), point };
    }

    return next();
  } catch (err) {
    return next(err as any);
  }
});

/** Helpful compound for host moderation views */
ListingSchema.index({ hostId: 1, status: 1 });
/** Geospatial search (future) */
ListingSchema.index({ "location.point": "2dsphere" });

export const Listing: Model<ListingDoc> =
  mongoose.models.Listing || mongoose.model<ListingDoc>("Listing", ListingSchema);
