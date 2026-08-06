require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const twilio  = require("twilio");

const app = express();
app.use(express.json());

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
app.use(express.json({ limit: "5mb" }));
app.get("/store", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); }
  catch { res.json({}); }
});
app.post("/store", (req, res) => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(req.body || {})); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-farmer consultation chat storage (isolated per account, not the shared /store blob) ──
const CHATS_DIR = (process.env.DATA_DIR || "/data") + "/chats";
try { fs.mkdirSync(CHATS_DIR, { recursive: true }); } catch {}
function chatFile(phone) {
  const safe = String(phone || "unknown").replace(/[^0-9A-Za-z+_-]/g, "_");
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("✅ Farmanza OTP backend running on http://localhost:" + PORT));
