import type { Request, Response, NextFunction } from "express";

import { getAuth } from "./auth.js";
import { User } from "../modules/users/model.js";
/**
 * Require that req.user exists (Auth middleware) AND user.kycStatus meets min.
 * We assume req.user is populated by auth middleware and includes kycStatus.
 * If your auth middleware does not add kycStatus, you can fetch from DB here — for now we keep it simple.
 */
export function requireKyc(min: "verified" | "pending" = "verified") {
  const order = ["unverified", "pending", "verified"] as const;
  const rank = (s: any) => {
    const i = order.indexOf(s);
    return i === -1 ? 0 : i;
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    let auth;
    try {
      auth = getAuth(req); // throws if requireAuth wasn't run
    } catch {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Auth required" } });
    }

    let status = (auth as any).kycStatus; // if you decide to embed later
    if (!status) {
      const u = await User.findById(auth.userId).select("kycStatus").lean();
      status = u?.kycStatus || "unverified";
      (req as any).auth.kycStatus = status; // cache for downstream
    }

    if (rank(status) < rank(min)) {
      return res
        .status(403)
        .json({ error: { code: "KYC_REQUIRED", message: `KYC ${min} required` } });
    }
    next();
  };
}
