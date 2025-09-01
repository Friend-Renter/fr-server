import type { Request, Response, NextFunction } from "express";

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
    const auth = (req as any).user;
    if (!auth) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Auth required" } });
    }

    let status = auth.kycStatus;
    if (!status) {
      // Fallback: fetch once if JWT didn't include it
      const u = await User.findById(auth.sub).select("kycStatus").lean();
      status = u?.kycStatus || "unverified";
      // Optionally cache onto req for downstream
      (req as any).user.kycStatus = status;
    }

    if (rank(status) < rank(min)) {
      return res
        .status(403)
        .json({ error: { code: "KYC_REQUIRED", message: `KYC ${min} required` } });
    }
    next();
  };
}
