import mongoose, { Schema, type Model } from "mongoose";

export interface FeatureFlagDoc extends mongoose.Document {
  key: string;
  enabled: boolean;
  notes?: string | null;
  updatedBy?: mongoose.Types.ObjectId | null;
  updatedAt?: Date;
  createdAt: Date;
}

const FeatureFlagSchema = new Schema<FeatureFlagDoc>(
  {
    key: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    notes: { type: String },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const FeatureFlag: Model<FeatureFlagDoc> =
  mongoose.models.FeatureFlag || mongoose.model<FeatureFlagDoc>("FeatureFlag", FeatureFlagSchema);
