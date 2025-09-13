import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod/v4";

import { Listing } from "./model.js";
import { enumerateBuckets } from "../../utils/dates.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { BookingLock } from "../locks/model.js";

const router = Router();

type Granularity = "hour" | "day";
const HOUR_CATS = new Set(["car", "boat", "jetski"]);
const granularityFor = (category: string): Granularity =>
  HOUR_CATS.has(category) ? "hour" : "day";

const Q = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});

router.get(
  "/:id/availability",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(422).json({ error: { code: "INVALID_ID", message: "Invalid listing id" } });
    }

    const qq = Q.safeParse(req.query);
    if (!qq.success) {
      return res.status(422).json({ error: { code: "INVALID_QUERY", message: qq.error.message } });
    }
    const { start, end } = qq.data;
    if (end <= start) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "end must be after start" } });
    }
    // Cap max window (e.g., 31 days worth of buckets)
    if (end.getTime() - start.getTime() > 31 * 24 * 3600 * 1000) {
      return res
        .status(422)
        .json({ error: { code: "INVALID_WINDOW", message: "range too large" } });
    }

    const listing = await Listing.findById(id, {
      assetId: 1,
      status: 1,
      blackouts: 1,
      pricing: 1,
    }).lean();
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

    const buckets = enumerateBuckets(start.getTime(), end.getTime(), granularity); // string[]
    if (buckets.length === 0) return jsonOk(res, { granularity, buckets: [] });

    // Locks present?
    const locked = await BookingLock.find(
      { listingId: new mongoose.Types.ObjectId(id), dateBucket: { $in: buckets } },
      { dateBucket: 1, _id: 0 }
    ).lean();
    const lockedSet = new Set(locked.map((d: any) => d.dateBucket));

    // Blackouts filter
    const blockedByBlackout = (bucket: string) => {
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

    const available = buckets.filter((b) => !lockedSet.has(b) && !blockedByBlackout(b));
    jsonOk(res, { granularity, buckets: available });
  })
);

export default router;
