// server/src/index.ts
/** Boot file: creates HTTP server, starts listening, and handles graceful shutdown. */

import http from "http";

import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";

const server = http.createServer(app);

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { err });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason });
});

const start = async () => {
  server.listen(env.PORT, () => {
    logger.info(`FR server listening on :${env.PORT}`, { env: env.NODE_ENV });
  });
};

const shutdown = (signal: string) => {
  logger.warn(`Received ${signal}, shutting down...`);
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Forced shutdown");
    process.exit(1);
  }, 10_000).unref();
};

["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig as NodeJS.Signals, () => shutdown(sig)));

start();
