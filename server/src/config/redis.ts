/** Redis client singleton + ping (Upstash-ready) + namespaced key builder */
import { createClient, type RedisClientType } from "redis";

import { env } from "./env.js";

let client: RedisClientType | null = null;

function getClient(): RedisClientType {
  if (!client) {
    const url = env.REDIS_URL;
    const isTls = url.startsWith("rediss://");

    client = createClient({
      url,
      socket: {
        connectTimeout: 3000,
        keepAlive: true,
        reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
      },
      ...(isTls ? { tls: {} } : {}), // ✅ put tls at top-level, not under socket
    });

    client.on("error", (e) => {
      console.warn("[redis] client error:", (e as any)?.message || e);
    });

    client.on("connect", () => console.log("[redis] connecting..."));
    client.on("ready", () => console.log("[redis] ready ✅"));
  }

  return client;
}

export async function redisClient(): Promise<RedisClientType> {
  const c = getClient();
  if (!c.isOpen) await c.connect();
  return c;
}

export function key(...parts: Array<string | number>): string {
  return `${env.REDIS_NAMESPACE}:${parts.join(":")}`;
}

export async function pingRedis(): Promise<{ status: "ok" | "error"; message?: string }> {
  try {
    const c = await redisClient();
    await c.ping();
    return { status: "ok" };
  } catch (err: any) {
    return { status: "error", message: err?.message || String(err) };
  }
}

export async function closeRedis() {
  if (client?.isOpen) await client.quit();
}