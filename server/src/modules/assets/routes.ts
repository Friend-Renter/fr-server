// src/modules/assets/routes.ts
import { Router } from "express";

import { Asset } from "./model.js";
import { CreateAssetSchema, type CreateAssetInput } from "./schemas.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

/** Host: create an asset (location required) */
router.post(
  "/",
  requireAuth,
  requireRole("host"),
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
  requireRole("host"),
  asyncHandler(async (req, res) => {
    return jsonOk(res, { ok: true, body: req.body });
  })
);

export default router;
