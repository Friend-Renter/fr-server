// server/src/middlewares/error.ts
/** Global error handler: handles Zod (422) and unexpected errors, emits uniform { error: {…} }. */

import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { logger } from "../config/logger.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = res.locals.requestId;
  // Zod -> 422
  if (err instanceof ZodError) {
    const details = err.flatten();
    logger.warn("Validation error", { requestId, details });
    return res.status(422).json({
      error: { code: "UNPROCESSABLE_ENTITY", message: "Invalid request body", details },
    });
  }

  const status = (err as any).status || 500;
  const code = (err as any).code || (status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR");

  logger.error(err.message || "Unhandled error", {
    requestId,
    status,
    code,
    stack: (err as any).stack,
  });

  res.status(status).json({
    error: { code, message: err.message ?? "Internal server error", requestId },
  });
};
