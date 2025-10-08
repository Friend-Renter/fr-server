import mongoose, { Schema, Model } from "mongoose";

export type FriendRequestStatus = "pending" | "accepted" | "declined" | "canceled";

export interface FriendRequestDoc extends mongoose.Document {
  fromUserId: mongoose.Types.ObjectId;
  toUserId: mongoose.Types.ObjectId;
  status: FriendRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

const FriendRequestSchema = new Schema<FriendRequestDoc>(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    toUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "canceled"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true }
);

/** Ensure only one pending request per pair/direction */
FriendRequestSchema.index(
  { fromUserId: 1, toUserId: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

export const FriendRequest: Model<FriendRequestDoc> =
  mongoose.models.FriendRequest ||
  mongoose.model<FriendRequestDoc>("FriendRequest", FriendRequestSchema);

export interface FriendshipDoc extends mongoose.Document {
  userA: mongoose.Types.ObjectId;
  userB: mongoose.Types.ObjectId;
  createdAt: Date;
}

const FriendshipSchema = new Schema<FriendshipDoc>(
  {
    userA: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userB: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/** Unique undirected friendship */
FriendshipSchema.index({ userA: 1, userB: 1 }, { unique: true });

export const Friendship: Model<FriendshipDoc> =
  mongoose.models.Friendship || mongoose.model<FriendshipDoc>("Friendship", FriendshipSchema);

/** Utility to sort a pair consistently */
export function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
