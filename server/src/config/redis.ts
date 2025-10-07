/** Redis client singleton + ping (Upstash-ready) + namespaced key builder */
import { createClient, type RedisClientType } from "redis";

import { env } from "./env.js";

let client: RedisClientType | null = null;

function getClient(): RedisClientType {
  if (!client) {
    const useTls = env.REDIS_URL?.startsWith("rediss://");

    client = createClient({
      url: env.REDIS_URL,
      socket: {
        tls: useTls, // enable TLS when needed
        connectTimeout: 3000,
        keepAlive: 5000, // prevent idle disconnects
        reconnectStrategy: (retries) => {
          // Backoff retry: wait up to 3s between retries
          const delay = Math.min(retries * 200, 3000);
          console.log(`[redis] reconnecting in ${delay}ms`);
          return delay;
        },
      },
    });

    client.on("error", (e) => {
      console.warn("[redis] client error:", (e as any)?.message || e);
    });

    client.on("connect", () => {
      console.log("[redis] connecting...");
    });

    client.on("ready", () => {
      console.log("[redis] connected and ready ✅");
    });
  }

  return client;
}

export async function redisClient() {
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
