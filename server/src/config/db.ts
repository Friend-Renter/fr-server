/** Mongo connector + ping using Mongoose (Atlas-friendly) */
import mongoose from "mongoose";

import { env } from "./env.js";

let connecting: Promise<void> | null = null;

export async function connectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(env.MONGO_URI, { serverSelectionTimeoutMS: 3000 } as any)
    .then(() => {}) // ensure Promise<void>
    .finally(() => {
      connecting = null;
    });

  await connecting;
}

export async function pingMongo(): Promise<{ status: "ok" | "error"; message?: string }> {
  try {
    await connectMongo();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Mongo connection not ready");
    await db.admin().command({ ping: 1 });
    return { status: "ok" };
  } catch (err: any) {
    return { status: "error", message: err?.message || String(err) };
  }
}

export async function closeMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
