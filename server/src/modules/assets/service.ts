import mongoose from "mongoose";

import { Asset, type AssetDoc } from "./model.js";
import { connectMongo } from "../../config/db.js";
import type { Category, AssetStatus } from "../../domain/index.js";

export type MediaItem = {
  url: string;
  key?: string;
  width?: number;
  height?: number;
  label?: string;
};

export type CreateAssetInput = {
  hostId: string;
  category: Category;
  title: string;
  description?: string;
  media?: MediaItem[];
  specs?: Record<string, any>;
  location?: { type: "Point"; coordinates: [number, number] }; // [lng, lat]
  status?: AssetStatus;
};

export async function createAsset(input: CreateAssetInput): Promise<AssetDoc> {
  await connectMongo();
  const doc = new Asset({
    hostId: new mongoose.Types.ObjectId(input.hostId),
    category: input.category,
    title: input.title,
    description: input.description,
    media: input.media ?? [],
    specs: input.specs ?? {},
    location: input.location,
    status: input.status ?? "pending",
  } as Partial<AssetDoc>);
  await doc.save();
  return doc;
}

export async function findAssetById(id: string): Promise<AssetDoc | null> {
  await connectMongo();
  return Asset.findById(id).exec();
}

export async function listAssetsByHost(
  hostId: string,
  opts?: { status?: AssetStatus }
): Promise<AssetDoc[]> {
  await connectMongo();
  const q: any = { hostId: new mongoose.Types.ObjectId(hostId) };
  if (opts?.status) q.status = opts.status;
  return Asset.find(q).sort({ createdAt: -1 }).exec();
}

/** Public shape for API exposure (keeps internal blobs minimal for now) */
export function toPublicAsset(a: AssetDoc) {
  return {
    id: a.id,
    hostId: a.hostId.toString(),
    category: a.category,
    title: a.title,
    description: a.description ?? "",
    media: a.media ?? [],
    location: a.location ?? null,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    // specs intentionally omitted from public payload for now; expose selectively later
  };
}
