// server/src/utils/http.ts
/** Helpers: asyncHandler to bubble errors to express; jsonOk for concise success responses. */

import type { Request, Response, NextFunction, RequestHandler } from "express";

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const jsonOk = (res: Response, body: unknown, status = 200) => {
  res.status(status).json(body);
};
