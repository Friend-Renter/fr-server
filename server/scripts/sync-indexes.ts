import "dotenv/config";
import mongoose from "mongoose";

import { connectMongo } from "../src/config/db.js";

// import models to register schemas
import "../src/modules/users/model.js";
import "../src/modules/assets/model.js";
import "../src/modules/listings/model.js";

async function main() {
  await connectMongo();

  const models = ["User", "Asset", "Listing"].map((name) => mongoose.model(name));
  for (const m of models) {
    console.log(`→ syncing indexes for ${m.modelName}...`);
    const out = await m.syncIndexes();
    console.log(`  synced ${m.modelName}:`, out);
  }

  const db = mongoose.connection.db;
  for (const c of ["users", "assets", "listings"]) {
    const idx = await db.collection(c).indexes();
    console.log(
      `${c} indexes:`,
      idx.map((i) => i.name)
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
