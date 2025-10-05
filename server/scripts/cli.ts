import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import mongoose from "mongoose";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const TMP_DIR = path.join(process.cwd(), "tmp");
const SESSION_FILE = path.join(TMP_DIR, "session.json");
type Role = "renter" | "host" | "admin";
type Session = {
  renter?: { token: string; id: string; email?: string };
  host?: { token: string; id: string; email?: string };
};

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}
function readSession(): Session {
  ensureTmp();
  if (!fs.existsSync(SESSION_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeSession(s: Session) {
  ensureTmp();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function requireToken(as: Role): string {
  const sess = readSession();
  const token = sess[as]?.token;
  if (!token)
    throw new Error(`No session for role ${as}. Run: npm run cli -- login --email <e> --as ${as}`);
  return token;
}

async function http(
  method: string,
  pathUrl: string,
  body?: any,
  token?: string,
  extraHeaders?: Record<string, string>
) {
  const res = await fetch(`${BASE}${pathUrl}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.message || `${res.status} ${res.statusText}`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Confirm a PaymentIntent against Stripe directly (test-only, for CLI)
async function stripeConfirmPaymentIntent(piId: string, paymentMethod: string = "pm_card_visa") {
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) throw new Error("STRIPE_SECRET_KEY missing in environment");

  const resp = await fetch(
    `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}/confirm`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sk}:`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ payment_method: paymentMethod }),
    }
  );

  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    const msg = json?.error?.message || `${resp.status} ${resp.statusText}`;
    const err: any = new Error(`Stripe confirm failed: ${msg}`);
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

function arg(name: string, fallback?: string) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}
function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function isId24(v?: string) {
  return !!v && /^[0-9a-fA-F]{24}$/.test(v);
}

// gather repeated flags like: --photo URL --photo URL2
function multiArgs(name: string): string[] | undefined {
  const out: string[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (
      process.argv[i] === `--${name}` &&
      process.argv[i + 1] &&
      !process.argv[i + 1].startsWith("--")
    ) {
      out.push(process.argv[i + 1]);
      i++;
    }
  }
  return out.length ? out : undefined;
}

function parseReadingsCsv(csv?: string): Record<string, unknown> | undefined {
  if (!csv) return undefined;
  const r: Record<string, unknown> = {};
  for (const pair of csv
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

function photosFromFlags(): Array<{ url: string }> | undefined {
  const many = multiArgs("photo");
  const single = arg("photo");
  const urls = many ?? (single ? [single] : undefined);
  return urls?.map((url) => ({ url }));
}

async function cmdHealth() {
  const a = await http("GET", "/health");
  console.log(JSON.stringify(a, null, 2));
}

async function cmdLogin() {
  const email = arg("email");
  const password = arg("password") || "Str0ng@Pass!";
  const as: Role = (arg("as") as Role) || "renter";
  if (!email) throw new Error("Missing --email");
  const res = await http("POST", "/auth/login", { email, password });
  const token = res?.tokens?.accessToken;
  const id = res?.user?.id;
  if (!token || !id) throw new Error("Login response missing token/id");
  const sess = readSession();
  sess[as] = { token, id, email };
  writeSession(sess);
  console.log(JSON.stringify({ role: as, id, email, tokenLen: token.length }, null, 2));
}

async function cmdMe() {
  const as: Role = (arg("as") as Role) || "renter";
  const token = requireToken(as);
  const me = await http("GET", "/users/me", undefined, token);
  console.log(JSON.stringify(me, null, 2));
}

// flags:get
async function cmdFlagsGet() {
  const out = await http("GET", "/flags");
  console.log(JSON.stringify(out, null, 2));
}

// flags:set --key bookings.enabled --value false
async function cmdFlagsSet() {
  const key = arg("key");
  const value = arg("value");
  if (!key) throw new Error("Missing --key <bookings.enabled|...>");
  if (value !== "true" && value !== "false") throw new Error("--value must be true|false");
  const body: any = { [key]: value === "true" };

  // Requires admin token
  const token = requireToken("admin");
  const out = await http("POST", "/admin/flags", body, token);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdAssetCreate() {
  const as: Role = (arg("as") as Role) || "host";
  const token = requireToken(as);
  const category = arg("category", "car");
  const title = arg("title", "Civic LX");
  const description = arg("description", "Solid commuter");
  const lng = Number(arg("lng", "-95.9345"));
  const lat = Number(arg("lat", "41.2565"));

  const body = {
    category,
    title,
    description,
    specs: { color: "blue" },
    media: [],
    location: { type: "Point", coordinates: [lng, lat] },
  };
  const out = await http("POST", "/assets", body, token);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdListingEnsure() {
  // ensures a listing for (assetId, hostId). Uses Mongo directly to avoid extra HTTP code.
  const assetId = arg("asset");
  const hostId = arg("host"); // optional; if missing, derive from host session /me
  const sess = readSession();
  let host = hostId;
  if (!host) {
    // derive from /me with host token
    const token = sess.host?.token;
    if (!token) throw new Error("No host session; pass --host <id> or login as host");
    const me: any = await http("GET", "/users/me", undefined, token);
    host = me?.user?.id;
  }
  if (!isId24(assetId) || !isId24(host)) {
    throw new Error("Invalid --asset or --host (must be 24 hex)");
  }

  await mongoose.connect(process.env.MONGO_URI as string);
  const db = mongoose.connection.db!;
  const existing = await db.collection("listings").findOne(
    {
      assetId: new mongoose.Types.ObjectId(assetId!),
      hostId: new mongoose.Types.ObjectId(host!),
    },
    { projection: { _id: 1 } }
  );
  if (existing) {
    console.log(JSON.stringify({ id: existing._id.toString(), existed: true }, null, 2));
    await mongoose.disconnect();
    return;
  }
  const doc = {
    assetId: new mongoose.Types.ObjectId(assetId!),
    hostId: new mongoose.Types.ObjectId(host!),
    pricing: { baseDailyCents: 4500, minHours: 1, depositCents: 10000, feeCents: 500 },
    instantBook: false,
    blackouts: [],
    cancellationPolicy: "moderate",
    status: "active",
  };
  const r = await db.collection("listings").insertOne(doc);
  console.log(JSON.stringify({ id: r.insertedId.toString(), existed: false }, null, 2));
  await mongoose.disconnect();
}

async function cmdListingSetState() {
  const id = arg("id");
  const state = arg("state");
  if (!isId24(id) || !state) throw new Error("Usage: listing:set-state --id <LID> --state TX");
  await mongoose.connect(process.env.MONGO_URI as string);
  const db = mongoose.connection.db!;
  const r = await db
    .collection("listings")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { "location.state": state.toUpperCase() } }
    );
  console.log(JSON.stringify({ matched: r.matchedCount, modified: r.modifiedCount }, null, 2));
  await mongoose.disconnect();
}

async function cmdPreview() {
  const listing = arg("listing");
  const start = arg("start");
  const end = arg("end");
  const promo = arg("promo");
  if (!isId24(listing)) throw new Error("Missing/invalid --listing (24 hex)");
  if (!start || !end) throw new Error("Missing --start/--end");
  const out = await http("POST", "/quotes/preview", {
    listingId: listing,
    start,
    end,
    ...(promo ? { promoCode: promo } : {}),
  });
  console.log(JSON.stringify(out, null, 2));
}

async function cmdBook() {
  const as: Role = (arg("as") as Role) || "renter";
  const token = requireToken(as);
  const listing = arg("listing");
  const start = arg("start");
  const end = arg("end");
  if (!isId24(listing)) throw new Error("Missing/invalid --listing (24 hex)");
  if (!start || !end) throw new Error("Missing --start/--end");
  const out = await http("POST", "/bookings", { listingId: listing, start, end }, token);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdBookingsList() {
  const as: Role = (arg("as") as Role) || "renter";
  const state = arg("state"); // pending|accepted|declined|cancelled
  const token = requireToken(as);
  const qp = state ? `?state=${encodeURIComponent(state)}` : "";
  const out = await http("GET", `/bookings${qp}`, undefined, token);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdBookingsAccept() {
  const as: Role = (arg("as") as Role) || "host";
  const token = requireToken(as);
  const id = arg("id");
  if (!isId24(id)) throw new Error("Missing/invalid --id (booking id)");
  const out = await http("POST", `/bookings/${id}/accept`, undefined, token);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdLocksClear() {
  const listing = arg("listing");
  if (!isId24(listing)) throw new Error("Missing/invalid --listing");
  await mongoose.connect(process.env.MONGO_URI as string);
  const db = mongoose.connection.db!;
  const r = await db
    .collection("bookinglocks")
    .deleteMany({ listingId: new mongoose.Types.ObjectId(listing) });
  console.log(JSON.stringify({ deleted: r.deletedCount }, null, 2));
  await mongoose.disconnect();
}

// bookings:checkin --as renter|host --id <BID> [--photo URL ...] [--notes "..."] [--readings "odometer=41235,odometerUnit=mi,fuelPercent=85"] [--idemp KEY]
async function cmdBookingsCheckin() {
  const as: Role = (arg("as") as Role) || "renter";
  const token = requireToken(as);
  const id = arg("id");
  if (!isId24(id)) throw new Error("Missing/invalid --id (booking id)");

  const body: any = {
    photos: photosFromFlags(),
    notes: arg("notes"),
    readings: parseReadingsCsv(arg("readings")),
  };
  const idemp = arg("idemp");
  const headers = idemp ? { "X-Idempotency-Key": idemp } : undefined;

  const out = await http("POST", `/bookings/${id}/checkin`, body, token, headers);
  console.log(JSON.stringify(out, null, 2));
}

// bookings:checkout --as renter|host --id <BID> [--photo URL ...] [--notes "..."] [--readings "..."] [--idemp KEY]
async function cmdBookingsCheckout() {
  const as: Role = (arg("as") as Role) || "renter";
  const token = requireToken(as);
  const id = arg("id");
  if (!isId24(id)) throw new Error("Missing/invalid --id (booking id)");

  const body: any = {
    photos: photosFromFlags(),
    notes: arg("notes"),
    readings: parseReadingsCsv(arg("readings")),
  };
  const idemp = arg("idemp");
  const headers = idemp ? { "X-Idempotency-Key": idemp } : undefined;

  const out = await http("POST", `/bookings/${id}/checkout`, body, token, headers);
  console.log(JSON.stringify(out, null, 2));
}

/** ---------------------------
 *  C5 Media commands (S3 PUT)
 *  ---------------------------
 */

// media:sign --folder assets --type image/jpeg [--name foo.jpg] [--as host]
async function cmdMediaSign() {
  const folder = arg("folder", "assets")!;
  const contentType = arg("type", "image/jpeg")!;
  const pathHint = arg("name");
  const as: Role = (arg("as") as Role) || "host"; // any auth'd user is allowed; default host
  const token = requireToken(as);

  const body: any = { folder, contentType };
  if (pathHint) body.pathHint = pathHint;

  const out = await http("POST", "/media/sign", body, token);
  console.log(JSON.stringify(out, null, 2));
}

// media:upload --file ./local.jpg --uploadUrl "<SIGNED_URL>" [--type image/jpeg]
async function cmdMediaUpload() {
  const file = arg("file");
  const uploadUrl = arg("uploadUrl");
  const contentType = arg("type", "image/jpeg")!;
  if (!file || !uploadUrl) throw new Error("--file and --uploadUrl required");

  const buf = fs.readFileSync(path.resolve(file));
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buf,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Upload failed: ${res.status} ${res.statusText} ${txt}`);
  }
  console.log(JSON.stringify({ ok: true, uploaded: path.basename(file) }, null, 2));
}

// asset:attach --id <ASSET_ID> --url <PUBLIC_URL> [--label "front"] [--as host]
async function cmdAssetAttach() {
  const id = arg("id");
  const url = arg("url");
  const label = arg("label");
  const as: Role = (arg("as") as Role) || "host";
  const token = requireToken(as);

  if (!isId24(id)) throw new Error("Missing/invalid --id (asset id)");
  if (!url) throw new Error("Missing --url");
  const addMedia = [label ? { url, label } : url];
  const out = await http("PATCH", `/assets/${id}`, { addMedia }, token);
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// asset:remove --id <ASSET_ID> --url <PUBLIC_URL> [--as host]
async function cmdAssetRemove() {
  const id = arg("id");
  const url = arg("url");
  const as: Role = (arg("as") as Role) || "host";
  const token = requireToken(as);

  if (!isId24(id)) throw new Error("Missing/invalid --id (asset id)");
  if (!url) throw new Error("Missing --url");
  const out = await http("PATCH", `/assets/${id}`, { removeMedia: [url] }, token);
  console.log(JSON.stringify(out, null, 2));
}

// media:test --asset <ASSET_ID> --file ./local.jpg --folder assets --type image/jpeg [--label "front"] [--as host]
async function cmdMediaTest() {
  const assetId = arg("asset");
  const file = arg("file");
  const folder = arg("folder", "assets")!;
  const contentType = arg("type", "image/jpeg")!;
  const label = arg("label");
  const as: Role = (arg("as") as Role) || "host";
  const token = requireToken(as);

  if (!isId24(assetId)) throw new Error("Missing/invalid --asset (asset id)");
  if (!file) throw new Error("Missing --file");

  // 1) Sign
  const sign = await http(
    "POST",
    "/media/sign",
    { folder, contentType, pathHint: path.basename(file) },
    token
  );
  // 2) Upload
  const buf = fs.readFileSync(path.resolve(file));
  const putRes = await fetch(sign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buf,
  });
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => "");
    throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText} ${txt}`);
  }
  // 3) Attach (use response of PATCH as the verification output)
  const attached = await http(
    "PATCH",
    `/assets/${assetId}`,
    { addMedia: [label ? { url: sign.publicUrl, label } : sign.publicUrl] },
    token
  );
  console.log(JSON.stringify(attached, null, 2));
}

// payments:intent:create --as renter --listing <LID> --start <ISO> --end <ISO> [--promo CODE] [--idemp <KEY>]
async function cmdPaymentsIntentCreate() {
  const as: Role = (arg("as") as Role) || "renter";
  if (as !== "renter") throw new Error("--as must be renter for payments");
  const token = requireToken(as);

  const listing = arg("listing");
  const start = arg("start");
  const end = arg("end");
  const promo = arg("promo");
  const idemp = arg("idemp") || `cli-${Date.now()}`;
  if (!isId24(listing)) throw new Error("Missing/invalid --listing (24 hex)");
  if (!start || !end) throw new Error("Missing --start/--end (ISO)");

  const body: any = { listingId: listing, start, end };
  if (promo) body.promoCode = promo;

  const out = await http("POST", "/payments/intents", body, token, {
    "X-Idempotency-Key": idemp,
  });
  console.log(JSON.stringify(out, null, 2));
}

// payments:confirm --pi <PI_ID> [--pm pm_card_visa]
async function cmdPaymentsConfirm() {
  const pi = arg("pi");
  const pm = arg("pm", "pm_card_visa");
  if (!pi) throw new Error("Missing --pi <PAYMENT_INTENT_ID>");
  const out = await stripeConfirmPaymentIntent(pi, pm);
  console.log(
    JSON.stringify({ id: out.id, status: out.status, latest_charge: out.latest_charge }, null, 2)
  );
}

// bookings:create --as renter --pi <PI_ID>
async function cmdBookingsCreateFromPI() {
  const as: Role = (arg("as") as Role) || "renter";
  if (as !== "renter") throw new Error("--as must be renter for bookings:create");
  const token = requireToken(as);
  const pi = arg("pi");
  if (!pi) throw new Error("Missing --pi <PAYMENT_INTENT_ID>");
  const out = await http("POST", "/bookings", { paymentIntentId: pi }, token);
  console.log(JSON.stringify(out, null, 2));
}

// payments:status --pi <PI_ID>  OR  --booking <BID> [--as renter|host]
async function cmdPaymentsStatus() {
  const pi = arg("pi");
  const bid = arg("booking");
  const as: Role = (arg("as") as Role) || "renter";
  const token = requireToken(as);
  if (!pi && !bid) throw new Error("Pass --pi <PAYMENT_INTENT_ID> or --booking <BOOKING_ID>");
  const qs = pi
    ? `paymentIntentId=${encodeURIComponent(pi)}`
    : `bookingId=${encodeURIComponent(bid!)}`;
  const out = await http("GET", `/payments/status?${qs}`, undefined, token);
  console.log(JSON.stringify(out, null, 2));
}

// bookings:decline --as host --id <BID>
async function cmdBookingsDecline() {
  const as: Role = (arg("as") as Role) || "host";
  if (as !== "host") throw new Error("--as must be host for bookings:decline");
  const token = requireToken(as);
  const id = arg("id");
  if (!isId24(id)) throw new Error("Missing/invalid --id (booking id)");
  const out = await http("POST", `/bookings/${id}/decline`, undefined, token);
  console.log(JSON.stringify(out, null, 2));
}

// bookings:cancel --as renter --id <BID>
async function cmdBookingsCancel() {
  const as: Role = (arg("as") as Role) || "renter";
  if (as !== "renter") throw new Error("--as must be renter for bookings:cancel");
  const token = requireToken(as);
  const id = arg("id");
  if (!isId24(id)) throw new Error("Missing/invalid --id (booking id)");
  const out = await http("POST", `/bookings/${id}/cancel`, undefined, token);
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case "health":
        await cmdHealth();
        break;
      case "login":
        await cmdLogin();
        break;
      case "me":
        await cmdMe();
        break;
      case "asset:create":
        await cmdAssetCreate();
        break;
      case "listing:ensure":
        await cmdListingEnsure();
        break;
      case "listing:set-state":
        await cmdListingSetState();
        break;
      case "preview":
        await cmdPreview();
        break;
      case "book":
        throw new Error(
          "This command is deprecated in C6 (pay-first). Use:\n" +
            "  npm run cli -- payments:intent:create --as renter --listing <LID> --start <ISO> --end <ISO>\n" +
            "  npm run cli -- payments:confirm --pi <PI_ID>\n" +
            "  npm run cli -- bookings:create --as renter --pi <PI_ID>\n"
        );
      case "bookings:list":
        await cmdBookingsList();
        break;
      case "bookings:accept":
        await cmdBookingsAccept();
        break;
      case "locks:clear":
        await cmdLocksClear();
        break;
      case "bookings:checkin":
        await cmdBookingsCheckin();
        break;
      case "bookings:checkout":
        await cmdBookingsCheckout();
        break;

      // C5 media
      case "media:sign":
        await cmdMediaSign();
        break;
      case "media:upload":
        await cmdMediaUpload();
        break;
      case "asset:attach":
        await cmdAssetAttach();
        break;
      case "asset:remove":
        await cmdAssetRemove();
        break;
      case "media:test":
        await cmdMediaTest();
        break;

      case "payments:intent:create":
        await cmdPaymentsIntentCreate();
        break;
      case "payments:confirm":
        await cmdPaymentsConfirm();
        break;
      case "bookings:create":
        await cmdBookingsCreateFromPI();
        break;
      case "payments:status":
        await cmdPaymentsStatus();
        break;
      case "bookings:decline":
        await cmdBookingsDecline();
        break;
      case "bookings:cancel":
        await cmdBookingsCancel();
        break;

      //CMD FLAGS
      case "flags:get":
        await cmdFlagsGet();
        break;
      case "flags:set":
        await cmdFlagsSet();
        break;

      default:
        console.log(
          `Usage (examples):
  npm run cli -- health

  # auth
  npm run cli -- login --email ava5@example.com --as renter
  npm run cli -- login --email ava6@example.com --as host
  npm run cli -- me --as host

  # inventory
  npm run cli -- asset:create --as host --category car --title "Civic LX" --lng -95.9345 --lat 41.2565
  npm run cli -- listing:ensure --asset <ASSET_ID>     # host id auto-detected from host session

  # pricing / preview (times in ISO UTC, e.g. 2025-09-15T05:00:00Z)
  npm run cli -- preview --listing <LID> --start <ISO> --end <ISO>

  # C6 pay-first flow
  npm run cli -- payments:intent:create --as renter --listing <LID> --start <ISO> --end <ISO> [--idemp my-key]
  npm run cli -- payments:confirm --pi <PI_ID> [--pm pm_card_visa]
  npm run cli -- bookings:create --as renter --pi <PI_ID>
  npm run cli -- payments:status --pi <PI_ID>
  npm run cli -- payments:status --booking <BID> --as renter

  # bookings (list/accept remain the same)
  npm run cli -- bookings:list --as renter --state pending
  npm run cli -- bookings:list --as host   --state pending
  npm run cli -- bookings:accept --as host --id <BID>
  npm run cli -- bookings:decline --as host   --id <BID>
npm run cli -- bookings:cancel  --as renter --id <BID>
  npm run cli -- bookings:checkin --as host --id <BID> --notes "Scratch LF" --readings "odometer=41235,odometerUnit=mi,fuelPercent=85" --photo https://cdn.example.com/fr/abc/front.jpg
  npm run cli -- bookings:checkout --as renter --id <BID> --notes "All good" --readings "odometer=41245,odometerUnit=mi,fuelPercent=60"



  # locks (admin/debug)
  npm run cli -- locks:clear --listing <LID>

  # media (C5)
  npm run cli -- media:sign --folder assets --type image/jpeg --name local.jpg --as host
  npm run cli -- media:upload --file ./local.jpg --uploadUrl "<SIGNED_URL>" --type image/jpeg
  npm run cli -- asset:attach --id <ASSET_ID> --url "<PUBLIC_URL>" --label "front" --as host
  npm run cli -- asset:remove --id <ASSET_ID> --url "<PUBLIC_URL>" --as host
  npm run cli -- media:test --asset <ASSET_ID> --file ./local.jpg --folder assets --type image/jpeg --label "front" --as host

  # pricing / preview (times in ISO UTC, e.g. 2025-09-15T05:00:00Z)
npm run cli -- preview --listing <LID> --start <ISO> --end <ISO> [--promo CODE]

# C6/C8 pay-first flow
npm run cli -- payments:intent:create --as renter --listing <LID> --start <ISO> --end <ISO> [--promo CODE] [--idemp my-key]

npm run cli -- listing:set-state --id <LID> --state NE
npm run cli -- preview --listing <LID> --start $START --end $END
# Expect: Tax (7.50%)

  # flags (B9)
  npm run cli -- flags:get
  npm run cli -- flags:set --key bookings.enabled --value false



`
        );
    }
  } catch (e: any) {
    const out = { ok: false, error: e?.message || String(e), status: e?.status, body: e?.body };
    console.error(JSON.stringify(out, null, 2));
    process.exit(1);
  }
}
main();
