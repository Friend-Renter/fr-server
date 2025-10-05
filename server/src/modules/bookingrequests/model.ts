import mongoose, { Schema, Types } from "mongoose";

export type BookingRequestState = "request_pending" | "request_accepted" | "request_declined";

export interface BookingRequestDoc {
  _id: Types.ObjectId;
  renterId: Types.ObjectId;
  hostId: Types.ObjectId;
  listingId: Types.ObjectId;
  start: Date;
  end: Date;
  promoCode?: string | null;
  noteToHost?: string | null;
  state: BookingRequestState;
  createdAt: Date;
  updatedAt: Date;
}

const BookingRequestSchema = new Schema<BookingRequestDoc>(
  {
    renterId: { type: Schema.Types.ObjectId, required: true, index: true },
    hostId: { type: Schema.Types.ObjectId, required: true, index: true },
    listingId: { type: Schema.Types.ObjectId, required: true, index: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    promoCode: { type: String, default: null },
    noteToHost: { type: String, default: null },
    state: {
      type: String,
      enum: ["request_pending", "request_accepted", "request_declined"],
      default: "request_pending",
      index: true,
    },
  },
  { timestamps: true }
);

BookingRequestSchema.index({ hostId: 1, state: 1, createdAt: -1 });
BookingRequestSchema.index({ renterId: 1, state: 1, createdAt: -1 });

export const BookingRequest =
  mongoose.models.BookingRequest ||
  mongoose.model<BookingRequestDoc>("BookingRequest", BookingRequestSchema, "booking_requests");
