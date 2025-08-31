// server/src/middlewares/notFound.ts
/** 404 handler for unmatched routes -> uniform error payload. */

import type { RequestHandler } from "express";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.originalUrl} not found` },
  });
};
