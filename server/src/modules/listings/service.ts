import mongoose from "mongoose";

import { Listing, type ListingDoc } from "./model.js";
import { connectMongo } from "../../config/db.js";
import type { CancellationPolicy, ListingStatus } from "../../domain/index.js";
import { Asset } from "../assets/model.js";

export type CreateListingInput = {
  assetId: string;
  pricing: {
    baseDailyCents?: number;
    baseHourlyCents?: number;
    minHours?: number;
    depositCents?: number;
    feeCents?: number;
  };
  instantBook?: boolean;
  blackouts?: Array<{ start: Date | string; end: Date | string; reason?: string }>;
  cancellationPolicy?: CancellationPolicy;
  status?: ListingStatus;
};

/** Ensure asset exists, copy hostId, then create listing. */
export async function createListing(input: CreateListingInput): Promise<ListingDoc> {
  await connectMongo();

  const asset = await Asset.findById(input.assetId).lean();
  if (!asset) throw Object.assign(new Error("Asset not found"), { code: "ASSET_NOT_FOUND" });

  const doc = new Listing({
    assetId: new mongoose.Types.ObjectId(input.assetId),
    hostId: new mongoose.Types.ObjectId(String(asset.hostId)),
    pricing: {
      baseDailyCents: input.pricing.baseDailyCents,
      baseHourlyCents: input.pricing.baseHourlyCents,
      minHours: input.pricing.minHours ?? 1,
      depositCents: input.pricing.depositCents ?? 0,
      feeCents: input.pricing.feeCents ?? 0,
    },
    instantBook: input.instantBook ?? false,
    blackouts: (input.blackouts ?? []).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
      reason: b.reason,
    })),
    cancellationPolicy: input.cancellationPolicy ?? "moderate",
    status: input.status ?? "draft",
  } as Partial<ListingDoc>);

  await doc.save();
  return doc;
}

export async function findListingById(id: string): Promise<ListingDoc | null> {
  await connectMongo();
  return Listing.findById(id).exec();
}

export async function listListingsByAsset(assetId: string): Promise<ListingDoc[]> {
  await connectMongo();
  return Listing.find({ assetId: new mongoose.Types.ObjectId(assetId) })
    .sort({ createdAt: -1 })
    .exec();
}

export async function listListingsByHost(hostId: string, opts?: { status?: ListingStatus }) {
  await connectMongo();
  const q: any = { hostId: new mongoose.Types.ObjectId(hostId) };
  if (opts?.status) q.status = opts.status;
  return Listing.find(q).sort({ createdAt: -1 }).exec();
}

/** Public shape for API responses */
export function toPublicListing(l: ListingDoc) {
  return {
    id: l.id,
    assetId: l.assetId.toString(),
    hostId: l.hostId.toString(),
    pricing: l.pricing,
    instantBook: l.instantBook,
    blackouts: l.blackouts,
    cancellationPolicy: l.cancellationPolicy,
    status: l.status,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}
