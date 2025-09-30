// src/middlewares/flags.ts
import type { Request, Response, NextFunction } from "express";

import { getFlag } from "../modules/flags/service.js";

export function requireFlag(
  path:
    | "bookings.enabled"
    | "messaging.enabled"
    | "checkin.enabled"
    | "checkout.enabled"
    | "uploads.enabled"
) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ok = await getFlag(path);
      if (!ok) {
        const feature = path.split(".")[0];
        return res.status(423).json({
          error: { code: "FEATURE_DISABLED", feature },
        });
      }
      return next();
    } catch (e: any) {
      // Fail-open if something unexpected happens in the guard itself
      return next();
    }
  };
}
