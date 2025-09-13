import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod/v4";

import { enumerateBuckets } from "../../utils/dates.js";
import { asyncHandler } from "../../utils/http.js";
import { Listing } from "../listings/model.js";
import { BookingLock } from "../locks/model.js";

const router = Router();

type Granularity = "hour" | "day";
const HOUR_CATS = new Set(["car", "boat", "jetski"]);
const granularityFor = (category: string): Granularity =>
  HOUR_CATS.has(category) ? "hour" : "day";

const Body = z.object({
  listingId: z.string(),
  start: z.coerce.date(),
  end: z.coerce.date(),
  options: z.object({ protectionPlan: z.enum(["basic", "plus", "pro"]).optional() }).optional(),
  promoCode: z.string().optional(),
});

router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_BODY", message: parsed.error.message } });
    }
    const { listingId, start, end } = parsed.data;

    if (!mongoose.isValidObjectId(listingId)) {
      return res.status(422).json({ error: { code: "INVALID_ID", message: "Invalid listingId" } });
    }
    if (end <= start) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "end must be after start" } });
    }

    const listing = await Listing.findById(listingId).lean();
    if (!listing || listing.status !== "active") {
      return res
        .status(404)
        .json({ error: { code: "LISTING_NOT_FOUND", message: "Listing not found" } });
    }

    if (!mongoose.connection.db) throw new Error("DB not ready");
    const asset = await mongoose.connection.db
      .collection("assets")
      .findOne({ _id: listing.assetId }, { projection: { category: 1 } });

    const category = asset?.category || "misc";
    const granularity = granularityFor(category);

    const buckets = enumerateBuckets(start.getTime(), end.getTime(), granularity);
    if (buckets.length === 0) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "window too short" } });
    }

    // Check locks
    const locked = await BookingLock.find(
      { listingId: new mongoose.Types.ObjectId(listingId), dateBucket: { $in: buckets } },
      { dateBucket: 1, _id: 0 }
    ).lean();
    const lockedSet = new Set(locked.map((d: any) => d.dateBucket));
    // Check blackouts
    const inBlackout = (bucket: string) => {
      if (!Array.isArray(listing.blackouts) || listing.blackouts.length === 0) return false;
      const bStart =
        granularity === "hour"
          ? new Date(`${bucket}:00:00.000Z`)
          : new Date(`${bucket}T00:00:00.000Z`);
      for (const w of listing.blackouts) {
        if (!w?.start || !w?.end) continue;
        if (bStart >= new Date(w.start) && bStart < new Date(w.end)) return true;
      }
      return false;
    };
    const conflict = buckets.some((b) => lockedSet.has(b) || inBlackout(b));
    if (conflict) {
      return res
        .status(409)
        .json({ error: { code: "UNAVAILABLE", message: "Listing not available for that window" } });
    }

    const nUnits = buckets.length;
    const basePer =
      granularity === "hour"
        ? (listing as any).pricing?.baseHourlyCents || 0
        : (listing as any).pricing?.baseDailyCents || 0;
    const baseCents = nUnits * basePer;
    const feeCents = (listing as any).pricing?.feeCents || 0;
    const depositCents = (listing as any).pricing?.depositCents || 0;
    const taxCents = 0;
    const totalCents = baseCents + feeCents + taxCents;

    return res.json({
      listingId,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
      nUnits,
      pricingSnapshot: { baseCents, feeCents, depositCents, taxCents, totalCents },
    });
  })
);

export default router;
