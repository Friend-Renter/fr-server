import type { Request, Response, NextFunction } from "express";

type Options = { windowMs: number; max: number; message?: string };

const buckets = new Map<string, number[]>();

export function rateLimitIP(opts: Options) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const windowStart = now - opts.windowMs;

    const arr = buckets.get(key) ?? [];
    // drop old timestamps
    const recent = arr.filter((t) => t > windowStart);
    recent.push(now);
    buckets.set(key, recent);

    if (recent.length > opts.max) {
      const retrySec = Math.ceil((recent[0] + opts.windowMs - now) / 1000);
      return res.status(429).json({
        error: {
          code: "RATE_LIMIT",
          message: opts.message || "Too many attempts, try again later.",
          retryAfterSeconds: Math.max(retrySec, 1),
        },
      });
    }
    next();
  };
}
