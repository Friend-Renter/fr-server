// src/modules/assets/schemas.ts
import { z } from "zod/v4";

export const GeoPointInput = z.object({
  type: z.literal("Point"),
  // NOTE: [lng, lat] order
  coordinates: z.tuple([z.number().gte(-180).lte(180), z.number().gte(-90).lte(90)]),
});

export const CreateAssetSchema = z.object({
  category: z.enum(["car", "boat", "jetski", "electronics", "lawn", "misc"]),
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  specs: z.record(z.string(), z.any()).default({}),
  media: z.array(z.string().url()).default([]),
  location: GeoPointInput, // REQUIRED
});

export type CreateAssetInput = z.infer<typeof CreateAssetSchema>;
