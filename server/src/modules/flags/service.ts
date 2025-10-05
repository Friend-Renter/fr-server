// src/modules/flags/service.ts
import { z } from "zod";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { key, redisClient } from "../../config/redis.js";

export type Flags = {
  bookings: { enabled: boolean };
  messaging: { enabled: boolean };
  checkin: { enabled: boolean };
  checkout: { enabled: boolean };
  uploads: { enabled: boolean };
  listings: { enabled: boolean };
  pricing: { enabled: boolean };
};

export type FlagsDoc = { flags: Flags; updatedAt: string };

const ALLOW = [
  "bookings.enabled",
  "messaging.enabled",
  "checkin.enabled",
  "checkout.enabled",
  "uploads.enabled",
  "listings.enabled",
  "pricing.enabled",
] as const;
const ALLOW_SET = new Set<string>(ALLOW);

const TTL_MS = 10_000; // in-process cache TTL

let cache: { value: FlagsDoc | null; at: number } = { value: null, at: 0 };

function allTrue(): Flags {
  return {
    bookings: { enabled: true },
    messaging: { enabled: true },
    checkin: { enabled: true },
    checkout: { enabled: true },
    uploads: { enabled: true },
    listings: { enabled: true },
    pricing: { enabled: true },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function nestedFromDotEnv(jsonStr?: string | null): Partial<Flags> | null {
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || typeof obj !== "object") return null;
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!ALLOW_SET.has(k)) continue;
      if (typeof v !== "boolean") continue;
      const [root, leaf] = String(k).split(".");
      out[root] = out[root] || {};
      out[root][leaf] = v;
    }
    return out as Partial<Flags>;
  } catch {
    return null;
  }
}

function mergeFlags(base: Flags, patch: Partial<Flags>): Flags {
  const out: Flags = JSON.parse(JSON.stringify(base));
  (Object.keys(patch) as Array<keyof Flags>).forEach((k) => {
    if (!patch[k]) return;
    out[k] = { ...(out[k] as any), ...(patch[k] as any) };
  });
  return out;
}

/** Flatten nested object into dot-path booleans; reject unknowns/types. */
function toDotBooleanPatch(input: unknown): Record<string, boolean> {
  const fail = (msg: string, details?: unknown) => {
    const e: any = new Error(msg);
    e.status = 400;
    e.code = "INVALID_FLAG";
    if (details) e.details = details;
    throw e;
  };

  if (!input || typeof input !== "object") {
    fail("Body must be an object.");
  }

  const dot: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k.includes(".")) {
      // dot-path form: { "bookings.enabled": true }
      if (!ALLOW_SET.has(k)) fail("Unknown flag key", { key: k });
      if (typeof v !== "boolean") fail("Flag value must be boolean", { key: k, value: v });
      dot[k] = v;
    } else if (typeof v === "object" && v !== null) {
      // nested form: { bookings: { enabled: true } }
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const path = `${k}.${k2}`;
        if (!ALLOW_SET.has(path)) fail("Unknown flag key", { key: path });
        if (typeof v2 !== "boolean") fail("Flag value must be boolean", { key: path, value: v2 });
        dot[path] = v2;
      }
    } else {
      fail("Invalid flag structure", { key: k, value: v });
    }
  }
  return dot;
}

function applyDotPatch(base: Flags, dotPatch: Record<string, boolean>): Flags {
  let next = { ...base };
  for (const [path, val] of Object.entries(dotPatch)) {
    const [root, leaf] = path.split(".");
    next = {
      ...next,
      [root]: { ...(next as any)[root], [leaf]: val },
    } as Flags;
  }
  return next;
}

async function readFromRedis(): Promise<FlagsDoc | null> {
  const r = redisClient();
  if (!r.isOpen) await r.connect();
  const raw = await r.get(key("flags"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.flags) return null;
    // quick sanity check
    for (const p of ALLOW) {
      const [root, leaf] = p.split(".");
      if (typeof parsed.flags?.[root]?.[leaf] !== "boolean") {
        return null;
      }
    }
    return parsed as FlagsDoc;
  } catch {
    return null;
  }
}

async function writeToRedis(doc: FlagsDoc): Promise<void> {
  const r = redisClient();
  if (!r.isOpen) await r.connect();
  await r.set(key("flags"), JSON.stringify(doc));
}

export async function ensureFlagsSeeded(): Promise<void> {
  try {
    const existing = await readFromRedis();
    if (existing) return;
    const envPatch = nestedFromDotEnv((env as any["FLAGS_DEFAULT"]) ?? (env as any).FLAGS_DEFAULT);
    const flags = mergeFlags(allTrue(), envPatch || {});
    const doc: FlagsDoc = { flags, updatedAt: nowIso() };
    await writeToRedis(doc);
    cache = { value: doc, at: Date.now() };
    logger.info("flags.seeded", { from: envPatch ? "ENV_DEFAULTS" : "ALL_TRUE" });
  } catch (e: any) {
    logger.warn("flags.seed_failed", { error: e?.message || String(e) });
  }
}

export async function getFlagsDoc(): Promise<FlagsDoc> {
  const fresh = cache.value && Date.now() - cache.at < TTL_MS;
  if (fresh && cache.value) {
    logger.debug?.("flags.read", { cacheHit: true });
    return cache.value;
  }

  try {
    const fromRedis = await readFromRedis();
    if (fromRedis) {
      cache = { value: fromRedis, at: Date.now() };
      logger.debug?.("flags.read", { cacheHit: false });
      return fromRedis;
    }
  } catch (e: any) {
    logger.warn("flags.read_error", { error: e?.message || String(e) });
  }

  // Fallbacks
  const envPatch = nestedFromDotEnv((env as any["FLAGS_DEFAULT"]) ?? (env as any).FLAGS_DEFAULT);
  const flags = mergeFlags(allTrue(), envPatch || {});
  const doc: FlagsDoc = { flags, updatedAt: nowIso() };
  if (!cache.value) cache = { value: doc, at: Date.now() }; // cold cache
  return doc;
}

export async function updateFlags(patchInput: unknown, actor?: { id?: string; email?: string }) {
  const dotPatch = toDotBooleanPatch(patchInput);
  const current = await getFlagsDoc();
  const nextFlags = applyDotPatch(current.flags, dotPatch);
  const doc: FlagsDoc = { flags: nextFlags, updatedAt: nowIso() };
  await writeToRedis(doc);
  cache = { value: doc, at: Date.now() };

  const diff = Object.entries(dotPatch).map(([path, v]) => ({
    path,
    from: path.split(".").reduce((acc: any, seg) => (acc ? acc[seg] : undefined), current.flags),
    to: v,
  }));

  logger.info("flags.write", {
    actorId: actor?.id,
    actorEmail: actor?.email,
    diff,
    updatedAt: doc.updatedAt,
  });

  return doc;
}

export async function getFlag(path: (typeof ALLOW)[number]): Promise<boolean> {
  const doc = await getFlagsDoc();
  const [root, leaf] = path.split(".");
  return Boolean((doc.flags as any)?.[root]?.[leaf]);
}

export async function getFlagsSnapshotCompact(): Promise<Record<string, boolean>> {
  const d = await getFlagsDoc();
  return {
    bookings: d.flags.bookings.enabled,
    msg: d.flags.messaging.enabled,
    in: d.flags.checkin.enabled,
    out: d.flags.checkout.enabled,
    up: d.flags.uploads.enabled,
  };
}
