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
