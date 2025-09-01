import express from "express";
import type { Request, Response } from "express";

import { createPersonaSession, handlePersonaWebhook } from "./service.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireKyc } from "../../middlewares/requireKyc.js";

export const kycRouter = express.Router();

/** POST /kyc/sessions (auth) -> { provider, clientToken, inquiryId } */
kycRouter.post("/sessions", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user.sub as string;
  const out = await createPersonaSession(userId);
  return res.json(out);
});

/** Demo protected route to show KYC guard */
kycRouter.get("/protected", requireAuth, requireKyc("verified"), (req, res) => {
  res.json({ ok: true, message: "You are KYC verified 🎉" });
});

/** Persona webhook handler (raw body set in app.ts) */
export const personaWebhook = async (req: Request, res: Response) => {
  try {
    const raw = (req as any).rawBody as Buffer;
    // headers are lowercase in Node
    const headers = req.headers;
    const out = await handlePersonaWebhook(raw, headers);
    return res.status(200).json(out);
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ error: { message: e?.message || "Webhook error" } });
  }
};
