/** Refresh-session storage in Redis: persist, check, revoke. */
import type { RedisClientType } from "redis";

import { redisClient, key } from "../../config/redis.js";

function sessionKey(userId: string, jti: string) {
  return key("sess", userId, jti); // e.g., fr:dev:sess:<uid>:<jti>
}

function ttlFromExp(exp?: number): number {
  const now = Math.floor(Date.now() / 1000);
  const ttl = typeof exp === "number" ? exp - now : 0;
  return Math.max(ttl, 1);
}

export async function persistSession(args: {
  userId: string;
  jti: string;
  exp?: number; // seconds since epoch (from JWT)
  iat?: number; // seconds since epoch (from JWT)
  ip?: string | null;
  ua?: string | null;
}) {
  const c = await redisClient();

  const k = sessionKey(args.userId, args.jti);
  const v = JSON.stringify({
    uid: args.userId,
    jti: args.jti,
    ip: args.ip || null,
    ua: args.ua || null,
    iat: args.iat || null,
    exp: args.exp || null,
  });
  await c.set(k, v, { EX: ttlFromExp(args.exp) });
}

export async function isSessionActive(userId: string, jti: string): Promise<boolean> {
  const c = await redisClient();

  const exists = await c.exists(sessionKey(userId, jti));
  return exists === 1;
}

export async function revokeSession(userId: string, jti: string): Promise<void> {
  const c = await redisClient();

  await c.del(sessionKey(userId, jti));
}

// (Optional) revoke all for a user — not used yet, but handy later
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const c = await redisClient();

  const prefix = key("sess", userId, ""); // fr:dev:sess:<uid>:
  const iter = c.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 });

  let count = 0;
  for await (const k of iter as any) {
    await c.del(k as string);
    count++;
  }
  return count;
}
