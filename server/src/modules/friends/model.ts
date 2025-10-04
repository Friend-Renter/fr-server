import mongoose, { Schema, Model } from "mongoose";

export type FriendRequestStatus = "pending" | "accepted" | "declined" | "canceled";

export interface FriendRequestDoc extends mongoose.Document {
  fromUserId: string;
  toUserId: string;
  status: FriendRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

const FriendRequestSchema = new Schema<FriendRequestDoc>(
  {
    fromUserId: { type: String, required: true, index: true },
    toUserId: { type: String, required: true, index: true },
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
  userA: string; // lexicographically smaller id
  userB: string; // lexicographically larger id
  createdAt: Date;
}

const FriendshipSchema = new Schema<FriendshipDoc>(
  {
    userA: { type: String, required: true, index: true },
    userB: { type: String, required: true, index: true },
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
