// src/modules/assets/routes.ts
import { Router } from "express";
import { z } from "zod";

import { Asset } from "./model.js";
import { CreateAssetSchema, type CreateAssetInput } from "./schemas.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

// helper: owner or admin
function canEdit(auth: { userId: string; role: string }, asset: any) {
  if (auth.role === "admin") return true;
  return String(asset.hostId) === auth.userId;
}

const MediaItemSchema = z.union([
  z.string().url(),
  z.object({
    url: z.string().url(),
    key: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    label: z.string().max(50).optional(),
  }),
]);

const PatchMediaSchema = z
  .object({
    addMedia: z.array(MediaItemSchema).optional(),
    removeMedia: z.array(z.string().url()).optional(),
  })
  .refine((o) => (o.addMedia && o.addMedia.length) || (o.removeMedia && o.removeMedia.length), {
    message: "addMedia or removeMedia must be provided",
    path: ["addMedia"],
  });

//get asset?
router.get(
  "/:id",
  requireAuth, // or public if you prefer
  asyncHandler(async (req, res) => {
    const doc = await Asset.findById(req.params.id);
    if (!doc)
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Asset not found" } });
    jsonOk(res, doc);
  })
);

/** Host: create an asset (location required) */
router.post(
  "/",
  requireAuth,

  asyncHandler(async (req, res) => {
    // 🔹 no throwing: turn Zod errors into a 422 response
    const parsed = CreateAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.flatten();
      return res.status(422).json({
        error: { code: "UNPROCESSABLE_ENTITY", message: "Invalid request body", details },
      });
    }
    const input = CreateAssetSchema.parse(req.body) as CreateAssetInput;
    const { userId } = getAuth(req);

    const doc = await Asset.create({
      hostId: userId,
      category: input.category,
      title: input.title,
      description: input.description,
      specs: input.specs,
      media: input.media,
      location: input.location, // GeoJSON Point: [lng, lat]
      status: "active", // or 'draft' if you prefer moderation first
    });

    jsonOk(res, { id: doc.id });
  })
);

// quick sanity: confirm auth + body parsing + routing works
router.post(
  "/assets/raw",
  requireAuth,

  asyncHandler(async (req, res) => {
    return jsonOk(res, { ok: true, body: req.body });
  })
);

//s3 add/remove media
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = PatchMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.flatten();
      return res.status(422).json({
        error: { code: "UNPROCESSABLE_ENTITY", message: "Invalid request body", details },
      });
    }
    const { userId, role } = getAuth(req);
    const asset = await Asset.findById(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Asset not found" } });
    }
    if (!canEdit({ userId, role }, asset)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Not owner/admin" } });
    }

    const add: Array<any> = (parsed.data.addMedia || []).map((m) =>
      typeof m === "string" ? { url: m } : m
    );
    const remove = new Set(parsed.data.removeMedia || []);

    // dedupe by URL, apply removals
    const byUrl = new Map<string, any>();
    for (const m of asset.media || []) {
      if (!remove.has(m.url)) byUrl.set(m.url, m);
    }
    for (const m of add) {
      byUrl.set(m.url, { ...byUrl.get(m.url), ...m }); // merge if exists
    }

    asset.media = Array.from(byUrl.values());
    await asset.save();

    jsonOk(res, { media: asset.media });
  })
);

export default router;
