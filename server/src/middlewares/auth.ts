import type { Request, Response, NextFunction } from "express";

import { verifyAccess } from "../modules/auth/tokens.js";
import type { Role } from "../modules/users/model.js";

export type AuthContext = { userId: string; role: Role; jti: string };

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const hdr = req.get("authorization") || req.get("Authorization");
    if (!hdr || !hdr.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: { code: "UNAUTHORIZED", message: "Missing Bearer token" } });
    }
    const token = hdr.slice("Bearer ".length).trim();

    // your verifyAccess already enforces iss/aud/alg/exp and type === 'access'
    const claims = verifyAccess(token);

    (req as any).auth = { userId: claims.sub, role: claims.role, jti: claims.jti };
    next();
  } catch (err: any) {
    return res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: err?.message || "Invalid token" } });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    if (!roles.includes(auth.role)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Insufficient role" } });
    }
    next();
  };
}

export function getAuth(req: Request): AuthContext {
  const ctx = (req as any).auth as AuthContext | undefined;
  if (!ctx) throw new Error("Auth context missing (requireAuth not applied)");
  return ctx;
}
