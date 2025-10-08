import mongoose, { Schema, type Model } from "mongoose";

export type DevicePlatform = "ios" | "android";

export interface DeviceTokenDoc extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  platform: DevicePlatform;
  token: string;
  apnsEnv?: "dev" | "prod";
  createdAt: Date;
  updatedAt: Date;
}

const DeviceTokenSchema = new Schema<DeviceTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    platform: { type: String, enum: ["ios", "android"], required: true },
    token: { type: String, required: true, unique: true },
    apnsEnv: { type: String, enum: ["dev", "prod"], default: "dev" },
  },
  { timestamps: true }
);

DeviceTokenSchema.index({ userId: 1, platform: 1 });

export const DeviceToken: Model<DeviceTokenDoc> =
  mongoose.models.DeviceToken || mongoose.model<DeviceTokenDoc>("DeviceToken", DeviceTokenSchema);
