require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const twilio  = require("twilio");

const app = express();
app.use(express.json({ limit: "10mb" })); // covers base64 photos in corrections/reflib payloads

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors());

let client = null;
try {
  if ((process.env.TWILIO_ACCOUNT_SID || "").startsWith("AC")) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } else {
    console.log("⚠️ Twilio not configured — OTP endpoints disabled, Planet proxy still active");
  }
} catch (e) { console.log("⚠️ Twilio init failed:", e.message); }
const VERIFY_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

function toE164(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("92") && digits.length === 12) return "+" + digits;
  if (digits.startsWith("0")  && digits.length === 11) return "+92" + digits.slice(1);
  if (digits.length === 10)                             return "+92" + digits;
  throw new Error("Invalid phone format: " + raw);
}

app.post("/api/otp/send", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
  let e164;
  try { e164 = toE164(phone); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const v = await client.verify.v2.services(VERIFY_SID).verifications.create({
      to: e164, channel: "whatsapp"
    });
    console.log("[OTP SENT]", e164, v.status);
    return res.json({ ok: true, status: v.status, to: e164 });
  } catch (err) {
    console.error("[OTP SEND ERROR]", err.message);
    return res.status(500).json({ ok: false, error: err.message, code: err.code });
  }
});

app.post("/api/otp/verify", async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ ok: false, error: "phone and code required" });
  let e164;
  try { e164 = toE164(phone); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  try {
    const check = await client.verify.v2.services(VERIFY_SID).verificationChecks.create({
      to: e164, code: String(code).trim()
    });
    console.log("[OTP CHECK]", e164, check.status);
    if (check.status === "approved") {
      const token = Buffer.from(JSON.stringify({ phone: e164, ts: Date.now() })).toString("base64");
      return res.json({ ok: true, verified: true, token, phone: e164 });
    }
    return res.json({ ok: true, verified: false, status: check.status });
  } catch (err) {
    if (err.code === 20404) return res.status(400).json({ ok: false, error: "Code expired or already used. Request a new one.", code: 20404 });
    console.error("[OTP VERIFY ERROR]", err.message);
    return res.status(500).json({ ok: false, error: err.message, code: err.code });
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true, service: "farmanza-otp" }));


// Allow browser apps (Netlify) to call this API
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Cross-device store (attach a Railway Volume at /data for permanence) ─────
const fs = require("fs");
const DATA_FILE = (process.env.DATA_DIR || "/data") + "/farmanza.json";
try { fs.mkdirSync(process.env.DATA_DIR || "/data", { recursive: true }); } catch {}
app.get("/store", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); }
  catch { res.json({}); }
});
app.post("/store", (req, res) => {
  // Merge (not overwrite) — the frontend now sends only the marketplace-listing keys
  // (stores/marketDemands/medOrders) here; farmers/buyers/lands go through their own
  // atomic /upsert /delete routes below and must never be wiped by this endpoint.
  try {
    const current = (() => { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; } })();
    const merged = { ...current, ...(req.body || {}) };
    fs.writeFileSync(DATA_FILE, JSON.stringify(merged));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Atomic per-record operations for farmers/buyers/lands — fixes a real bug where
// deleting/editing a record could get silently resurrected: the old approach had every
// device push its own full (possibly stale) copy of these arrays on any unrelated change,
// so one device's stale snapshot could overwrite another device's deletion moments later.
// These endpoints instead read the current file fresh, touch only ONE record, write back —
// no client ever overwrites data it hasn't itself just read. ──
function readStore() { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; } }

// ── Storage health check — writes+reads a test file right now and reports real counts,
// so persistence can be verified with one click instead of a manual redeploy-and-compare
// dance every time. If "writable" is false or counts unexpectedly drop to 0 after a
// redeploy, the Railway Volume is not actually persisting data. ──
app.get("/health", (req, res) => {
  const dir = process.env.DATA_DIR || "/data";
  const testFile = dir + "/_health_check.json";
  try {
    const now = Date.now();
    fs.writeFileSync(testFile, JSON.stringify({ lastCheck: now }));
    const readBack = JSON.parse(fs.readFileSync(testFile, "utf8"));
    let chatCount = 0;
    try { chatCount = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith(".json")).length; } catch {}
    let farmerCount = 0, buyerCount = 0, landCount = 0;
    try { const st = readStore(); farmerCount = (st.farmers || []).length; buyerCount = (st.buyers || []).length; landCount = (st.lands || []).length; } catch {}
    res.json({
      ok: true,
      writable: readBack.lastCheck === now,
      dataDir: dir,
      chatFiles: chatCount,
      farmerRecords: farmerCount,
      buyerRecords: buyerCount,
      landRecords: landCount,
      checkedAt: new Date(now).toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, writable: false, error: e.message });
  }
});
function writeStore(obj) { fs.writeFileSync(DATA_FILE, JSON.stringify(obj)); }

function makeRecordRoutes(key) {
  app.post("/" + key + "/upsert", (req, res) => {
    try {
      const store = readStore();
      let arr = Array.isArray(store[key]) ? store[key] : [];
      const rec = req.body;
      const idx = arr.findIndex(x => x.id === rec.id);
      if (idx >= 0) arr[idx] = rec; else arr.push(rec);
      store[key] = arr;
      writeStore(store);
      res.json({ ok: true, [key]: arr });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/" + key + "/delete", (req, res) => {
    try {
      const store = readStore();
      let arr = Array.isArray(store[key]) ? store[key] : [];
      arr = arr.filter(x => x.id !== req.body.id);
      store[key] = arr;
      writeStore(store);
      res.json({ ok: true, [key]: arr });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
makeRecordRoutes("farmers");
makeRecordRoutes("buyers");
makeRecordRoutes("lands");


// ── Per-farmer consultation chat storage (isolated per account, not the shared /store blob) ──
const CHATS_DIR = (process.env.DATA_DIR || "/data") + "/chats";
try { fs.mkdirSync(CHATS_DIR, { recursive: true }); } catch {}
function chatFile(phone) {
  const safe = String(phone || "unknown").replace(/\D/g, "") || "unknown";
  return CHATS_DIR + "/" + safe + ".json";
}
// A farmer's own device fetches ONLY its own thread — never anyone else's
app.get("/chat/:phone", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(chatFile(req.params.phone), "utf8"))); }
  catch { res.json({ history: [] }); }
});
app.post("/chat/:phone", (req, res) => {
  try { fs.writeFileSync(chatFile(req.params.phone), JSON.stringify({ history: req.body.history || [], updatedAt: Date.now() })); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Append ONE message atomically — reads current thread, adds the message, writes back.
// This replaces relying on the client to always send a complete, race-free history array:
// two saves firing close together (question, then answer moments later) could otherwise
// overwrite each other depending on timing, silently dropping one side of the exchange.
app.post("/chat/:phone/append", (req, res) => {
  try {
    let cur = { history: [] };
    try { cur = JSON.parse(fs.readFileSync(chatFile(req.params.phone), "utf8")); } catch {}
    const history = Array.isArray(cur.history) ? cur.history : [];
    history.push(req.body);
    fs.writeFileSync(chatFile(req.params.phone), JSON.stringify({ history, updatedAt: Date.now() }));
    res.json({ ok: true, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kissan Hissab — per-farmer ledger (crops, input costs, sales, treatment notes).
// Same proven pattern as chat: one file per phone, atomic append, never a client-side
// full-overwrite that could race and lose entries. ──
function ledgerFile(phone) {
  const safe = String(phone || "unknown").replace(/\D/g, "") || "unknown";
  return LEDGER_DIR + "/" + safe + ".json";
}
const LEDGER_DIR = (process.env.DATA_DIR || "/data") + "/ledger";
try { fs.mkdirSync(LEDGER_DIR, { recursive: true }); } catch {}

app.get("/ledger/:phone", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(ledgerFile(req.params.phone), "utf8"))); }
  catch { res.json({ entries: [] }); }
});
app.post("/ledger/:phone/append", (req, res) => {
  try {
    let cur = { entries: [] };
    try { cur = JSON.parse(fs.readFileSync(ledgerFile(req.params.phone), "utf8")); } catch {}
    const entries = Array.isArray(cur.entries) ? cur.entries : [];
    entries.push(req.body);
    fs.writeFileSync(ledgerFile(req.params.phone), JSON.stringify({ entries, updatedAt: Date.now() }));
    res.json({ ok: true, entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/ledger-all", (req, res) => {
  // Admin cross-farmer view — for trend analysis and advisory, per the same aggregate
  // pattern already used for /chats-all.
  try {
    const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith(".json"));
    const out = {};
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(LEDGER_DIR + "/" + f, "utf8"));
        out[f.replace(/\.json$/, "")] = { entries: d.entries || [], updatedAt: d.updatedAt || 0 };
      } catch {}
    }
    res.json(out);
  } catch (e) { res.json({}); }
});

// ── Institutional crop rates — admin-curated current buying rates from named
// institutional buyers (mills, exporters, etc.) per crop, shown read-only to farmers. ──
const RATES_FILE = (process.env.DATA_DIR || "/data") + "/institutional_rates.json";
app.get("/institutional-rates", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(RATES_FILE, "utf8"))); }
  catch { res.json([]); }
});
app.post("/institutional-rates", (req, res) => {
  try { fs.writeFileSync(RATES_FILE, JSON.stringify(req.body || [])); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/institutional-rates/add", (req, res) => {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(RATES_FILE, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(req.body);
    fs.writeFileSync(RATES_FILE, JSON.stringify(arr));
    res.json({ ok: true, rates: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only: aggregate view of every farmer's consultation activity
app.get("/chats-all", (req, res) => {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith(".json"));
    const out = {};
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(CHATS_DIR + "/" + f, "utf8"));
        out[f.replace(/\.json$/, "")] = { history: d.history || [], updatedAt: d.updatedAt || 0 };
      } catch {}
    }
    res.json(out);
  } catch (e) { res.json({}); }
});
// ── Specialized plant/tree/crop identification (PlantNet) — a purpose-built botanical
// classifier trained on millions of labeled species photos, far more accurate for narrow
// species ID than any general-purpose chatbot vision. Used as a first-pass grounding signal,
// with Claude then writing the full contextual Urdu advisory on top of these candidates. ──
const PLANTNET_KEY = process.env.PLANTNET_API_KEY || "";
app.post("/plantid", async (req, res) => {
  try {
    if (!PLANTNET_KEY) return res.status(500).json({ error: "PLANTNET_API_KEY not set" });
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "no image" });
    const buf = Buffer.from(image, "base64");
    const blob = new Blob([buf], { type: "image/jpeg" });
    const form = new FormData();
    form.append("images", blob, "photo.jpg");
    form.append("organs", "auto");
    const url = "https://my-api.plantnet.org/v2/identify/all?api-key=" + PLANTNET_KEY;
    const r = await fetch(url, { method: "POST", body: form });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.log("plantnet:", r.status, t.slice(0, 200));
      return res.status(r.status).json({ error: "plantnet " + r.status });
    }
    const d = await r.json();
    const top = (d.results || []).slice(0, 3).map(x => ({
      sci: x.species && x.species.scientificNameWithoutAuthor || "",
      common: (x.species && x.species.commonNames && x.species.commonNames[0]) || "",
      score: Math.round((x.score || 0) * 100),
    }));
    res.json({ results: top });
  } catch (e) { console.log("plantid err:", e.message); res.status(500).json({ error: e.message }); }
});
// ── iNaturalist computer vision — free, no API key, covers plants AND animals/insects
// (pests!). Community-verified global biodiversity database — a second independent
// specialized classifier that Claude can reconcile against PlantNet's results. ──
app.post("/inatid", async (req, res) => {
  try {
    const { image, lat, lng } = req.body;
    if (!image) return res.status(400).json({ error: "no image" });
    const buf = Buffer.from(image, "base64");
    const blob = new Blob([buf], { type: "image/jpeg" });
    const form = new FormData();
    form.append("image", blob, "photo.jpg");
    if (lat) form.append("lat", String(lat));
    if (lng) form.append("lng", String(lng));
    const r = await fetch("https://api.inaturalist.org/v1/computervision/score_image", {
      method: "POST",
      body: form,
      headers: { "User-Agent": "Farmanza-Agri-App/1.0 (Pakistani farming platform)" },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.log("inat:", r.status, t.slice(0, 200));
      return res.status(r.status).json({ error: "inaturalist " + r.status });
    }
    const d = await r.json();
    const top = (d.results || []).slice(0, 3).map(x => ({
      sci: (x.taxon && x.taxon.name) || "",
      common: (x.taxon && x.taxon.preferred_common_name) || "",
      rank: (x.taxon && x.taxon.rank) || "",
      score: Math.round(x.combined_score != null ? x.combined_score : (x.vision_score || 0)),
    }));
    res.json({ results: top });
  } catch (e) { console.log("inatid err:", e.message); res.status(500).json({ error: e.message }); }
});


// ── AI identification reference library (admin-curated, boosts photo ID accuracy) ──
const REFLIB_FILE = (process.env.DATA_DIR || "/data") + "/reflib.json";
app.get("/reflib", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(REFLIB_FILE, "utf8"))); }
  catch { res.json([]); }
});
app.post("/reflib", (req, res) => {
  try { fs.writeFileSync(REFLIB_FILE, JSON.stringify(req.body || [])); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Correction memory: wrong-answer/right-answer pairs, remembered for future queries ──
const CORRECTIONS_FILE = (process.env.DATA_DIR || "/data") + "/corrections.json";
app.get("/corrections", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CORRECTIONS_FILE, "utf8"))); }
  catch { res.json([]); }
});
app.post("/corrections", (req, res) => {
  try { fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(req.body || [])); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Append-only endpoints — avoid the client-side race where an incomplete local copy
// could overwrite and wipe out other data already saved on the server.
app.post("/corrections/add", (req, res) => {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(req.body);
    fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(arr));
    res.json({ ok: true, corrections: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/reflib/add", (req, res) => {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(REFLIB_FILE, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(req.body);
    fs.writeFileSync(REFLIB_FILE, JSON.stringify(arr));
    res.json({ ok: true, reflib: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Planet Labs daily-scene proxy (yesterday's imagery) ───────────────────────
const PL_KEY = process.env.PLANET_API_KEY || "";
const PL_AUTH = "Basic " + Buffer.from(PL_KEY + ":").toString("base64");

// Find newest PlanetScope scene (last 14 days, <20% cloud) covering a point
app.get("/planet/latest", async (req, res) => {
  try {
    if (!PL_KEY) return res.status(500).json({ error: "PLANET_API_KEY not set" });
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const body = {
      item_types: ["PSScene"],
      filter: { type: "AndFilter", config: [
        { type: "GeometryFilter", field_name: "geometry",
          config: { type: "Point", coordinates: [lng, lat] } },
        { type: "DateRangeFilter", field_name: "acquired", config: { gte: start } },
        { type: "RangeFilter", field_name: "cloud_cover", config: { lte: 0.5 } },
      ]},
    };
    const r = await fetch("https://api.planet.com/data/v1/quick-search?_sort=acquired desc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": PL_AUTH },
      body: JSON.stringify(body),
    });
    if (!r.ok) return res.status(r.status).json({ error: "planet search failed" });
    const d = await r.json();
    const f = d.features && d.features[0];
    if (!f) return res.json({ id: null });
    res.json({ id: f.id, acquired: f.properties.acquired, cloud: f.properties.cloud_cover });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sentinel-2 latest cloud-free tile (last 30 days) via Sentinel Hub WMS
let s2Tok=null, s2Exp=0;
async function s2Token(){
  if (s2Tok && Date.now() < s2Exp) return s2Tok;
  const r = await fetch("https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token",{
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:"grant_type=client_credentials&client_id="+encodeURIComponent(process.env.S2_CLIENT_ID||"")+"&client_secret="+encodeURIComponent(process.env.S2_CLIENT_SECRET||"")
  });
  const d = await r.json();
  if (!d.access_token) { console.log("s2 auth:", JSON.stringify(d).slice(0,200)); return null; }
  s2Tok = d.access_token; s2Exp = Date.now() + (d.expires_in - 60) * 1000;
  return s2Tok;
}
app.get("/s2/tile/:z/:x/:y", async (req, res) => {
  try {
    const tok = await s2Token();
    if (!tok) return res.status(500).json({ error: "S2 OAuth failed — set S2_CLIENT_ID / S2_CLIENT_SECRET" });
    const z=+req.params.z, x=+req.params.x, y=+req.params.y;
    const W=20037508.342789244, t=(2*W)/Math.pow(2,z);
    const minx=-W+x*t, maxx=minx+t, maxy=W-y*t, miny=maxy-t;
    const to=new Date().toISOString(), from=new Date(Date.now()-30*864e5).toISOString();
    const body={input:{bounds:{bbox:[minx,miny,maxx,maxy],properties:{crs:"http://www.opengis.net/def/crs/EPSG/0/3857"}},data:[{type:"sentinel-2-l2a",dataFilter:{timeRange:{from,to},maxCloudCoverage:20,mosaickingOrder:"mostRecent"}}]},output:{width:512,height:512,responses:[{identifier:"default",format:{type:"image/jpeg"}}]},evalscript:"//VERSION=3\nfunction setup(){return{input:[\"B02\",\"B03\",\"B04\"],output:{bands:3}}}\nfunction evaluatePixel(s){return[2.5*s.B04,2.5*s.B03,2.5*s.B02]}"};
    const r=await fetch("https://services.sentinel-hub.com/api/v1/process",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+tok},body:JSON.stringify(body)});
    if(!r.ok){const e=await r.text();console.log("s2:",r.status,e.slice(0,200));return res.status(r.status).end();}
    res.set({"Content-Type":"image/jpeg","Access-Control-Allow-Origin":"*","Cache-Control":"public, max-age=3600"});
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e){ console.log("s2 err:",e.message); res.status(500).end(); }
});
// ── ArcGIS World Imagery proxy — free, no API key. Used specifically for orchard
// tree detection, which needs the browser to read raw pixel data via canvas
// (not just display the image). Fetching directly from the browser risks a
// "tainted canvas" security error if the tile server doesn't send permissive CORS
// headers — routing through this backend guarantees canvas-safe access regardless,
// the same fix already proven for Sentinel-2 tiles above. ──
app.get("/arcgis/tile/:z/:y/:x", async (req, res) => {
  try {
    const { z, y, x } = req.params;
    const url = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/" + z + "/" + y + "/" + x;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    res.set({ "Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.log("arcgis err:", e.message); res.status(500).end(); }
});


// Proxy monthly-basemap tiles (fallback entitlement test)
app.get("/planet/btile/:z/:x/:y", async (req, res) => {
  try {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    const m = "global_monthly_" + d.getFullYear() + "_" + String(d.getMonth()+1).padStart(2,"0") + "_mosaic";
    const { z, x, y } = req.params;
    const r = await fetch("https://tiles.planet.com/basemaps/v1/planet-tiles/" + m + "/gmap/" + z + "/" + x + "/" + y + ".png?api_key=" + PL_KEY);
    if (!r.ok) return res.status(r.status).end();
    res.set({ "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).end(); }
});

// Proxy scene tiles (key stays server-side); CORS open for canvas reads
app.get("/planet/tile/:id/:z/:x/:y", async (req, res) => {
  try {
    const { id, z, x, y } = req.params;
    const url = "https://tiles.planet.com/data/v1/PSScene/" + id + "/" + z + "/" + x + "/" + y + ".png?api_key=" + PL_KEY;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set({ "Content-Type": "image/png", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
    res.send(buf);
  } catch (e) { res.status(500).end(); }
});

process.on("uncaughtException", e => console.error("uncaught:", e.message));
process.on("unhandledRejection", e => console.error("unhandled:", e));

// ── Pakistan registered-pesticide registry (Dept. of Plant Protection, Form-1/16/17,
// data updated 30/01/2025) — real regulatory data, loaded once at startup. Used to verify
// any chemical Claude recommends against the actual official list before showing it to a farmer. ──
let PESTICIDE_REGISTRY = [];
try {
  PESTICIDE_REGISTRY = JSON.parse(fs.readFileSync(__dirname + "/pesticide_registry.json", "utf8"));
  console.log("✅ Pesticide registry loaded:", PESTICIDE_REGISTRY.length, "entries");
} catch (e) { console.log("⚠️ pesticide registry not loaded:", e.message); }

app.get("/pesticide-check", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q || q.length < 3) return res.json({ matches: [] });
  const matches = PESTICIDE_REGISTRY.filter(r => (r.product || "").toLowerCase().includes(q)).slice(0, 5);
  res.json({ matches });
});
// ── Notified generic formulations (S.R.O. 636(I)/2005) — includes WHO acute toxicity
// hazard class (I=extremely hazardous ... IV=unlikely), genuinely valuable safety data
// the main registry above doesn't carry. Second, complementary verification layer. ──
let NOTIFIED_LIST = [];
try {
  NOTIFIED_LIST = JSON.parse(fs.readFileSync(__dirname + "/notified_classified.json", "utf8"));
  console.log("✅ Notified/WHO-class list loaded:", NOTIFIED_LIST.length, "entries");
} catch (e) { console.log("⚠️ notified list not loaded:", e.message); }

app.get("/pesticide-notified-check", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q || q.length < 3) return res.json({ matches: [] });
  const matches = NOTIFIED_LIST.filter(r => (r.product || "").toLowerCase().includes(q)).slice(0, 3);
  res.json({ matches });
});
// ── Approved veterinary drugs registry (DRAP) — infrastructure ready, empty until real
// data is imported. DRAP has no clean bulk-downloadable "approved" list like DPP does;
// only a search-only tool DRAP itself disclaims for reference use. Entries can be added
// here manually (cross-checked one at a time) or via a future bulk import. ──
const VETDRUGS_FILE = (process.env.DATA_DIR || "/data") + "/vet_drugs.json";
app.get("/vet-drugs", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(VETDRUGS_FILE, "utf8"))); }
  catch { res.json([]); }
});
app.post("/vet-drugs", (req, res) => {
  try { fs.writeFileSync(VETDRUGS_FILE, JSON.stringify(req.body || [])); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/vet-drugs/add", (req, res) => {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(VETDRUGS_FILE, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(req.body);
    fs.writeFileSync(VETDRUGS_FILE, JSON.stringify(arr));
    res.json({ ok: true, drugs: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/vet-drug-check", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q || q.length < 3) return res.json({ matches: [] });
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(VETDRUGS_FILE, "utf8")); } catch {}
  const matches = arr.filter(r => (r.name || "").toLowerCase().includes(q)).slice(0, 5);
  res.json({ matches });
});

// ── Central suppliers (Farmanza's own negotiated/discounted deals) — distinct from the
// peer-to-peer marketplace. Admin-curated. AI recommendations check this catalog first,
// enabling a one-tap order flow instead of the multi-company quote-collection process. ──
const CENTRAL_FILE = (process.env.DATA_DIR || "/data") + "/central_suppliers.json";
const CENTRAL_ORDERS_FILE = (process.env.DATA_DIR || "/data") + "/central_orders.json";

app.get("/central-suppliers", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CENTRAL_FILE, "utf8"))); }
  catch { res.json([]); }
});
app.post("/central-suppliers", (req, res) => {
  try { fs.writeFileSync(CENTRAL_FILE, JSON.stringify(req.body || [])); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/central-suppliers/add", (req, res) => {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(CENTRAL_FILE, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(req.body);
    fs.writeFileSync(CENTRAL_FILE, JSON.stringify(arr));
    res.json({ ok: true, suppliers: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/central-orders", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CENTRAL_ORDERS_FILE, "utf8"))); }
  catch { res.json([]); }
});
app.post("/central-orders", (req, res) => {
  try { fs.writeFileSync(CENTRAL_ORDERS_FILE, JSON.stringify(req.body || [])); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/central-orders/add", (req, res) => {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(CENTRAL_ORDERS_FILE, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.push(req.body);
    fs.writeFileSync(CENTRAL_ORDERS_FILE, JSON.stringify(arr));
    res.json({ ok: true, orders: arr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("✅ Farmanza OTP backend running on http://localhost:" + PORT));
