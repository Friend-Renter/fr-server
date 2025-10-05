import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { Listing } from "./model.js";
import { enumerateBuckets } from "../../utils/dates.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { getFlagsDoc } from "../flags/service.js";
import { BookingLock } from "../locks/model.js";
import { User } from "../users/model.js"; // for host name (optional)

const router = Router();

/**
 * GET /listings
 * Public feed (minimal): cursor-less stub for now.
 * Query: ?limit=&cursor=&q=&lat=&lng=&radius=
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const flags = await getFlagsDoc();
    if (!flags.flags.listings?.enabled) {
      return res
        .status(423)
        .json({ error: { code: "FEATURE_DISABLED", feature: "listings.enabled" } });
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 50);
    // Very simple: newest active listings first
    const docs = await Listing.find(
      { status: "active" },
      {
        _id: 1,
        title: 1,
        photos: 1,
        pricing: 1,
        hostId: 1,
        "location.city": 1,
        "location.lat": 1,
        "location.lng": 1,
        createdAt: 1,
      }
    )
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const showPrice = !!flags.flags["pricing.enabled"];
    const items = docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      photos: Array.isArray(d.photos) ? d.photos : [],
      pricePerDay: showPrice ? (d?.pricing?.perDay ?? d?.pricing?.basePerDay ?? null) : null,
      location: d.location
        ? {
            city: d.location.city || null,
            lat: d.location.lat ?? null,
            lng: d.location.lng ?? null,
          }
        : null,
      host: { id: String(d.hostId) },
    }));

    return jsonOk(res, { items, nextCursor: null });
  })
);

/**
 * GET /listings/:id
 * Public listing details
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const flags = await getFlagsDoc();
    // if (!flags["listings.enabled"]) {
    //   return res
    //     .status(423)
    //     .json({ error: { code: "FEATURE_DISABLED", feature: "listings.enabled" } });
    // }

    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(422).json({ error: { code: "INVALID_ID", message: "Invalid listing id" } });
    }

    const d = await Listing.findById(id, {
      _id: 1,
      title: 1,
      photos: 1,
      description: 1,
      pricing: 1,
      status: 1,
      hostId: 1,
      "location.city": 1,
      "location.lat": 1,
      "location.lng": 1,
      badges: 1, // friendsOnly / deposit / approval, if you store them
    }).lean();

    if (!d || d.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }

    const showPrice = !!flags.flags["pricing.enabled"];
    // Optional: get host name
    let host = { id: String(d.hostId) };
    try {
      const h = await User.findById(d.hostId, { firstName: 1, lastName: 1 }).lean();
      if (h) host = { ...host, name: `${h.firstName ?? ""} ${h.lastName ?? ""}`.trim() };
    } catch {}

    return jsonOk(res, {
      id: String(d._id),
      title: d.title,
      photos: Array.isArray(d.photos) ? d.photos : [],
      description: d.description ?? null,
      pricePerDay: showPrice ? (d?.pricing?.perDay ?? d?.pricing?.basePerDay ?? null) : null,
      location: d.location
        ? {
            city: d.location.city || null,
            lat: d.location.lat ?? null,
            lng: d.location.lng ?? null,
          }
        : null,
      host,
      friendsOnly: !!d?.badges?.friendsOnly,
      depositHold: d?.badges?.depositHold ?? null,
      requiresHostApproval: !!d?.badges?.requiresHostApproval,
    });
  })
);

type Granularity = "hour" | "day";
const HOUR_CATS = new Set(["car", "boat", "jetski"]);
const granularityFor = (category: string): Granularity =>
  HOUR_CATS.has(category) ? "hour" : "day";

const Q = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});

// Mounted at /listings → GET /listings/:id/availability
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

    const buckets = enumerateBuckets(start.getTime(), end.getTime(), granularity);
    if (buckets.length === 0) return jsonOk(res, { granularity, buckets: [] });

    const locked = await BookingLock.find(
      { listingId: new mongoose.Types.ObjectId(id), dateBucket: { $in: buckets } },
      { dateBucket: 1, _id: 0 }
    ).lean();
    const lockedSet = new Set(locked.map((d: any) => d.dateBucket));

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
