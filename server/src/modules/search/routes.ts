import { Router } from "express";
import { z } from "zod";

import { searchNearby } from "./service.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const router = Router();

const QuerySchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radiusKm: z.coerce.number().min(0.1).max(200).default(25),
  category: z.enum(["car", "boat", "jetski", "electronics", "lawn", "misc"]).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  instantBook: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Mounted at /search → GET /search
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_QUERY", message: parsed.error.message } });
    }
    const out = await searchNearby(parsed.data);
    jsonOk(res, out);
  })
);

export default router;
