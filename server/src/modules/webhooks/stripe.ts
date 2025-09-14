import express from "express";

import { env } from "../../config/env.js";
import { key, redisClient } from "../../config/redis.js";
import { stripe } from "../../lib/stripe.js";
import { asyncHandler } from "../../utils/http.js";
import { Booking } from "../bookings/model.js";
import { unlockByReason } from "../locks/service.js";

const router = express.Router();

// NOTE: must be mounted with express.raw({ type: 'application/json' })
router.post(
  "/stripe",
  asyncHandler(async (req, res) => {
    const sig = req.header("Stripe-Signature") || "";
    let evt: any;
    try {
      evt = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const seenKey = key("stripe", "evt", String(evt.id));
    const r = redisClient();
    if (!r.isOpen) await r.connect();
    const set = await r.set(seenKey, "1", { NX: true, EX: 60 * 60 * 24 * 7 });
    if (set !== "OK") {
      return res.status(200).send("ok"); // already processed
    }
    if (set !== "OK") return res.status(200).send("ok");

    switch (evt.type) {
      case "payment_intent.succeeded": {
        const pi = evt.data.object;
        const booking = await Booking.findOne({ "paymentRefs.rentalIntentId": pi.id });
        if (booking) {
          booking.paymentStatus = "paid";
          if (!booking.paymentRefs?.chargeId && pi.latest_charge) {
            booking.paymentRefs = booking.paymentRefs || {};
            booking.paymentRefs.chargeId =
              typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
          }
          await booking.save();
        }
        break;
      }
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        const pi = evt.data.object;
        const listingId = pi.metadata?.listingId;
        if (listingId) {
          try {
            await unlockByReason(listingId, `pi:${pi.id}`);
          } catch {}
        }
        break;
      }
      default:
        break;
    }

    return res.status(200).send("ok");
  })
);

export default router;
