// src/modules/flags/routes.ts
import { Router } from "express";
import { z } from "zod";

import { getFlagsDoc, updateFlags } from "./service.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

export const publicRouter = Router();
export const adminRouter = Router();

// GET /flags (public)
publicRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const doc = await getFlagsDoc();
    return jsonOk(res, doc);
  })
);

// POST /admin/flags (admin-only; mount with auth/role upstream)
const BodySchema = z.any(); // validated in service (allowlist + type guard)

adminRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = BodySchema.parse(req.body);
    const actor = {
      id: (req as any)?.auth?.userId,
      email: (req as any)?.auth?.email,
    };
    const doc = await updateFlags(body, actor);
    return jsonOk(res, doc);
  })
);
