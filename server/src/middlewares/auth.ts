// server/src/middlewares/auth.ts
/** Auth middleware stub: C1 will verify JWT and attach user to res.locals. */

import type { RequestHandler } from "express";

export const requireAuth: RequestHandler = (_req, _res, next) => {
  // TODO in C1 Auth: verify Bearer token and attach user to req/res.locals
  next();
};
