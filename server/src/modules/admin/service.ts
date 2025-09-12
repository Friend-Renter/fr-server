import mongoose from "mongoose";

import { writeAudit } from "../audit/service";
import { FeatureFlag } from "../features/model.js";
import { Listing } from "../listings/model.js";
import { User } from "../users/model.js";

export async function adminListUsers(filters: {
  role?: "renter" | "host" | "admin";
  kycStatus?: "unverified" | "pending" | "verified" | "rejected";
  isActive?: boolean;
  q?: string;
  page: number;
  limit: number;
}) {
  const query: any = {};
  if (filters.role) query.role = filters.role;
  if (filters.kycStatus) query.kycStatus = filters.kycStatus;
  if (typeof filters.isActive === "boolean") query.isActive = filters.isActive;
  if (filters.q) {
    const rx = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }];
  }
  const skip = (filters.page - 1) * filters.limit;
  const [items, total] = await Promise.all([
    User.find(query).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean().exec(),
    User.countDocuments(query).exec(),
  ]);
  return { items, total, page: filters.page, limit: filters.limit };
}

export async function adminPatchUser(
  adminId: string,
  userId: string,
  body: {
    role?: "renter" | "host" | "admin";
    suspend?: boolean;
    unsuspend?: boolean;
    kycOverride?: "unverified" | "pending" | "verified" | "rejected";
  }
) {
  const update: any = {};
  const now = new Date();

  if (body.role) update.role = body.role;
  if (body.suspend) {
    update.isActive = false;
    update.deactivatedAt = now;
  }
  if (body.unsuspend) {
    update.isActive = true;
    update.deactivatedAt = null;
  }
  if (body.kycOverride) {
    update.kycStatus = body.kycOverride;
    update.kycUpdatedAt = now;
  }

  const before = await User.findById(userId).lean().exec();
  if (!before) throw Object.assign(new Error("User not found"), { code: "NOT_FOUND" });

  const after = await User.findByIdAndUpdate(userId, { $set: update }, { new: true }).lean().exec();

  await writeAudit({
    actorId: new mongoose.Types.ObjectId(adminId),
    action: "user.update",
    target: { type: "user", id: new mongoose.Types.ObjectId(userId) },
    diff: { before, patch: update, after },
  });

  return after;
}

export async function adminListListings(filters: {
  status?: "draft" | "pending" | "active" | "suspended";
  hostId?: string;
  q?: string;
  page: number;
  limit: number;
}) {
  const query: any = {};
  if (filters.status) query.status = filters.status;
  if (filters.hostId) query.hostId = new mongoose.Types.ObjectId(filters.hostId);
  // Minimal q filter: look into pricing or simple denormalized fields if you have them
  if (filters.q) {
    const rx = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ notes: rx }]; // placeholder if you store moderation notes; otherwise omit
  }
  const skip = (filters.page - 1) * filters.limit;
  const [items, total] = await Promise.all([
    Listing.find(query).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean().exec(),
    Listing.countDocuments(query).exec(),
  ]);
  return { items, total, page: filters.page, limit: filters.limit };
}

export async function adminPatchListing(
  adminId: string,
  id: string,
  body: { approve?: boolean; suspend?: boolean; reason?: string }
) {
  const before = await Listing.findById(id).lean().exec();
  if (!before) throw Object.assign(new Error("Listing not found"), { code: "NOT_FOUND" });

  const update: any = {};
  if (body.approve) update.status = "active";
  if (body.suspend) update.status = "suspended";
  if (body.reason) update.moderationReason = body.reason;

  const after = await Listing.findByIdAndUpdate(id, { $set: update }, { new: true }).lean().exec();

  await writeAudit({
    actorId: new mongoose.Types.ObjectId(adminId),
    action: "listing.update",
    target: { type: "listing", id: new mongoose.Types.ObjectId(id) },
    diff: { before, patch: update, after },
  });

  return after;
}

export async function listFlags() {
  return FeatureFlag.find({}).sort({ key: 1 }).lean().exec();
}

export async function putFlag(
  adminId: string,
  key: string,
  body: { enabled: boolean; notes?: string }
) {
  const before = await FeatureFlag.findOne({ key }).lean().exec();
  const after = await FeatureFlag.findOneAndUpdate(
    { key },
    {
      $set: {
        enabled: body.enabled,
        notes: body.notes || null,
        updatedAt: new Date(),
        updatedBy: new mongoose.Types.ObjectId(adminId),
      },
    },
    { upsert: true, new: true }
  )
    .lean()
    .exec();

  await writeAudit({
    actorId: new mongoose.Types.ObjectId(adminId),
    action: "flag.put",
    target: { type: "feature", key },
    diff: { before, after },
  });

  return after;
}
