import "dotenv/config";
import mongoose from "mongoose";

import { connectMongo } from "../src/config/db";
// ensure models are registered
import "../src/modules/users/model";
import "../src/modules/assets/model";
import "../src/modules/listings/model";
import "../src/modules/locks/model";
import "../src/modules/bookings/model";
import "../src/modules/verifications/model";
import "../src/modules/audit/model.js";
import "../src/modules/features/model.js";

async function main() {
  await connectMongo();

  // 1) Sync model indexes (creates collections if needed)
  const modelNames = [
    "User",
    "Asset",
    "Listing",
    "BookingLock",
    "Booking",
    "Verification",
    "FeatureFlag",
    "AuditLog",
  ] as const;
  for (const modelName of modelNames) {
    const m = mongoose.model(modelName);
    console.log(`→ syncing indexes for ${m.modelName}...`);
    await m.syncIndexes();
  }

  // 2) Print indexes safely (guard for missing collections & avoid 'listIndexes: <nil>')
  const collections = [
    "users",
    "assets",
    "listings",
    "bookinglocks",
    "bookings",
    "verifications",
    "featureflags",
    "auditlogs",
  ] as const;
  const db = mongoose.connection.db!;
  for (const colName of collections) {
    try {
      const exists = await db.listCollections({ name: colName }).hasNext();
      if (!exists) {
        console.log(`${colName}: (no collection yet)`);
        continue;
      }
      const col = db.collection(colName);
      const idx = await col.indexes();
      console.log(
        `${colName} indexes:`,
        idx.map((i) => i.name)
      );
    } catch (e: any) {
      console.log(`${colName}: could not list indexes ->`, e.codeName || e.message);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
