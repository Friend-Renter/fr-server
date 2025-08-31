// server/src/config/env.ts
/** Environment loader: reads .env, validates with Zod, exports typed config and CORS origins array. */
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"]).default("info"),
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
