// server/src/app.ts
/** Express app wiring: security (helmet), CORS allowlist, parsers, logging, rate limit, routes, 404 + error. */
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { corsOrigins } from "./config/env.js";
import { httpLogStream, logger } from "./config/logger.js";
import { errorHandler } from "./middlewares/error.js";
import { notFound } from "./middlewares/notFound.js";
import { rateLimit } from "./middlewares/rateLimit.js";
import router from "./routes.js";
import { requestId } from "./utils/ids.js";

const app = express();

// security + parsing
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// request id first
app.use(requestId);

// CORS allowlist
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow same-origin/local tools
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed"), false);
    },
    credentials: true,
  })
);

// dev http logs
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("tiny", { stream: httpLogStream }));
} else {
  // minimal prod startup log
  logger.info("HTTP logger disabled in production; relying on app logs");
}

// basic rate limit
app.use(rateLimit());

// mount routes
app.use("/", router);

// 404 + error
app.use(notFound);
app.use(errorHandler);

export default app;
