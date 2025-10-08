import mongoose, { Schema, type Model } from "mongoose";

export type NotificationType =
  | "friend.request_created"
  | "friend.request_accepted"
  | "booking.request_created"
  | "booking.request_accepted"
  | "booking.request_declined";

export interface NotificationDoc extends mongoose.Document {
  userId: mongoose.Types.ObjectId; // recipient
  type: NotificationType;
  actor?: { id: string; name?: string; avatarUrl?: string } | null;
  context?: {
    requestId?: string;
    bookingRequestId?: string;
    bookingId?: string;
    listingId?: string;
    listingTitle?: string;
  } | null;
  createdAt: Date;
  readAt?: Date | null;
  uniqKey?: string | null; // optional dedupe key
}

const NotificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    type: { type: String, required: true },
    actor: {
      id: String,
      name: String,
      avatarUrl: String,
    },
    context: {
      requestId: String,
      bookingRequestId: String,
      bookingId: String,
      listingId: String,
      listingTitle: String,
    },
    readAt: { type: Date, default: null },
    uniqKey: { type: String, default: null, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });

export const Notification: Model<NotificationDoc> =
  mongoose.models.Notification ||
  mongoose.model<NotificationDoc>("Notification", NotificationSchema);
