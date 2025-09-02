import express from "express";
import type { Request, Response } from "express";

import { createPersonaSession, handlePersonaWebhook } from "./service.js";
import { env } from "../../config/env.js";
import { requireAuth, getAuth } from "../../middlewares/auth.js";
import { requireKyc } from "../../middlewares/requireKyc.js";

export const kycRouter = express.Router();

/** POST /kyc/sessions (auth) -> { provider, clientToken, inquiryId } */
kycRouter.post("/sessions", requireAuth, async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
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
    // express.raw({ type: 'application/json' }) makes req.body a Buffer
    const raw = Buffer.isBuffer(req.body)
      ? (req.body as Buffer)
      : Buffer.from(JSON.stringify(req.body ?? {}), "utf8");

    // headers are lowercase in Node
    const headers = req.headers;
    const out = await handlePersonaWebhook(raw, headers);
    return res.status(200).json(out);
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ error: { message: e?.message || "Webhook error" } });
  }
};
