// src/modules/quotes/routes.ts
import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { enumerateBuckets, toUtcMidnight } from "../../utils/dates.js";
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

router.post(
  "/quotes/preview",
  asyncHandler(async (req, res) => {
    const { listingId, start, end } = PreviewSchema.parse(req.body);

    const listing = await Listing.findById(listingId).lean();
    if (!listing || listing.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }

    // Decide granularity
    const hasHourly = !!listing.pricing?.baseHourlyCents;
    const granularity: "hour" | "day" = hasHourly ? "hour" : "day";

    // Build requested buckets
    const buckets =
      granularity === "hour"
        ? enumerateBuckets(start.getTime(), end.getTime(), "hour")
        : enumerateBuckets(toUtcMidnight(start).getTime(), toUtcMidnight(end).getTime(), "day");

    if (!buckets.length) {
      return res.status(422).json({
        error: { code: "INVALID_WINDOW", message: "Empty or invalid time window" },
      });
    }

    // 1) Locks conflict?
    const lockDocs = await BookingLock.find({
      listingId: new mongoose.Types.ObjectId(listingId),
      dateBucket: { $in: buckets },
    })
      .select({ dateBucket: 1 })
      .lean();

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

    // Pricing
    const p = listing.pricing || {};
    const feeCents = p.feeCents ?? 0;
    const depositCents = p.depositCents ?? 0;

    let nUnits = buckets.length;
    let baseCents = 0;

    if (granularity === "hour") {
      const minHours = p.minHours ?? 1;
      const hourly = p.baseHourlyCents ?? Math.ceil(((p.baseDailyCents ?? 0) as number) / 24);

      if (!hourly) {
        return res.status(422).json({
          error: { code: "NO_PRICING", message: "Missing hourly/daily pricing" },
        });
      }

      const billable = Math.max(nUnits, minHours);
      baseCents = hourly * billable;
      nUnits = billable; // reflect the billable hours in the response
    } else {
      const daily = p.baseDailyCents ?? Math.ceil(((p.baseHourlyCents ?? 0) as number) * 24);
      if (!daily) {
        return res.status(422).json({
          error: { code: "NO_PRICING", message: "Missing daily/hourly pricing" },
        });
      }
      baseCents = daily * nUnits;
    }

    const taxCents = 0; // tax comes later (C7)
    const totalCents = baseCents + feeCents + taxCents;

    return res.json({
      listingId,
      start,
      end,
      granularity,
      nUnits,
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
