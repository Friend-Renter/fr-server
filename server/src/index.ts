// server/src/index.ts
/** Boot file: creates HTTP server, starts listening, and handles graceful shutdown. */

import http from "http";

import app from "./app.js";
import { connectMongo, closeMongo } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { pingRedis, closeRedis } from "./config/redis.js";

const server = http.createServer(app);

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { err });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason });
});

const start = async () => {
  try {
    // 🔌 ensure data deps are up before listening
    await connectMongo();
    await pingRedis();

    server.listen(env.PORT, () => {
      logger.info(`FR server listening on :${env.PORT}`, { env: env.NODE_ENV });
    });
  } catch (err: any) {
    logger.error("Startup failed", { message: err?.message, stack: err?.stack });
    process.exit(1);
  }
};

const shutdown = (signal: string) => {
  logger.warn(`Received ${signal}, shutting down...`);
  Promise.allSettled([closeMongo(), closeRedis()]).finally(() => {
    server.close(() => {
      logger.info("Server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Forced shutdown");
      process.exit(1);
    }, 10_000).unref();
  });
};

["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig as NodeJS.Signals, () => shutdown(sig)));

start();
