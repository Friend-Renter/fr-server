/** Users model (TS/ESM) — virtual `password`, hooks, instance methods, familiar to your style */
import bcrypt from "bcrypt";
import mongoose, { Schema, type Model, type HydratedDocument } from "mongoose";

import { env } from "../../config/env.js";

export type Role = "renter" | "host" | "admin";

export interface User {
  firstName?: string;
  lastName?: string;
  email: string;
  isEmailVerified: boolean;
  passwordHash: string; // stored (never expose)
  role: Role;
  isActive: boolean;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserMethods {
  /** Virtual getter is exposed as doc.get('fullName'); this method is a convenience */
  getFullName(): string;
  isCorrectPassword(password: string): Promise<boolean>;
  deactivate(): Promise<UserDoc>;
  reactivate(): Promise<UserDoc>;
}

export type UserDoc = HydratedDocument<User, UserMethods>;
export type UserModel = Model<User, {}, UserMethods>;

const UserSchema = new Schema<User, UserModel, UserMethods>(
  {
    firstName: { type: String, trim: true, maxlength: 50 },
    lastName: { type: String, trim: true, maxlength: 50 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/.+@.+\..+/, "Must use a valid email address"],
      index: true,
    },
    isEmailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false }, // hidden by default
    role: { type: String, enum: ["renter", "host", "admin"], default: "renter", index: true },
    isActive: { type: Boolean, default: true },
    deactivatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete (ret as any).passwordHash;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/** Virtual: fullName */
UserSchema.virtual("fullName").get(function (this: UserDoc) {
  const fn = this.firstName?.trim() || "";
  const ln = this.lastName?.trim() || "";
  return [fn, ln].filter(Boolean).join(" ");
});

/** Virtual (write-only): password -> sets a private _password */
UserSchema.virtual("password")
  .set(function (this: any, plain: string) {
    this._password = typeof plain === "string" ? plain : "";
  })
  .get(function () {
    return undefined;
  });

/** Instance methods */
UserSchema.method("getFullName", function getFullName(this: UserDoc) {
  return this.get("fullName");
});
UserSchema.method(
  "isCorrectPassword",
  async function isCorrectPassword(this: UserDoc, password: string) {
    // passwordHash may be excluded unless explicitly selected
    const hash = (this as any).passwordHash as string | undefined;
    if (!hash) {
      const err = new Error("passwordHash not selected on document");
      (err as any).code = "PASSWORD_HASH_NOT_SELECTED";
      throw err;
    }
    if (!hash) {
      const err = new Error("passwordHash not selected on document");
      (err as any).code = "PASSWORD_HASH_NOT_SELECTED";
      throw err;
    }
    return bcrypt.compare(password, hash);
  }
);
UserSchema.method("deactivate", async function deactivate(this: UserDoc) {
  this.isActive = false;
  this.deactivatedAt = new Date();
  return this.save();
});
UserSchema.method("reactivate", async function reactivate(this: UserDoc) {
  this.isActive = true;
  this.deactivatedAt = null;
  return this.save();
});

/** Pre-save: hash when virtual `password` is set */
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

/** Pre-findOneAndUpdate: support updating `password` (virtual) */
UserSchema.pre("findOneAndUpdate", async function (next) {
  const update: any = this.getUpdate() || {};
  const pwd = update.password ?? update.$set?.password ?? update.$setOnInsert?.password;

  if (pwd) {
    if (typeof pwd !== "string" || pwd.length < 8) {
      return next(new Error("Password must be at least 8 characters"));
    }
    const rounds = env.BCRYPT_ROUNDS;
    const hash = await bcrypt.hash(pwd, rounds);

    // Clean virtual from update; set passwordHash instead
    if (update.password) delete update.password;
    if (update.$set?.password) delete update.$set.password;
    if (update.$setOnInsert?.password) delete update.$setOnInsert.password;

    update.$set = { ...(update.$set || {}), passwordHash: hash };
    this.setUpdate(update);
  }
  next();
});

/** Duplicate key error normalization (email unique) */
function dupKeyHandler(err: any, _doc: any, next: (err?: any) => void) {
  if (err?.name === "MongoServerError" && err?.code === 11000 && err?.keyPattern?.email) {
    const e = new Error("Email already in use");
    (e as any).code = "EMAIL_TAKEN";
    (e as any).status = 409;
    return next(e);
  }
  next(err);
}
UserSchema.post("save", dupKeyHandler as any);
UserSchema.post("findOneAndUpdate", dupKeyHandler as any);
UserSchema.post("insertMany", dupKeyHandler as any);

export const User = mongoose.models.User || mongoose.model<User, UserModel>("User", UserSchema);
