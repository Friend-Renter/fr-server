// src/modules/quotes/routes.ts
import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { getEnvPromos } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { enumerateBuckets } from "../../utils/dates.js";
import { asyncHandler } from "../../utils/http.js";
import { Listing } from "../listings/model.js";
import { BookingLock } from "../locks/model.js";
import { computeQuote } from "../pricing/calc.js";

const router = Router();

const PreviewSchema = z.object({
  listingId: z.string().length(24),
  start: z.coerce.date(),
  end: z.coerce.date(),
  promoCode: z.string().trim().min(1).optional(),
});

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

// Categories that allow hour-based selection (but still bill by full days)
const HOUR_CATS = new Set(["car", "boat", "jetski"]);

router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const { listingId, start, end, promoCode } = PreviewSchema.parse(req.body);

    if (end <= start) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "end must be after start" } });
    }

    // ---- C8: promo validation (explicit error) ----
    if (promoCode) {
      const promo = getEnvPromos().find((p) => p.code === promoCode.trim().toUpperCase());
      if (!promo) {
        return res.status(422).json({ error: { code: "INVALID_PROMO", message: "Unknown promo" } });
      }
    }

    const listing = await Listing.findById(listingId).lean();
    if (!listing || listing.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }

    // Look up asset category to decide granularity (selection granularity, not billing)
    if (!mongoose.connection.db) throw new Error("DB not ready");
    const asset = await mongoose.connection.db
      .collection("assets")
      .findOne({ _id: listing.assetId }, { projection: { category: 1 } });

    const category = asset?.category || "misc";
    const granularity: "hour" | "day" = HOUR_CATS.has(category) ? "hour" : "day";

    // Build requested buckets for availability/locks
    const buckets = enumerateBuckets(start.getTime(), end.getTime(), granularity);
    if (!buckets.length) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "Empty or invalid time window" } });
    }

    // 1) Locks conflict?
    const lockDocs = await BookingLock.find(
      { listingId: new mongoose.Types.ObjectId(listingId), dateBucket: { $in: buckets } },
      { dateBucket: 1, _id: 0 }
    ).lean();

    // 2) Blackouts conflict?
    const blackoutHits =
      (listing.blackouts || []).filter((b: any) =>
        overlaps(start, end, new Date(b.start), new Date(b.end))
      ) || [];

    if (lockDocs.length || blackoutHits.length) {
      return res.status(409).json({
        error: {
          code: "UNAVAILABLE",
          message: "Requested window is unavailable",
          conflictBuckets: lockDocs.map((d) => d.dateBucket),
          conflictBlackouts: blackoutHits.map((b: any) => ({
            start: b.start,
            end: b.end,
            reason: b.reason,
          })),
        },
      });
    }

    // ---------- C8: delegate pricing to shared calculator ----------
    // Re-load as a full doc (non-lean) for calc typing; calc only needs pricing/location fields.
    const listingDoc = await Listing.findById(listingId);
    if (!listingDoc) {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }
    const q = await computeQuote({ listing: listingDoc as any, start, end, promoCode });

    // For hour categories, we still show billableDays (ceil) for transparency
    let billableDays: number | undefined;
    if (granularity === "hour") {
      const durationMs = end.getTime() - start.getTime();
      billableDays = Math.max(1, Math.ceil(durationMs / (24 * 3600 * 1000)));
    }

    // ---- C8: lightweight info log on preview ----
    logger.info("quotes.preview", {
      listingId,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
      nUnits: buckets.length,
      promoCode: promoCode ?? null,
      totalCents: q.totalCents,
    });

    return res.json({
      listingId,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity, // 'hour' for car/boat/jetski; 'day' otherwise (selection granularity)
      nUnits: buckets.length, // availability buckets count (hours or days)
      ...(billableDays ? { billableDays } : {}),
      // Itemized pricing snapshot (C8)
      pricingSnapshot: {
        currency: q.currency,
        baseCents: q.baseCents,
        feeCents: q.feeCents,
        discountCents: q.discountCents,
        taxCents: q.taxCents,
        depositCents: q.depositCents,
        totalCents: q.totalCents,
        lineItems: q.lineItems,
        promoCode: promoCode ?? null,
        granularity: q.granularity, // billing granularity ('hour' | 'day') based on category rules
        nUnits: q.nUnits, // billing units count
      },
    });
  })
);

export default router;
