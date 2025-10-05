import apn from "@parse/node-apn";
import admin from "firebase-admin";
import { Types } from "mongoose";

import { DeviceToken } from "./deviceModel.js";
import { Notification, type NotificationDoc, type NotificationType } from "./model.js";
import { pushConfig } from "../../config/env.js";
import { logger } from "../../config/logger.js";

let fcmReady = false;
let apnsProvider: apn.Provider | null = null;

function initFCM() {
  if (fcmReady) return;
  const { projectId, clientEmail, privateKey } = pushConfig.fcm;
  if (!projectId || !clientEmail || !privateKey) return;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }
  fcmReady = true;
  logger.info("notifications.fcm_initialized");
}

function initAPNs() {
  if (apnsProvider) return;
  const { teamId, keyId, p8, bundleId } = pushConfig.apns;
  if (!teamId || !keyId || !p8 || !bundleId) return;

  apnsProvider = new apn.Provider({
    token: { key: p8, keyId, teamId },
    production: pushConfig.apns.env === "prod",
  });
  logger.info("notifications.apns_initialized", { env: pushConfig.apns.env });
}

type NotifyInput = {
  userId: string;
  type: NotificationType;
  actor?: { id: string; name?: string; avatarUrl?: string };
  context?: NotificationDoc["context"];
  uniqKey?: string;
  badgeCountHint?: number; // optional precomputed unread count
};

/** Persist + push to all devices (best-effort). */
export async function notify(input: NotifyInput) {
  const userId = new Types.ObjectId(input.userId);

  // 1) Upsert/persist
  let doc: NotificationDoc | null = null;
  if (input.uniqKey) {
    doc =
      (await Notification.findOneAndUpdate(
        { uniqKey: input.uniqKey },
        {
          $setOnInsert: {
            userId,
            type: input.type,
            actor: input.actor || null,
            context: input.context || null,
            uniqKey: input.uniqKey,
          },
        },
        { new: true, upsert: true }
      )) || null;
  } else {
    doc = await Notification.create({
      userId,
      type: input.type,
      actor: input.actor || null,
      context: input.context || null,
      uniqKey: null,
    });
  }

  // 2) Compute unread badge if not provided
  const unread =
    typeof input.badgeCountHint === "number"
      ? input.badgeCountHint
      : await Notification.countDocuments({ userId, readAt: null });

  // 3) Lookup device tokens
  const tokens = await DeviceToken.find({ userId }).lean();
  if (!tokens.length) {
    logger.info("notifications.no_devices", { userId: String(userId) });
    return doc;
  }

  // 4) Init providers lazily
  initFCM();
  initAPNs();

  // 5) Send platform-specific
  const titleMap: Record<NotificationType, string> = {
    "friend.request_created": "New friend request",
    "friend.request_accepted": "Friend request accepted",
    "booking.request_created": "New booking request",
    "booking.request_accepted": "Booking request accepted",
    "booking.request_declined": "Booking request declined",
  };

  const body = input.actor?.name
    ? `${titleMap[input.type]} from/to ${input.actor.name}`
    : titleMap[input.type];

  const data = {
    type: input.type,
    ...(input.context?.requestId ? { requestId: input.context.requestId } : {}),
    ...(input.context?.bookingRequestId
      ? { bookingRequestId: input.context.bookingRequestId }
      : {}),
    ...(input.context?.bookingId ? { bookingId: input.context.bookingId } : {}),
    ...(input.context?.listingId ? { listingId: input.context.listingId } : {}),
  };

  // FCM (android)
  const fcmTokens = tokens.filter((t) => t.platform === "android").map((t) => t.token);
  if (fcmTokens.length) {
    if (fcmReady) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: fcmTokens,
          notification: { title: titleMap[input.type], body },
          data,
          android: { notification: { sound: "default" } },
          apns: { payload: { aps: { badge: unread, sound: "default" } } },
        });
      } catch (e: any) {
        logger.warn("notifications.fcm_error", { error: e?.message || String(e) });
      }
    } else {
      logger.info("notifications.fcm_skipped_not_configured", { count: fcmTokens.length });
    }
  }

  // APNs (ios)
  const iosTokens = tokens.filter((t) => t.platform === "ios").map((t) => t.token);
  if (iosTokens.length) {
    if (apnsProvider) {
      try {
        const note = new apn.Notification();
        note.topic = pushConfig.apns.bundleId;
        note.alert = { title: titleMap[input.type], body };
        note.sound = "default";
        note.badge = unread;
        note.payload = data;

        await Promise.allSettled(iosTokens.map((tok) => apnsProvider!.send(note, tok)));
      } catch (e: any) {
        logger.warn("notifications.apns_error", { error: e?.message || String(e) });
      }
    } else {
      logger.info("notifications.apns_skipped_not_configured", { count: iosTokens.length });
    }
  }

  return doc;
}

export async function unreadCount(userId: string) {
  return Notification.countDocuments({ userId: new Types.ObjectId(userId), readAt: null });
}
