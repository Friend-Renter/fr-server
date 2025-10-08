import crypto from "crypto";

import { Router } from "express";
import { z } from "zod";

import { getEnvPromos } from "../../config/env.js";
import { key, redisClient } from "../../config/redis.js";
import { stripe } from "../../lib/stripe.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { requireFlag } from "../../middlewares/flags.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { buildBucketsAndGranularity } from "../bookings/service.js";
import { guardFriendshipOrEnsurePending } from "../friends/controller.js";
import { Listing } from "../listings/model.js";
import { lockBuckets } from "../locks/service.js";
import { computeQuote } from "../pricing/calc.js";

const router = Router();

const IntentSchema = z.object({
  listingId: z.string().length(24),
  start: z.coerce.date(),
  end: z.coerce.date(),
  promoCode: z.string().trim().min(1).optional(),
});

router.post(
  "/intents",
  requireAuth,
  requireFlag("bookings.enabled"),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { listingId, start, end, promoCode } = IntentSchema.parse(req.body);

    // ---- C8: promo validation (explicit error) ----
    if (promoCode) {
      const promo = getEnvPromos().find((p) => p.code === promoCode.trim().toUpperCase());
      if (!promo) {
        return res.status(422).json({ error: { code: "INVALID_PROMO", message: "Unknown promo" } });
      }
    }

    // Load listing (lean for availability + doc for calc)
    const listingLean = await Listing.findById(listingId).lean();
    if (!listingLean || listingLean.status !== "active") {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }

    // Build buckets and ensure a non-empty window
    const { granularity, buckets } = await buildBucketsAndGranularity(listingLean, start, end);
    if (!buckets.length) {
      return res.status(422).json({ error: { code: "INVALID_WINDOW", message: "Empty window" } });
    }

    // Compute authoritative pricing via C8 calculator (tax, fee, promo)
    const listingDoc = await Listing.findById(listingId);
    if (!listingDoc) {
      return res.status(404).json({ error: { code: "LISTING_NOT_FOUND" } });
    }
    const q = await computeQuote({ listing: listingDoc as any, start, end, promoCode });

    if (q.totalCents <= 0) {
      return res.status(422).json({ error: { code: "NO_PRICING" } });
    }

    // Idempotency (include pricing + promo so repeated calls dedupe correctly)
    const idempHeader = String(req.header("X-Idempotency-Key") || "");
    const derived = `pi:rental:${userId}:${listingId}:${start.toISOString()}:${end.toISOString()}:${q.totalCents}:${promoCode ?? ""}`;
    const hash = crypto
      .createHash("sha1")
      .update(idempHeader || derived)
      .digest("hex");
    const cacheKey = key("pi", "intent", hash);

    const r = await redisClient();

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
          // optional niceties for client display:
          amount: q.totalCents,
          currency: q.currency,
          lineItems: q.lineItems,
          taxCents: q.taxCents,
          discountCents: q.discountCents,
        });
      }
    }

    // Resolve hostId from listingDoc and enforce friendship (no money/locks until friends)
    const hostId = String(listingDoc.hostId);
    const guard = await guardFriendshipOrEnsurePending(userId, hostId);
    if (guard) {
      // Mirror your bookings route shape (403 + { error: guard })
      return res.status(403).json({ error: guard });
    }

    const pi = await stripe.paymentIntents.create(
      {
        amount: q.totalCents,
        currency: q.currency || "usd",
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: {
          renterId: userId,
          listingId,
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          totalCents: String(q.totalCents),
          promoCode: promoCode ?? "",
        },
      },
      { idempotencyKey: idempHeader || derived }
    );

    // Try to hold the buckets for 30 minutes tied to this PI
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

    return jsonOk(res, {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret,
      // optional niceties for client display:
      amount: q.totalCents,
      currency: q.currency,
      lineItems: q.lineItems,
      taxCents: q.taxCents,
      discountCents: q.discountCents,
    });
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