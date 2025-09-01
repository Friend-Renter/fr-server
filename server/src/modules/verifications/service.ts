import mongoose from "mongoose";

import { Verification, type VerificationDoc } from "./model.js";
import { connectMongo } from "../../config/db.js";
import { env } from "../../config/env.js";
import { User } from "../users/model.js";

function mapPersonaToOurStatus(
  eventType: string,
  personaStatus?: string
): "pending" | "verified" | "failed" | "rejected" {
  // very simple mapping; refine later if needed
  if (eventType === "inquiry.created") return "pending";
  if (eventType === "inquiry.completed") {
    if (personaStatus && ["approved", "passed", "completed"].includes(personaStatus))
      return "verified";
    return "failed";
  }
  if (eventType === "inquiry.failed") return "failed";
  if (eventType === "inquiry.declined") return "rejected";
  return "pending";
}

export async function createPersonaSession(
  userId: string
): Promise<{ provider: "persona"; clientToken: string; inquiryId: string }> {
  await connectMongo();

  if (env.KYC_MOCK || !env.PERSONA_API_KEY) {
    const inquiryId = `mock-${userId}-${Date.now()}`;
    const v = await Verification.findOneAndUpdate(
      { provider: "persona", externalId: inquiryId },
      {
        $setOnInsert: {
          userId: new mongoose.Types.ObjectId(userId),
          provider: "persona",
          externalId: inquiryId,
          status: "pending",
        },
        $push: { events: { type: "inquiry.created", at: new Date(), raw: { mock: true } } },
      },
      { upsert: true, new: true }
    ).exec();

    // leave user.kycStatus as-is (unverified) until webhook marks verified
    return { provider: "persona", clientToken: `mock-${userId}`, inquiryId: v.externalId };
  }

  // Live flow placeholder; wire real Persona call later
  throw Object.assign(new Error("Persona live mode not configured"), {
    code: "KYC_NOT_CONFIGURED",
  });
}

/** Payload can be from Persona or our mock. Idempotent. */
export async function handlePersonaWebhook(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>
) {
  await connectMongo();

  const text = raw.toString("utf8");
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }

  // In real mode you'd verify HMAC here using env.PERSONA_WEBHOOK_SECRET
  // Skipped in mock mode to keep dev friction low.

  // Try to extract identifiers from common Persona shapes
  const eventType: string =
    body?.event || body?.type || body?.data?.attributes?.event_name || "inquiry.completed";
  const externalId: string =
    body?.data?.id ||
    body?.inquiry?.id ||
    body?.data?.attributes?.inquiry_id ||
    body?.inquiry_id ||
    "";
  const referenceUserId: string | undefined =
    body?.data?.attributes?.reference_id || body?.meta?.reference_id || body?.reference_id;

  const personaStatus: string | undefined =
    body?.data?.attributes?.status || body?.payload?.status || body?.status;

  if (!externalId) {
    throw Object.assign(new Error("Missing inquiry id"), { status: 400 });
  }

  const newStatus = mapPersonaToOurStatus(eventType, personaStatus);

  // Upsert verification, attach userId if we have reference_id
  const update: any = {
    $set: { status: newStatus },
    $push: { events: { type: eventType, at: new Date(), raw: body } },
  };
  if (referenceUserId) {
    update.$set.userId = new mongoose.Types.ObjectId(referenceUserId);
  }

  const v = await Verification.findOneAndUpdate({ provider: "persona", externalId }, update, {
    upsert: true,
    new: true,
  }).exec();

  // If we know which user this belongs to, update their status
  const userId = v.userId?.toString() || referenceUserId;
  if (userId) {
    await User.findByIdAndUpdate(
      userId,
      { $set: { kycStatus: newStatus, kycUpdatedAt: new Date() } },
      { new: false }
    ).exec();
  }

  return { ok: true, status: newStatus };
}
