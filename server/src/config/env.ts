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
