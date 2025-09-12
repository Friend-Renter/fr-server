// server/src/routes.ts
/** API surface: health endpoints now; later mounts feature routers (e.g., /users, /listings). */
import { Router } from "express";

import { pingMongo } from "./config/db.js";
import { pingRedis } from "./config/redis.js";
import adminRouter from "./modules/admin/routes.js";
import authRouter from "./modules/auth/routes.js";
import usersRouter from "./modules/users/routes.js";
import { kycRouter, personaWebhook } from "./modules/verifications/http.js";
import { asyncHandler, jsonOk } from "./utils/http.js";

export const router = Router();

router.use("/auth", authRouter);
router.use("/", usersRouter); // exposes GET /me
router.use("/kyc", kycRouter);
router.use("/admin", adminRouter);

// Basic health (no deps)
router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const uptime = process.uptime();
    const version = process.env.npm_package_version || "0.0.0";
    jsonOk(res, { status: "ok", uptime, version });
  })
);

// Dependencies health (actual pings)
router.get(
  "/health/deps",
  asyncHandler(async (_req, res) => {
    const [mongo, redis] = await Promise.all([pingMongo(), pingRedis()]);
    const result: any = { mongo: mongo.status, redis: redis.status };
    if (mongo.status === "error" || redis.status === "error") {
      result.details = { mongo: mongo.message, redis: redis.message };
    }
    jsonOk(res, result);
  })
);

export default router;
