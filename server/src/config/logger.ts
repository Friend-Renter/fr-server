// server/src/config/logger.ts
/** Winston logger: JSON output, PII redaction, and stream for morgan (dev HTTP logs). */
import { createLogger, format, transports } from "winston";

import { env } from "./env.js";

const redact = (obj: Record<string, unknown>) => {
  const clone = { ...obj };
  // redact common sensitive keys if they appear
  for (const key of Object.keys(clone)) {
    if (/authorization|password|token|secret/i.test(key)) {
      clone[key] = "[redacted]";
    }
  }
  return clone;
};

export const logger = createLogger({
  level: env.LOG_LEVEL,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf((info) => {
      const { timestamp, level, message, ...rest } = info as Record<string, any>;
      const payload = { timestamp, level, message, ...redact(rest) };
      return JSON.stringify(payload);
    })
  ),
  transports: [new transports.Console()],
});

// tiny helper for morgan stream
export const httpLogStream = {
  write: (line: string) => logger.info(line.trim(), { source: "http" }),
};
