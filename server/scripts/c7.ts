// scripts/c7.ts
// Dev CLI to taste C7 (check-in / check-out) end-to-end without touching your main CLI.
// Usage:
//   tsx scripts/c7.ts checkin  --id <BID> --as renter|host [--photo URL ...] [--notes "..."] [--readings "odometer=41235,odometerUnit=mi,fuelPercent=85"]
//   tsx scripts/c7.ts checkout --id <BID> --as renter|host [--photo URL ...] [--notes "..."] [--readings "..."]
//   tsx scripts/c7.ts test:happy --id <BID>
//   tsx scripts/c7.ts test:checkout-before-checkin --id <BID> --as renter
//   tsx scripts/c7.ts test:idempotent-checkin --id <BID> --as renter
//   tsx scripts/c7.ts test:idempotent-checkout --id <BID> --as renter
//   tsx scripts/c7.ts test:window-early-checkin --id <BID> --as renter --minutes 60
//   tsx scripts/c7.ts test:too-many-photos --id <BID> --as renter
//   tsx scripts/c7.ts test:bad-photo-url --id <BID> --as renter

import "dotenv/config";
import mongoose from "mongoose";

import { Booking } from "../src/modules/bookings/model.js";
import { checkIn, checkOut } from "../src/modules/bookings/service.js";

/** -------------------- tiny argv parser (no deps) -------------------- */
type Argv = {
  _: string[];
  [k: string]: string | number | string[] | undefined;
};
function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = "true";
        i += 1;
      } else {
        // allow repeated flags -> array
        const val = next;
        if (out[key] === undefined) out[key] = val;
        else if (Array.isArray(out[key])) (out[key] as string[]).push(val);
        else out[key] = [out[key] as string, val];
        i += 2;
      }
    } else {
      out._.push(t);
      i += 1;
    }
  }
  return out;
}

/** -------------------- helpers -------------------- */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v as string[]) : [String(v)];
}
function nowIso() {
  return new Date().toISOString();
}

function parseReadings(input?: string) {
  if (!input) return undefined;
  const r: Record<string, unknown> = {};
  for (const pair of input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [k, vRaw] = pair.split("=").map((s) => s.trim());
    if (!k) continue;
    const asNum = Number(vRaw);
    const isNum = vRaw !== "" && !Number.isNaN(asNum) && /^[+-]?\d+(\.\d+)?$/.test(vRaw);
    r[k] = isNum ? asNum : vRaw;
  }
  return r;
}

function parsePhotos(p?: string | string[]) {
  if (!p) return undefined;
  const arr = Array.isArray(p) ? p : [p];
  return arr.map((url) => ({ url }));
}

function envMongoUri(): string {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.MONGO_URI ||
    "mongodb://127.0.0.1:27017/friendrenter_dev"
  );
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

/** Pretty result */
function printResult(label: string, obj: any) {
  console.log(`\n=== ${label} @ ${nowIso()} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

/** Expect an error with a specific code */
async function expectError<T>(
  fn: () => Promise<T>,
  code: string
): Promise<{ ok: boolean; error?: any }> {
  try {
    await fn();
    console.log(`✖ Expected error ${code} but the call succeeded.`);
    return { ok: false, error: `Expected ${code} but succeeded` };
  } catch (err: any) {
    const got = err?.code ?? "UNKNOWN";
    const status = err?.status ?? 0;
    const msg = err?.message ?? "";
    const ok = got === code;
    console.log(
      ok
        ? `✔ Expected error ${code} (${status}): ${msg}`
        : `✖ Got ${got} (${status}) instead of ${code}: ${msg}`
    );
    return { ok, error: err };
  }
}

/** --- Temporary mutate booking times for window tests; will revert --- */
async function withShiftedTimes(bookingId: string, shiftMs: number, run: () => Promise<void>) {
  const b = await Booking.findById(bookingId);
  if (!b) throw new Error("Booking not found for time shift");

  const origStart = b.start;
  const origEnd = b.end;
  b.start = new Date(origStart.getTime() + shiftMs);
  b.end = new Date(origEnd.getTime() + shiftMs);
  await b.save();

  try {
    await run();
  } finally {
    // revert
    const again = await Booking.findById(bookingId);
    if (again) {
      again.start = origStart;
      again.end = origEnd;
      await again.save();
    }
  }
}

/** -------------------- commands -------------------- */
async function cmdCheckIn(
  id: string,
  asRole: "renter" | "host",
  photos?: string[],
  notes?: string,
  readingsCsv?: string
) {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found: " + id);
  const actorId = asRole === "renter" ? String(b.renterId) : String(b.hostId);
  const payload = {
    photos: parsePhotos(photos),
    notes,
    readings: parseReadings(readingsCsv),
  };
  const doc = await checkIn(actorId, id, payload);
  printResult("checkin", { id: String(doc._id), state: doc.state, checkin: doc.checkin });
}

async function cmdCheckOut(
  id: string,
  asRole: "renter" | "host",
  photos?: string[],
  notes?: string,
  readingsCsv?: string
) {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found: " + id);
  const actorId = asRole === "renter" ? String(b.renterId) : String(b.hostId);
  const payload = {
    photos: parsePhotos(photos),
    notes,
    readings: parseReadings(readingsCsv),
  };
  const doc = await checkOut(actorId, id, payload);
  printResult("checkout", { id: String(doc._id), state: doc.state, checkout: doc.checkout });
}

/** Happy path: assumes booking is accepted+paid and we're inside the window */
async function testHappy(id: string) {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found");
  assert(b.paymentStatus === "paid", "Booking must be paid");
  assert(b.state === "accepted" || b.state === "in_progress", "State must be accepted|in_progress");
  const actorHost = String(b.hostId);
  const actorRenter = String(b.renterId);

  // If not yet checked in → check in
  if (!b.checkin?.at) {
    const doc = await checkIn(actorHost, id, {
      notes: "C7 happy – initial check-in",
      readings: { odometer: 1000, odometerUnit: "mi", fuelPercent: 80 },
    });
    printResult("happy:checkin", { id: String(doc._id), state: doc.state });
  } else {
    console.log("ℹ already checked in at", b.checkin.at.toISOString());
  }

  // Then checkout
  const after = await Booking.findById(id);
  const out = await checkOut(actorRenter, id, {
    notes: "C7 happy – checkout",
    readings: { odometer: 1010, odometerUnit: "mi", fuelPercent: 60 },
  });
  printResult("happy:checkout", { id: String(out._id), state: out.state });
}

/** Edge: checkout before check-in -> 409 INVALID_STATE */
async function testCheckoutBeforeCheckin(id: string, asRole: "renter" | "host") {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found");
  // If already has checkin, we can't test this edge on this booking
  if (b.checkin?.at) {
    console.log("SKIP: booking already has check-in; pick another booking");
    return;
  }
  await expectError(
    () =>
      asRole === "renter"
        ? checkOut(String(b.renterId), id, { notes: "edge test" })
        : checkOut(String(b.hostId), id, { notes: "edge test" }),
    "INVALID_STATE"
  );
}

/** Edge: idempotent check-in (call twice) */
async function testIdempotentCheckin(id: string, asRole: "renter" | "host") {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found");
  const actor = asRole === "renter" ? String(b.renterId) : String(b.hostId);

  const first = await checkIn(actor, id, { notes: "edge:idempotent first" });
  const second = await checkIn(actor, id, { notes: "edge:idempotent second" });
  printResult("idempotent-checkin", {
    firstAt: first.checkin?.at,
    secondAt: second.checkin?.at,
    same: String(first.checkin?.at) === String(second.checkin?.at),
  });
}

/** Edge: idempotent checkout (call twice) */
async function testIdempotentCheckout(id: string, asRole: "renter" | "host") {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found");
  const actor = asRole === "renter" ? String(b.renterId) : String(b.hostId);

  const first = await checkOut(actor, id, { notes: "edge:idempotent first" });
  const second = await checkOut(actor, id, { notes: "edge:idempotent second" });
  printResult("idempotent-checkout", {
    firstAt: first.checkout?.at,
    secondAt: second.checkout?.at,
    same: String(first.checkout?.at) === String(second.checkout?.at),
  });
}

/** Edge: early window check-in -> 422 INVALID_WINDOW
 * Temporarily shifts booking start/end into the future, runs the test, then reverts.
 */
async function testEarlyWindowCheckin(id: string, minutes: number, asRole: "renter" | "host") {
  const b0 = await Booking.findById(id);
  if (!b0) throw new Error("Booking not found");
  if (b0.checkin?.at) {
    console.log("SKIP: booking already has a check-in; use a fresh booking for early-window test.");
    return;
  }
  const shiftMs = minutes * 60 * 1000;
  await withShiftedTimes(id, +shiftMs, async () => {
    const b = await Booking.findById(id);
    if (!b) throw new Error("Booking not found after shift");
    const actor = asRole === "renter" ? String(b.renterId) : String(b.hostId);
    await expectError(() => checkIn(actor, id, { notes: "edge early window" }), "INVALID_WINDOW");
  });
}

/** Edge: too many photos -> 422 INVALID_BODY */
async function testTooManyPhotos(id: string, asRole: "renter" | "host") {
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found");
  const actor = asRole === "renter" ? String(b.renterId) : String(b.hostId);
  const photos = Array.from({ length: 21 }, (_, i) => ({
    url: `https://example.com/img/${i}.jpg`,
  }));
  await expectError(() => checkIn(actor, id, { photos }), "INVALID_BODY");
}

/** Edge: bad photo URL host -> 422 INVALID_BODY (skips if host not enforced) */
async function testBadPhotoHost(id: string, asRole: "renter" | "host") {
  const enforce =
    !!process.env.CDN_DOMAIN ||
    !!process.env.S3_PUBLIC_HOST ||
    !!process.env.ASSETS_PUBLIC_HOST ||
    !!process.env.S3_BUCKET_HOST;
  if (!enforce) {
    console.log("SKIP: No CDN/S3 host restriction configured; cannot test bad host.");
    return;
  }
  const b = await Booking.findById(id);
  if (!b) throw new Error("Booking not found");
  const actor = asRole === "renter" ? String(b.renterId) : String(b.hostId);
  await expectError(
    () => checkIn(actor, id, { photos: [{ url: "https://not-your-cdn.com/evil.jpg" }] }),
    "INVALID_BODY"
  );
}

/** -------------------- runner -------------------- */
async function run() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0];
  if (!cmd) {
    console.error(`Usage:
  checkin|checkout --id <BID> --as renter|host [--photo URL ...] [--notes "..."] [--readings "..."]
  test:happy --id <BID>
  test:checkout-before-checkin --id <BID> --as renter|host
  test:idempotent-checkin --id <BID> --as renter|host
  test:idempotent-checkout --id <BID> --as renter|host
  test:window-early-checkin --id <BID> --as renter|host --minutes 60
  test:too-many-photos --id <BID> --as renter|host
  test:bad-photo-url --id <BID> --as renter|host
`);
    process.exit(1);
  }

  const id = asString(argv.id);
  if (!id || id.length !== 24) {
    console.error("--id must be a 24-char ObjectId");
    process.exit(1);
  }

  const mongoUri = envMongoUri();
  await mongoose.connect(mongoUri);

  try {
    switch (cmd) {
      case "checkin": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await cmdCheckIn(
          id,
          asRole,
          asStringArray(argv.photo),
          asString(argv.notes),
          asString(argv.readings)
        );
        break;
      }
      case "checkout": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await cmdCheckOut(
          id,
          asRole,
          asStringArray(argv.photo),
          asString(argv.notes),
          asString(argv.readings)
        );
        break;
      }
      case "test:happy": {
        await testHappy(id);
        break;
      }
      case "test:checkout-before-checkin": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await testCheckoutBeforeCheckin(id, asRole);
        break;
      }
      case "test:idempotent-checkin": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await testIdempotentCheckin(id, asRole);
        break;
      }
      case "test:idempotent-checkout": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await testIdempotentCheckout(id, asRole);
        break;
      }
      case "test:window-early-checkin": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        const minutes = Number(argv.minutes ?? 60);
        await testEarlyWindowCheckin(id, minutes, asRole);
        break;
      }
      case "test:too-many-photos": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await testTooManyPhotos(id, asRole);
        break;
      }
      case "test:bad-photo-url": {
        const asRole = (asString(argv.as) as "renter" | "host") || "renter";
        await testBadPhotoHost(id, asRole);
        break;
      }
      default:
        console.error("Unknown command:", cmd);
        process.exit(1);
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
