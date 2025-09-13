import mongoose from "mongoose";

import { connectMongo } from "../../config/db"; // adjust path

type SearchParams = {
  lat: number;
  lng: number;
  radiusKm: number;
  category?: string;
  instantBook?: boolean;
  minPrice?: number;
  maxPrice?: number;
  page: number;
  limit: number;
};

const HOUR_CATS = ["car", "boat", "jetski"];

export async function searchNearby(params: SearchParams) {
  await connectMongo();

  const { lat, lng, radiusKm, category, instantBook, minPrice, maxPrice, page, limit } = params;

  const radiusMeters = Math.min(Math.max(radiusKm, 0.1), 200) * 1000;
  const skip = (page - 1) * limit;

  if (!mongoose.connection.db) throw new Error("DB not ready");
  const assets = mongoose.connection.db.collection("assets");

  const pipeline: any[] = [
    {
      $geoNear: {
        near: { type: "Point", coordinates: [lng, lat] },
        distanceField: "dist",
        maxDistance: radiusMeters,
        spherical: true,
      },
    },
    { $match: { status: "active", ...(category ? { category } : {}) } },
    {
      $lookup: {
        from: "listings",
        localField: "_id",
        foreignField: "assetId",
        as: "listing",
      },
    },
    { $unwind: "$listing" },
    {
      $match: {
        "listing.status": "active",
        ...(instantBook !== undefined ? { "listing.instantBook": !!instantBook } : {}),
      },
    },
    // derive priceCents depending on category granularity
    {
      $addFields: {
        priceCents: {
          $cond: [
            { $in: ["$category", HOUR_CATS] },
            "$listing.pricing.baseHourlyCents",
            "$listing.pricing.baseDailyCents",
          ],
        },
      },
    },
    ...(minPrice !== undefined || maxPrice !== undefined
      ? [
          {
            $match: {
              ...(minPrice !== undefined ? { priceCents: { $gte: minPrice } } : {}),
              ...(maxPrice !== undefined
                ? {
                    priceCents: {
                      ...(minPrice !== undefined ? { $gte: minPrice } : {}),
                      $lte: maxPrice,
                    },
                  }
                : {}),
            },
          },
        ]
      : []),
    {
      $project: {
        _id: 0,
        assetId: "$_id",
        listingId: "$listing._id",
        category: 1,
        status: "$listing.status",
        coords: "$location.coordinates",
        distanceKm: { $divide: ["$dist", 1000] },
        priceCents: 1,
        instantBook: "$listing.instantBook",
        media: { $slice: ["$media", 3] },
      },
    },
    { $skip: skip },
    { $limit: limit + 1 }, // fetch one extra to compute hasMore
  ];

  const items = await assets.aggregate(pipeline).toArray();
  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  // normalize coords -> {lat, lng}
  const normalized = items.map((it: any) => ({
    ...it,
    coords:
      Array.isArray(it.coords) && it.coords.length === 2
        ? { lng: it.coords[0], lat: it.coords[1] }
        : undefined,
  }));

  return { page, limit, hasMore, items: normalized };
}
