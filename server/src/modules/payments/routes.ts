import crypto from "crypto";

import { Router } from "express";
import { z } from "zod";

import { key, redisClient } from "../../config/redis.js";
import { stripe } from "../../lib/stripe.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { buildBucketsAndGranularity, priceSnapshotByDays } from "../bookings/service.js";
import { Listing } from "../listings/model.js";
import { lockBuckets } from "../locks/service.js";

const router = Router();

const IntentSchema = z.object({
  listingId: z.string().length(24),
  start: z.coerce.date(),
  end: z.coerce.date(),
});

router.post(
  "/intents",
  requireAuth,
  requireRole("renter"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { listingId, start, end } = IntentSchema.parse(req.body);

    const listing = await Listing.findById(listingId).lean();
    if (!listing || listing.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }

    const { granularity, buckets } = await buildBucketsAndGranularity(listing, start, end);
    if (!buckets.length) {
      return res.status(422).json({ error: { code: "INVALID_WINDOW", message: "Empty window" } });
    }
    const { pricingSnapshot } = priceSnapshotByDays(listing, start, end);
    if (pricingSnapshot.totalCents <= 0) {
      return res.status(422).json({ error: { code: "NO_PRICING" } });
    }

    const idempHeader = String(req.header("X-Idempotency-Key") || "");
    const derived = `pi:rental:${userId}:${listingId}:${start.toISOString()}:${end.toISOString()}:${pricingSnapshot.totalCents}`;
    const hash = crypto
      .createHash("sha1")
      .update(idempHeader || derived)
      .digest("hex");
    const cacheKey = key("pi", "intent", hash);
    const r = redisClient();
    if (!r.isOpen) await r.connect();
    const cached = await r.get(cacheKey);

    if (cached) {
      const existing = await stripe.paymentIntents.retrieve(cached).catch(() => null);
      if (
        existing &&
        ["requires_payment_method", "requires_action", "processing", "succeeded"].includes(
          existing.status
        )
      ) {
        return jsonOk(res, {
          paymentIntentId: existing.id,
          clientSecret: existing.client_secret,
        });
      }
    }

    const pi = await stripe.paymentIntents.create(
      {
        amount: pricingSnapshot.totalCents,
        currency: "usd",
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: "never", // ⬅️ add this line
        },
        metadata: {
          renterId: userId,
          listingId,
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          totalCents: String(pricingSnapshot.totalCents),
        },
      },
      { idempotencyKey: idempHeader || derived }
    );

    try {
      const holdUntil = new Date(Date.now() + 30 * 60 * 1000);
      await lockBuckets({
        listingId,
        buckets,
        granularity,
        createdBy: userId,
        reason: `pi:${pi.id}`,
        holdUntil,
      });
    } catch (e: any) {
      try {
        await stripe.paymentIntents.cancel(pi.id);
      } catch {}
      return res.status(409).json({
        error: { code: "UNAVAILABLE", message: "Requested window is unavailable" },
      });
    }

    await r.set(cacheKey, pi.id, { NX: true, EX: 60 * 30 });

    return jsonOk(res, { paymentIntentId: pi.id, clientSecret: pi.client_secret });
  })
);

// INTERNAL/diagnostic
const StatusQuery = z.object({
  paymentIntentId: z.string().optional(),
  bookingId: z.string().length(24).optional(),
});
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { paymentIntentId, bookingId } = StatusQuery.parse(req.query);
    if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      return jsonOk(res, {
        id: pi.id,
        status: pi.status,
        amount: pi.amount,
        metadata: pi.metadata,
      });
    }
    if (bookingId) {
      const { Booking } = await import("../bookings/model.js");
      const doc = await Booking.findById(bookingId).lean();
      if (!doc) return res.status(404).json({ error: { code: "NOT_FOUND" } });

      // status stays = booking.paymentStatus (compat),
      // refs stays = booking.paymentRefs (compat),
      // NEW: bookingState = booking.state
      return jsonOk(res, {
        status: doc.paymentStatus,
        refs: doc.paymentRefs,
        bookingState: doc.state,
      });
    }
    return res.status(400).json({ error: { code: "BAD_REQUEST" } });
  })
);

export default router;
