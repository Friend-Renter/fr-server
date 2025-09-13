// server/src/middlewares/error.ts
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { logger } from "../config/logger.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = res.locals.requestId;

  // Zod (defensive): detect by name/issues, not by internals
  const looksLikeZod =
    err instanceof ZodError ||
    (err && typeof err === "object" && Array.isArray((err as any).issues));

  if (looksLikeZod) {
    let details: unknown = undefined;
    try {
      if (typeof (err as any).flatten === "function") {
        details = (err as any).flatten();
      } else if (Array.isArray((err as any).issues)) {
        details = { issues: (err as any).issues };
      }
    } catch {
      details = undefined;
    }
    logger.warn("Validation error", { requestId, details });
    return res
      .status(422)
      .json({ error: { code: "UNPROCESSABLE_ENTITY", message: "Invalid request body", details } });
  }

  const status = (err as any)?.status || 500;
  const code = (err as any)?.code || (status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR");

  // always log stack if present
  logger.error(err?.message || "Unhandled error", {
    requestId,
    status,
    code,
    stack: (err as any)?.stack,
  });

  res.status(status).json({
    error: { code, message: err?.message ?? "Internal server error", requestId },
  });
};
