// server/src/utils/ids.ts
/** Assigns a unique x-request-id to each request for correlation in logs. */

import { randomUUID } from "crypto";

import type { RequestHandler } from "express";

export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  // store on res.locals to avoid extending Request types
  res.locals.requestId = id;
  res.setHeader("x-request-id", id);
  next();
};
