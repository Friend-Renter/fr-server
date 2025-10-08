import "dotenv/config";
import mongoose from "mongoose";
import { connectMongo } from "../src/config/db.js";
// Import models to register their schemas with Mongoose in this process
import "../src/modules/users/model";
import "../src/modules/assets/model";
import "../src/modules/listings/model";
import "../src/modules/locks/model";
async function main() {
  await connectMongo();
  const models = ["User", "Asset", "Listing"].map((n) => mongoose.model(n));
  for (const m of models) {
    console.log(`→ syncing indexes for ${m.modelName}...`);
    await m.syncIndexes();
  }
  const db = mongoose.connection.db;
  for (const name of ["users", "assets", "listings", "locks"]) {
    const idx = await db.collection(name).indexes();
    console.log(
      `${name} indexes:`,
      idx.map((i) => i.name)
    );
  }
  await mongoose.disconnect();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
//# sourceMappingURL=sync-indexes.js.map
