import mongoose, { Schema, type Model } from "mongoose";

import type { Category, AssetStatus } from "../../domain/index.js";

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

/** Media item metadata (S3/CloudFront later) */
const MediaItemSchema = new Schema(
  {
    url: { type: String, required: true },
    key: { type: String }, // S3 object key (optional)
    width: { type: Number },
    height: { type: Number },
    label: { type: String }, // e.g., "front", "interior"
  },
  { _id: false }
);

export interface AssetDoc extends mongoose.Document {
  hostId: mongoose.Types.ObjectId; // User._id
  category: Category; // car|boat|...
  title: string;
  description?: string;
  media: Array<{
    url: string;
    key?: string;
    width?: number;
    height?: number;
    label?: string;
  }>;
  /** Flexible specs blob (varies by category), e.g., { make, model, year } */
  specs?: Record<string, any>;
  /** Optional precise location for search */
  location?: { type: "Point"; coordinates: [number, number] }; // [lng, lat]
  status: AssetStatus; // pending|active|suspended|archived
  /** Lightweight internal verification (separate from Persona) */
  verification?: { status: "unverified" | "verified" | "rejected"; notes?: string };

  // timestamps
  createdAt: Date;
  updatedAt: Date;
}

const AssetSchema = new Schema<AssetDoc>(
  {
    hostId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    category: {
      type: String,
      required: true,
      enum: ["car", "boat", "jetski", "electronics", "lawn", "misc"],
    },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 4000 },
    media: { type: [MediaItemSchema], default: [] },
    specs: { type: Schema.Types.Mixed }, // deliberately flexible
    location: { type: GeoPointSchema, required: false },
    status: {
      type: String,
      enum: ["pending", "active", "suspended", "archived"],
      default: "pending",
    },
    verification: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: ["unverified", "verified", "rejected"],
            default: "unverified",
          },
          notes: { type: String },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** Compound/category status index for common moderation filters */
AssetSchema.index({ category: 1, status: 1 });
/** Geospatial search */
AssetSchema.index({ location: "2dsphere" });

export const Asset: Model<AssetDoc> =
  mongoose.models.Asset || mongoose.model<AssetDoc>("Asset", AssetSchema);
