import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { Listing } from "./model.js";
import { enumerateBuckets } from "../../utils/dates.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { Asset } from "../assets/model.js"; // <-- add
import { getFlagsDoc } from "../flags/service.js";
import { BookingLock } from "../locks/model.js";
import { User } from "../users/model.js";

const router = Router();

/**
 * GET /listings
 * Public feed (minimal) with optional self-exclusion: ?excludeHostId=&limit=
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
    const excludeHostId = req.query.excludeHostId ? String(req.query.excludeHostId) : null;

    const match: any = { status: "active" };
    if (excludeHostId && mongoose.isValidObjectId(excludeHostId)) {
      match.hostId = { $ne: new mongoose.Types.ObjectId(excludeHostId) };
    }

    // Aggregate to join Asset for title/media
    const docs = await Listing.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "assets",
          localField: "assetId",
          foreignField: "_id",
          as: "asset",
        },
      },
      { $unwind: { path: "$asset", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          hostId: 1,
          pricing: 1,
          "location.point": 1,
          "location.state": 1,
          assetTitle: "$asset.title",
          assetMedia: "$asset.media",
          createdAt: 1,
        },
      },
    ]);
    const showPrice = !!flags.flags.pricing?.enabled;

    const items = docs.map((d: any) => {
      const cents = d?.pricing?.baseDailyCents ?? null;
      const pricePerDay = showPrice && typeof cents === "number" ? Math.round(cents) / 100 : null;
      const photos =
        Array.isArray(d?.assetMedia) && d.assetMedia.length
          ? d.assetMedia.map((m: any) => m?.url).filter(Boolean)
          : [];

      const coords = d?.location?.point?.coordinates; // [lng, lat]
      const lng = Array.isArray(coords) ? coords[0] : null;
      const lat = Array.isArray(coords) ? coords[1] : null;

      return {
        id: String(d._id),
        title: d.assetTitle || "Listing",
        photos,
        pricePerDay,
        location: {
          state: d?.location?.state || null,
          lat,
          lng,
        },
        host: { id: String(d.hostId) },
      };
    });

    return jsonOk(res, { items, nextCursor: null });
  })
);

/**
 * GET /listings/:id
 * Public listing details (joined with Asset for title/media)
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const flags = await getFlagsDoc();
    if (!flags.flags.listings?.enabled) {
      return res
        .status(423)
        .json({ error: { code: "FEATURE_DISABLED", feature: "listings.enabled" } });
    }

    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(422).json({ error: { code: "INVALID_ID", message: "Invalid listing id" } });
    }

    const d = await Listing.findById(id).lean();
    if (!d || d.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }

    const asset = await Asset.findById(d.assetId, { title: 1, media: 1 }).lean();
    const showPrice = !!flags.flags.pricing?.enabled;

    const cents = d?.pricing?.baseDailyCents ?? null;
    const pricePerDay = showPrice && typeof cents === "number" ? Math.round(cents) / 100 : null;

    // Optional: host name
    let host: { id: string; name?: string } = { id: String(d.hostId) };
    try {
      const h = await User.findById(d.hostId, { firstName: 1, lastName: 1 }).lean();
      if (h) host.name = `${h.firstName ?? ""} ${h.lastName ?? ""}`.trim();
    } catch {}

    const coords = d?.location?.point?.coordinates; // [lng, lat]
    const lng = Array.isArray(coords) ? coords[0] : null;
    const lat = Array.isArray(coords) ? coords[1] : null;

    return jsonOk(res, {
      id: String(d._id),
      title: asset?.title || "Listing",
      photos:
        Array.isArray(asset?.media) && asset.media.length
          ? asset.media.map((m: any) => m?.url).filter(Boolean)
          : [],
      description: null,
      pricePerDay,
      location: {
        state: d?.location?.state || null,
        lat,
        lng,
      },
      host,
      friendsOnly: false,
      depositHold: d?.pricing?.depositCents ? Math.round(d.pricing.depositCents) / 100 : null,
      requiresHostApproval: !d?.instantBook,
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