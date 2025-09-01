/** Mongo connector + ping using Mongoose (Atlas-friendly) */
import mongoose from "mongoose";

import { env } from "./env.js";

let connecting: Promise<void> | null = null;

async function ensureMongo(): Promise<void> {
  if (mongoose.connection.readyState === 1) return; // connected
  if (connecting) return connecting;

  connecting = mongoose
    .connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 3000, // bump to 5000 if your network is slow
    } as any)
    .finally(() => {
      connecting = null;
    });

  await connecting;
}

export async function pingMongo(): Promise<{ status: "ok" | "error"; message?: string }> {
  try {
    await ensureMongo();
    await mongoose.connection.db.admin().command({ ping: 1 });
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
