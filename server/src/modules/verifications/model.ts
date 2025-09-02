import mongoose, { Schema, type Model } from "mongoose";

export type KycStatus = "unverified" | "pending" | "verified" | "failed" | "rejected";

export interface VerificationDoc extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  provider: "persona";
  externalId: string; // provider's inquiry id
  status: KycStatus;
  events: Array<{
    type: string;
    at: Date;
    raw?: any;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema = new Schema(
  {
    type: { type: String, required: true },
    at: { type: Date, required: true },
    raw: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const VerificationSchema = new Schema<VerificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    provider: { type: String, enum: ["persona"], required: true },
    externalId: { type: String, required: true },
    status: {
      type: String,
      enum: ["unverified", "pending", "verified", "failed", "rejected"],
      required: true,
      index: true,
    },
    events: { type: [EventSchema], default: [] },
  },
  { timestamps: true }
);

// one row per provider inquiry id
VerificationSchema.index({ provider: 1, externalId: 1 }, { unique: true });
// admin filters
VerificationSchema.index({ userId: 1, createdAt: -1 });

export const Verification: Model<VerificationDoc> =
  mongoose.models.Verification ||
  mongoose.model<VerificationDoc>("Verification", VerificationSchema);
