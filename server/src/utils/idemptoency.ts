// server/src/utils/idempotency.ts
// Header-based idempotency with Redis (uses your src/config/redis.ts).
// Stores the exact {status, body} you return the first time, and replays it on repeats.

import type { RedisClientType } from "redis";

import { redisClient } from "../config/redis.js";

type Stored<T> = { status: number; body: T };

// Get a connected client once
async function getClient(): Promise<RedisClientType> {
  const c = redisClient();
  if (!c.isOpen) await c.connect();
  return c;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Idempotent get-or-compute with a small in-flight lock to avoid double-compute.
 * - key: fully-namespaced Redis key (use your key() builder in the caller)
 * - ttlSecs: cache TTL for the stored result
 * - compute: returns { status, body } to persist on first success
 */
export async function getOrSetIdempotent<T>(
  key: string,
  ttlSecs: number,
  compute: () => Promise<Stored<T>>,
  waitForMs = 1500 // how long a concurrent caller waits for the first writer
): Promise<{ value: Stored<T>; replay: boolean }> {
  const client = await getClient();

  // 1) Fast path: already cached
  const cached = await client.get(key);
  if (cached) return { value: JSON.parse(cached), replay: true };

  // 2) Try to grab a short lock (so only one computes)
  const lockKey = `${key}:lock`;
  const lockOk = await client.set(lockKey, "1", { NX: true, PX: 5000 }); // 5s lock
  if (lockOk) {
    try {
      // Double-check after lock (another process might have written between get() and set(NX))
      const again = await client.get(key);
      if (again) return { value: JSON.parse(again), replay: true };

      const value = await compute();
      await client.set(key, JSON.stringify(value), { EX: ttlSecs });
      return { value, replay: false };
    } finally {
      // Best-effort unlock
      await client.del(lockKey).catch(() => {});
    }
  }

  // 3) Someone else is computing → wait briefly for the result
  const start = Date.now();
  while (Date.now() - start < waitForMs) {
    const got = await client.get(key);
    if (got) return { value: JSON.parse(got), replay: true };
    await sleep(75);
  }

  // 4) Fallback: compute (rare race), then store
  const value = await compute();
  await client.set(key, JSON.stringify(value), { EX: ttlSecs });
  return { value, replay: false };
}
