// server/src/config/env.ts
/** Environment loader: reads .env, validates with Zod, exports typed config and CORS origins array. */
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"]).default("info"),
  // Data layer
  MONGO_URI: z.string().default("mongodb://localhost:27017/fr_dev"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_NAMESPACE: z.string().default("fr:dev"),

  // Auth
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 chars")
    .default("dev_only_change_me"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(16, "JWT_REFRESH_SECRET must be at least 16 chars")
    .default("dev_only_change_me_refresh"),
  JWT_ACCESS_TTL: z.string().default("15m"), // e.g., "15m"
  JWT_REFRESH_TTL: z.string().default("30d"), // e.g., "30d"
  JWT_ISS: z.string().default("fr-api"),
  JWT_AUD: z.string().default("fr-clients"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),
  KYC_PROVIDER: z.string().default("persona"),
  KYC_MOCK: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  PERSONA_API_KEY: z.string().optional().default(""),
  PERSONA_ENV: z.string().default("sandbox"), // sandbox | production
  PERSONA_TEMPLATE_ID: z.string().optional().default(""),
  PERSONA_WEBHOOK_SECRET: z.string().optional().default(""),
  // Media / S3
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_BUCKET: z.string().optional().default(""),
  S3_REGION: z.string().default("us-east-1"),
  CDN_DOMAIN: z.string().optional().default(""),
  S3_KEY_PREFIX: z.string().optional().default("fr"),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  // C8 — Pricing
  TAX_RATE_PCT: z.string().optional(), // e.g. "8.25"
  TAX_RATE_MAP: z.string().optional(), // e.g. "NE:7.5,TX:8.25,IA:7.0"
  TAX_EXEMPT_STATES: z.string().optional(), // e.g. "OR,MT,NH,DE,AK"
  TAXABLE_FEE: z.string().optional(), // "true" | "false" (default true)
  PROMOS: z.string().optional(), // e.g. "SAVE10:percent:10|label=Spring Sale;FLAT5:flat:500"
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Pretty-print Zod issues then exit

  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// parsed CORS allowlist as array
export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ----------------------------
// C8 helper parsers & types
// ----------------------------
export type PromoDef =
  | { code: string; kind: "percent"; value: number; label?: string; enabled: true }
  | { code: string; kind: "flat"; value: number; label?: string; enabled: true };

export function getTaxableFee(): boolean {
  const v = env.TAXABLE_FEE?.toLowerCase();
  if (v === undefined) return true;
  return v !== "false";
}

/** Returns default tax as a decimal (e.g., 0.0825 for "8.25"). */
export function getTaxRateDefault(): number {
  const s = env.TAX_RATE_PCT?.trim();
  if (!s) return 0;
  const pct = Number(s);
  return Number.isFinite(pct) && pct >= 0 ? pct / 100 : 0;
}

/** Parses TAX_RATE_MAP into { NE:0.075, TX:0.0825, ... } */
export function getTaxRateMap(): Record<string, number> {
  const mapStr = env.TAX_RATE_MAP?.trim();
  if (!mapStr) return {};
  const out: Record<string, number> = {};
  for (const pair of mapStr.split(",")) {
    const [stateRaw, pctRaw] = pair.split(":").map((x) => x?.trim());
    if (!stateRaw || !pctRaw) continue;
    const state = stateRaw.toUpperCase();
    const pct = Number(pctRaw);
    if (state && Number.isFinite(pct) && pct >= 0) out[state] = pct / 100;
  }
  return out;
}

/** Parses TAX_EXEMPT_STATES into a Set("OR","MT",...). */
export function getTaxExemptStates(): Set<string> {
  const s = env.TAX_EXEMPT_STATES?.trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
  );
}

/**
 * Parses PROMOS env into an array of promo definitions.
 * Format examples:
 *   SAVE10:percent:10|label=Spring Sale;FLAT5:flat:500|label=$5 off
 */
export function getEnvPromos(): PromoDef[] {
  const src = env.PROMOS?.trim();
  if (!src) return [];
  return src
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [main, ...flags] = chunk.split("|").map((x) => x.trim());
      const [codeRaw, kindRaw, valueRaw] = main.split(":").map((x) => x.trim());
      const code = (codeRaw || "").toUpperCase();
      const kind = (kindRaw || "").toLowerCase() as "percent" | "flat";
      const value = Number(valueRaw);
      const meta: Record<string, string> = {};
      for (const f of flags) {
        const [k, v] = f.split("=").map((x) => x?.trim());
        if (k && v) meta[k] = v;
      }
      if (!code || !Number.isFinite(value) || value < 0) return null;
      if (kind !== "percent" && kind !== "flat") return null;
      const base = { code, label: meta["label"], enabled: true as const };
      return kind === "percent"
        ? ({ ...base, kind, value } as PromoDef)
        : ({ ...base, kind, value } as PromoDef);
    })
    .filter((x): x is PromoDef => Boolean(x));
}
