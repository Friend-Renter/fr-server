// server/src/middlewares/rateLimit.ts
/** Simple in-memory IP rate limiter (window, max). Redis-backed version will replace this later. */

import type { RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export const rateLimit = (opts?: { windowMs?: number; max?: number }): RequestHandler => {
  const windowMs = opts?.windowMs ?? 15_000; // 15s window
  const max = opts?.max ?? 100; // 100 reqs per window
  return (req, res, next) => {
    const key = req.ip || req.headers["x-forwarded-for"]?.toString() || "unknown";
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    res.setHeader("x-ratelimit-limit", String(max));
    res.setHeader("x-ratelimit-remaining", String(Math.max(0, max - b.count)));
    res.setHeader("x-ratelimit-reset", String(Math.floor(b.resetAt / 1000)));
    if (b.count > max)
      return res
        .status(429)
        .json({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    next();
  };
};
