import "dotenv/config";
import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGO_URI!;
  if (!uri) throw new Error("MONGO_URI missing");

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const listings = db.collection("listings");
  const assets = db.collection("assets");

  // Find listings missing a location.point
  const cursor = listings.find(
    { $or: [{ location: { $exists: false } }, { "location.point": { $exists: false } }] },
    { projection: { _id: 1, assetId: 1, location: 1 } }
  );

  let scanned = 0;
  let updated = 0;

  while (await cursor.hasNext()) {
    const l = await cursor.next();
    if (!l) break;
    scanned++;

    const assetId = l.assetId;
    if (!assetId) continue;

    const a = await assets.findOne({ _id: assetId }, { projection: { location: 1 } });

    const point = (a as any)?.location;
    if (
      point &&
      point.type === "Point" &&
      Array.isArray(point.coordinates) &&
      point.coordinates.length === 2
    ) {
      const res = await listings.updateOne({ _id: l._id }, { $set: { "location.point": point } });
      if (res.modifiedCount) updated++;
    }
  }

  console.log(JSON.stringify({ scanned, updated }, null, 2));
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
