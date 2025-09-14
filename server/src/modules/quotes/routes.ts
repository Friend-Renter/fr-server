// src/modules/quotes/routes.ts
import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { enumerateBuckets } from "../../utils/dates.js";
import { asyncHandler } from "../../utils/http.js";
import { Listing } from "../listings/model.js";
import { BookingLock } from "../locks/model.js";

const router = Router();

const PreviewSchema = z.object({
  listingId: z.string().length(24),
  start: z.coerce.date(),
  end: z.coerce.date(),
});

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

// Categories that allow hour-based selection (but still bill by full days)
const HOUR_CATS = new Set(["car", "boat", "jetski"]);

router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const { listingId, start, end } = PreviewSchema.parse(req.body);

    if (end <= start) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "end must be after start" } });
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

    // --- Pricing ---
    // For hour categories, bill by whole days (ceil) even though selection is hourly.
    // For day categories, bill per-day based on number of day buckets.
    const p = (listing as any).pricing || {};
    const feeCents = p.feeCents ?? 0;
    const depositCents = p.depositCents ?? 0;

    const daily =
      (p.baseDailyCents as number | undefined) ??
      ((p.baseHourlyCents as number | undefined) ?? 0) * 24;

    if (!daily) {
      return res
        .status(422)
        .json({ error: { code: "NO_PRICING", message: "Missing daily/hourly pricing" } });
    }

    let nUnits = buckets.length;
    let baseCents = 0;
    let billableDays: number | undefined;

    if (granularity === "hour") {
      const durationMs = end.getTime() - start.getTime();
      billableDays = Math.max(1, Math.ceil(durationMs / (24 * 3600 * 1000)));
      baseCents = daily * billableDays;
    } else {
      // day-based search & day-based billing
      baseCents = daily * nUnits;
    }

    const taxCents = 0; // tax later (C7)
    const totalCents = baseCents + feeCents + taxCents;

    return res.json({
      listingId,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity, // 'hour' for car/boat/jetski; 'day' otherwise
      nUnits, // availability buckets count (hours or days)
      ...(billableDays ? { billableDays } : {}),
      pricingSnapshot: {
        baseCents,
        feeCents,
        taxCents,
        depositCents,
        totalCents,
      },
    });
  })
);

export default router;
