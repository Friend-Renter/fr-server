/** Redis client singleton + ping (Upstash-ready) + namespaced key builder */
import { createClient, type RedisClientType } from "redis";

import { env } from "./env.js";

let client: RedisClientType | null = null;

function getClient(): RedisClientType {
  if (!client) {
    client = createClient({
      url: env.REDIS_URL,
      socket: { connectTimeout: 2000 },
    });
    client.on("error", (e) => {
      // Avoid noisy unhandled errors; health endpoint will report status instead.
       
      console.warn("[redis] client error:", (e as any)?.message || e);
    });
  }
  return client;
}

/** Build a namespaced Redis key: e.g., fr:dev:rate:ip:1.2.3.4 */
export function key(...parts: Array<string | number>): string {
  return `${env.REDIS_NAMESPACE}:${parts.join(":")}`;
}

export async function pingRedis(): Promise<{ status: "ok" | "error"; message?: string }> {
  const c = getClient();
  try {
    if (!c.isOpen) await c.connect();
    await c.ping();
    return { status: "ok" };
  } catch (err: any) {
    return { status: "error", message: err?.message || String(err) };
  }
}

export async function closeRedis() {
  if (client?.isOpen) {
    await client.quit();
  }
}
