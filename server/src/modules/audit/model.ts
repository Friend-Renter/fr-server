import mongoose, { Schema, type Model } from "mongoose";

type Target =
  | { type: "user"; id: mongoose.Types.ObjectId }
  | { type: "listing"; id: mongoose.Types.ObjectId }
  | { type: "feature"; key: string };

export interface AuditLogDoc extends mongoose.Document {
  actorId: mongoose.Types.ObjectId;
  action: string;
  target?: Target;
  diff?: any;
  at: Date;
}

const AuditLogSchema = new Schema<AuditLogDoc>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    action: { type: String, required: true, index: true },
    target: { type: Schema.Types.Mixed },
    diff: { type: Schema.Types.Mixed },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false }
);

export const AuditLog: Model<AuditLogDoc> =
  mongoose.models.AuditLog || mongoose.model<AuditLogDoc>("AuditLog", AuditLogSchema);
