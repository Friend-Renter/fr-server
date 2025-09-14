import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import mongoose from "mongoose";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const TMP_DIR = path.join(process.cwd(), "tmp");
const SESSION_FILE = path.join(TMP_DIR, "session.json");

type Role = "renter" | "host";
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

async function http(method: string, pathUrl: string, body?: any, token?: string) {
  const res = await fetch(`${BASE}${pathUrl}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function cmdPreview() {
  const listing = arg("listing");
  const start = arg("start");
  const end = arg("end");
  if (!isId24(listing)) throw new Error("Missing/invalid --listing (24 hex)");
  if (!start || !end) throw new Error("Missing --start/--end");
  const out = await http("POST", "/quotes/preview", { listingId: listing, start, end });
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
      case "preview":
        await cmdPreview();
        break;
      case "book":
        await cmdBook();
        break;
      case "bookings:list":
        await cmdBookingsList();
        break;
      case "bookings:accept":
        await cmdBookingsAccept();
        break;
      case "locks:clear":
        await cmdLocksClear();
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

  # pricing / booking (times in ISO UTC, e.g. 2025-09-15T05:00:00Z)
  npm run cli -- preview --listing <LID> --start <ISO> --end <ISO>
  npm run cli -- book --as renter --listing <LID> --start <ISO> --end <ISO>
  npm run cli -- bookings:list --as renter --state pending
  npm run cli -- bookings:list --as host   --state pending
  npm run cli -- bookings:accept --as host --id <BID>

  # locks
  npm run cli -- locks:clear --listing <LID>

  # media (C5)
  npm run cli -- media:sign --folder assets --type image/jpeg --name local.jpg --as host
  npm run cli -- media:upload --file ./local.jpg --uploadUrl "<SIGNED_URL>" --type image/jpeg
  npm run cli -- asset:attach --id <ASSET_ID> --url "<PUBLIC_URL>" --label "front" --as host
  npm run cli -- asset:remove --id <ASSET_ID> --url "<PUBLIC_URL>" --as host
  npm run cli -- media:test --asset <ASSET_ID> --file ./local.jpg --folder assets --type image/jpeg --label "front" --as host
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
