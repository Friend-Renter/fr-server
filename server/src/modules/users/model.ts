import bcrypt from "bcrypt";
import mongoose, { Schema, type Model } from "mongoose";

import { env } from "../../config/env.js";

/** Roles for FR */
export type Role = "renter" | "host" | "admin";

/** KYC lifecycle */
export type KycStatus = "unverified" | "pending" | "verified" | "failed" | "rejected";

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

/** Postal address with optional geocode */
const AddressSchema = new Schema(
  {
    street1: { type: String },
    street2: { type: String },
    city: { type: String },
    state: { type: String },
    postalCode: { type: String },
    country: { type: String, default: "US" },
    /** Optional precise point for proximity queries */
    location: { type: GeoPointSchema, required: false },
  },
  { _id: false }
);

/** Payout provider (Stripe Connect stub for now) */
const PayoutSchema = new Schema(
  {
    provider: { type: String, enum: ["stripe"], default: "stripe" },
    stripe: {
      accountId: { type: String }, // acct_xxx
      onboarded: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

export interface UserDoc extends mongoose.Document {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  isEmailVerified: boolean;

  /** Security */
  passwordHash: string;

  /** Account flags */
  isActive: boolean;
  deactivatedAt: Date | null;

  /** New fields (C2-B) */
  kycStatus: KycStatus;
  kycUpdatedAt?: Date | null;
  defaultAddress?: {
    street1?: string;
    street2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    location?: { type: "Point"; coordinates: [number, number] }; // [lng, lat]
  };
  payout?: {
    provider: "stripe";
    stripe?: { accountId?: string; onboarded?: boolean };
  };

  /** Timestamps (from { timestamps: true }) */
  createdAt: Date;
  updatedAt: Date;

  /** Virtuals / methods */
  fullName: string;
  isCorrectPassword(password: string): Promise<boolean>;
}

const UserSchema = new Schema<UserDoc>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/.+@.+\..+/, "Must use a valid email address"],
    },
    firstName: { type: String, required: true, trim: true, maxlength: 50 },
    lastName: { type: String, required: true, trim: true, maxlength: 50 },
    role: { type: String, enum: ["renter", "host", "admin"], default: "renter" },
    isEmailVerified: { type: Boolean, default: false },

    passwordHash: { type: String, required: true, select: false },

    isActive: { type: Boolean, default: true },
    deactivatedAt: { type: Date, default: null },

    /** C2-B additions */
    // KYC
    kycStatus: {
      type: String,
      enum: ["unverified", "pending", "verified", "failed", "rejected"],
      default: "unverified",
    },
    kycUpdatedAt: { type: Date },
    defaultAddress: { type: AddressSchema, required: false },
    payout: { type: PayoutSchema, required: false },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** Virtual full name */
UserSchema.virtual("fullName").get(function (this: UserDoc) {
  return `${this.firstName} ${this.lastName}`.trim();
});

/** Write-only virtual for password: sets a private _password to be hashed */
UserSchema.virtual("password")
  .set(function (this: any, plain: string) {
    this._password = typeof plain === "string" ? plain : "";
  })
  .get(function () {
    return undefined;
  });

/** Hash before validation so required passwordHash passes */
UserSchema.pre("validate", async function (next) {
  const self = this as any;
  if (self._password) {
    if (self._password.length < 8) {
      return next(new Error("Password must be at least 8 characters"));
    }
    const rounds = env.BCRYPT_ROUNDS;
    self.passwordHash = await bcrypt.hash(self._password, rounds);
    self._password = undefined;
  }
  next();
});

/** Hash on findOneAndUpdate({ password }) */
UserSchema.pre("findOneAndUpdate", async function (next) {
  const update: any = this.getUpdate() || {};
  if (update.password) {
    update.passwordHash = await bcrypt.hash(update.password, env.BCRYPT_ROUNDS);
    delete update.password;
    this.setUpdate(update);
  }
  next();
});

/** Duplicate key friendly message */
UserSchema.post(
  "save",
  function (
    error: mongoose.CallbackError,
    _doc: any,
    next: (err?: mongoose.CallbackError) => void
  ) {
    if (
      (error as any)?.name === "MongoServerError" &&
      (error as any)?.code === 11000 &&
      (error as any)?.keyPattern?.email
    ) {
      next(Object.assign(new Error("Email already exists"), { code: "EMAIL_TAKEN" }));
    } else {
      next(error);
    }
  }
);

/** Methods */
UserSchema.methods.isCorrectPassword = async function (password: string) {
  return bcrypt.compare(password, this.passwordHash);
};

/** Indexes */
UserSchema.index({ "defaultAddress.location": "2dsphere" });
// at bottom of users/model.ts (near indexes)
UserSchema.index({ role: 1 });
UserSchema.index({ kycStatus: 1 });

export const User: Model<UserDoc> =
  mongoose.models.User || mongoose.model<UserDoc>("User", UserSchema);
