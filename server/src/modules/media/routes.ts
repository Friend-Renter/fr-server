// server/src/modules/media/routes.ts
import { Router } from "express";
import { z } from "zod";

import { env } from "../../config/env.js";
import { buildKey, presignPut, toPublicUrl } from "../../lib/s3.js";
import { requireAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

const SignSchema = z.object({
  contentType: z.string().min(3),
  folder: z.enum(["assets", "checkins", "checkouts"]).default("assets"),
  pathHint: z.string().optional(),
});

router.post(
  "/sign",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.S3_BUCKET) {
      return res
        .status(503)
        .json({ error: { code: "S3_NOT_CONFIGURED", message: "S3 env missing" } });
    }
    const parsed = SignSchema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.flatten();
      return res
        .status(422)
        .json({ error: { code: "UNPROCESSABLE_ENTITY", message: "Invalid body", details } });
    }
    const { contentType, folder, pathHint } = parsed.data;

    const { key } = buildKey({ folder, contentType, pathHint });
    const signed = await presignPut(key, contentType);
    const publicUrl = toPublicUrl(key);

    jsonOk(res, { ...signed, publicUrl });
  })
);

export default router;
