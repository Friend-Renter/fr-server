// server/src/routes.ts
/** API surface: health endpoints now; later mounts feature routers (e.g., /users, /listings). */
import { Router } from "express";

import { asyncHandler, jsonOk } from "./utils/http.js";

export const router = Router();

// Basic health (no deps)
router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const uptime = process.uptime();
    const version = process.env.npm_package_version || "0.0.0";
    jsonOk(res, { status: "ok", uptime, version });
  })
);

// Dependencies health (Mongo/Redis to be wired later)
router.get(
  "/health/deps",
  asyncHandler(async (_req, res) => {
    jsonOk(res, { mongo: "skipped", redis: "skipped" });
  })
);

export default router;
