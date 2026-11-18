"use strict";
/* ฟังใจ: เซิร์ฟเวอร์ (ไม่ใช้ package ภายนอก ต้องการ Node 20 ขึ้นไป) */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ---------- .env ---------- */
try {
  const f = path.join(__dirname, ".env");
  if (fs.existsSync(f)) {
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((line) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    });
  }
} catch (e) { /* ignore */ }

const { DEFAULTS } = require("./defaults");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MODEL_QUICK = process.env.ANTHROPIC_MODEL_QUICK || "claude-haiku-5-5";
const MAX_AI_PER_DAY = Number(process.env.MAX_AI_PER_DAY) || 2000;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const PUBLIC_DIR = path.join(__dirname, "public");

if (ADMIN_PASSWORD.length < 8 || /ตั้งรหัสผ่าน/.test(ADMIN_PASSWORD)) {
  console.error("ต้องตั้ง ADMIN_PASSWORD (อย่างน้อย 8 ตัวอักษร) ก่อนเปิดเซิร์ฟเวอร์");
  process.exit(1);
}
if (!API_KEY) console.warn("คำเตือน: ยังไม่ได้ตั้ง ANTHROPIC_API_KEY ผู้ช่วย AI จะใช้ไม่ได้ (ส่วนอื่นยังทำงาน)");

/* ---------- storage (ไฟล์ JSON เดียว เขียนแบบปลอดภัย) ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "db.json");
let db = { students: {}, staff: {}, triage: {}, settings: null, secret: null };
try {
  if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
} catch (e) {
  console.error("อ่านไฟล์ข้อมูลไม่ได้ จะไม่เขียนทับ:", e.message);
  process.exit(1);
}
if (!db.secret) db.secret = crypto.randomBytes(32).toString("hex");

let saveTimer = null;
function writeNow() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { writeNow(); } catch (e) { console.error("บันทึกไม่สำเร็จ:", e.message); } }, 300);
}
function flushSync() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } try { writeNow(); } catch (e) { /* ignore */ } }
process.on("SIGINT", () => { flushSync(); process.exit(0); });
process.on("SIGTERM", () => { flushSync(); process.exit(0); });
writeNow();

/* ---------- helpers ---------- */
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};
function sendJSON(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, BASE_HEADERS, extra || {}));
  res.end(body);
}
function readJSON(req, limit) {
  limit = limit || 400000;
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { tooBig = true; return; } chunks.push(c); });
    req.on("end", () => {
      if (tooBig) return reject({ status: 413 });
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject({ status: 400 }); }
    });
    req.on("error", () => reject({ status: 400 }));
  });
}
function clientIP(req) {
  if (TRUST_PROXY) {
    const x = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (x) return x;
  }
  return req.socket.remoteAddress || "unknown";
}
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v) => (Number.isFinite(v) ? v : 0);
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;

function getSettings() {
  const s = Object.assign({}, DEFAULTS, db.settings || {});
  if (!Array.isArray(s.categories) || !s.categories.length) s.categories = DEFAULTS.categories;
  if (!Array.isArray(s.hotlines)) s.hotlines = DEFAULTS.hotlines;
  if (typeof s.persona !== "string" || !s.persona.trim()) s.persona = DEFAULTS.persona;
  return s;
}
function publicSettings() {
  const s = getSettings();
  const o = Object.assign({}, s);
  delete o.persona; delete o.aiTier;
  return o;
}

/* ---------- student data ---------- */
function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = crypto.randomBytes(2).toString("hex").toUpperCase();
    if (!Object.values(db.students).some((s) => s.code === c)) return c;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function sanitizeMe(input, existing) {
  const out = {
    code: existing.code,
    created: existing.created,
    nick: "", anon: true,
    threads: {}, officer: { messages: [] }, suggestions: {},
    officerSeen: 0, updated: Date.now()
  };
  if (!input || typeof input !== "object") return out;
  out.anon = input.anon !== false;
  out.nick = out.anon ? "" : str(input.nick, 30);
  out.officerSeen = num(input.officerSeen);
  const th = input.threads && typeof input.threads === "object" ? input.threads : {};
  Object.keys(th).slice(0, 12).forEach((k) => {
    const t = th[k];
    if (!t || typeof t !== "object" || !ID_RE.test(String(t.id || ""))) return;
    const msgs = Array.isArray(t.messages) ? t.messages.slice(-120) : [];
    out.threads[t.id] = {
      id: t.id, started: num(t.started), updated: num(t.updated),
      risk: Math.max(0, Math.min(2, Math.floor(num(t.risk)))),
      messages: msgs.filter((m) => m && typeof m.text === "string" && ["me", "ai", "sys"].includes(m.r))
        .map((m) => ({ r: m.r, text: m.text.slice(0, 2500), t: num(m.t), greet: m.greet === true ? true : undefined }))
    };
  });
  const om = input.officer && Array.isArray(input.officer.messages) ? input.officer.messages.slice(-100) : [];
  out.officer.messages = om.filter((m) => m && typeof m.text === "string")
    .map((m) => ({ id: str(m.id, 60), text: m.text.slice(0, 1500), t: num(m.t), nick: out.anon ? "" : str(m.nick, 30) }));
  const sg = input.suggestions && typeof input.suggestions === "object" ? input.suggestions : {};
  Object.keys(sg).slice(0, 50).forEach((k) => {
    const s = sg[k];
    if (!s || typeof s.text !== "string" || !ID_RE.test(String(s.id || ""))) return;
    out.suggestions[s.id] = { id: s.id, cat: str(s.cat, 80), text: s.text.slice(0, 1500), t: num(s.t), nick: str(s.nick, 30) };
  });
  return out;
}
function studentFrom(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,80})$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const id = sha(m[1]);
  const s = db.students[id];
  return s ? { id, s } : null;
}
function repliesOf(id) { return (db.staff[id] && db.staff[id].replies) || {}; }

/* ---------- AI ---------- */
const CRISIS = /ฆ่าตัวตาย|อยากตาย|ไม่อยากมีชีวิต|ไม่อยากอยู่|ทำร้ายตัวเอง|กรีดแขน|กรีดข้อมือ|จบชีวิต|หายไปจากโลก|กินยาเกินขนาด|ล่วงละเมิด|ข่มขืน|โดนทำร้าย|ถูกทำร้าย/;
const aiDay = { date: "", n: 0 };
function aiBudgetOK() {
  const d = new Date().toISOString().slice(0, 10);
  if (aiDay.date !== d) { aiDay.date = d; aiDay.n = 0; }
  return aiDay.n < MAX_AI_PER_DAY;
}
async function callClaude(system, messages, tier) {
  const r = await fetch(API_BASE + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: tier === "quick" ? MODEL_QUICK : MODEL, max_tokens: 700, system, messages }),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error("AI API " + r.status);
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
function buildAI(body, settings) {
  const raw = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  let msgs = [];
  raw.forEach((m) => {
    if (!m || typeof m.text !== "string" || !m.text.trim()) return;
    const role = m.r === "me" ? "user" : m.r === "ai" ? "assistant" : null;
    if (!role) return;
    const text = m.text.slice(0, 2500);
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n" + text;
    else msgs.push({ role, content: text });
  });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  const hot = settings.hotlines.map((x) => x.label + " " + x.number).join(", ");
  const nick = str(body.nick, 30);
  const system = settings.persona +
    "\n\n---\nข้อมูลเพิ่มเติมสำหรับการตอบครั้งนี้\n- สายด่วนที่แนะนำได้: " + hot +
    "\n- ชื่อเล่นของน้อง: " + (nick || "ไม่ระบุ") +
    "\n- ตอบเป็นข้อความถัดไปของ \"พี่\" เท่านั้น ไม่ต้องใส่ชื่อผู้พูดนำหน้า" +
    "\n- ท้ายคำตอบทุกครั้ง ให้ขึ้นบรรทัดใหม่แล้วใส่แท็กประเมินความเสี่ยง [[RISK:n]] โดย n=0 คุยทั่วไป, n=1 เรื่องหนักที่ควรแนะนำพบแพทย์หรือผู้เชี่ยวชาญ, n=2 อันตรายเร่งด่วน (คิดอยากตาย ทำร้ายตัวเอง ถูกทำร้ายหรือถูกล่วงละเมิด) ห้ามอธิบายแท็กนี้ให้น้องฟัง";
  return { system, msgs };
}

/* ---------- admin auth ---------- */
const ADMIN_TTL = 12 * 3600 * 1000;
function adminCookieValue() {
  const exp = String(Date.now() + ADMIN_TTL);
  const sig = crypto.createHmac("sha256", db.secret).update("admin." + exp).digest("hex");
  return exp + "." + sig;
}
function isAdmin(req) {
  const m = /(?:^|;\s*)fj_admin=([0-9]+\.[0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (Number(exp) < Date.now()) return false;
  if (Number(exp) - ADMIN_TTL < (db.adminRevokedBefore || 0)) return false;
  const want = crypto.createHmac("sha256", db.secret).update("admin." + exp).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
function cookieFlags(req) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return "; HttpOnly; SameSite=Strict; Path=/" + (secure ? "; Secure" : "");
}
function sameDigest(a, b) {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname, method = req.method;
  const ip = clientIP(req);
  try {
    if (method === "GET" && p === "/api/settings") return sendJSON(res, 200, publicSettings());

    if (method === "POST" && p === "/api/session") {
      if (limited("sess:" + ip, 300, 3600000)) return sendJSON(res, 429, { error: "rate_limited" });
      const token = crypto.randomBytes(24).toString("base64url");
      const id = sha(token);
      db.students[id] = { code: newCode(), created: Date.now(), nick: "", anon: true, threads: {}, officer: { messages: [] }, suggestions: {}, officerSeen: 0, updated: Date.now() };
      save();
      return sendJSON(res, 200, { token, code: db.students[id].code });
    }

    if (p === "/api/me" || p === "/api/replies" || p === "/api/chat") {
      const st = studentFrom(req);
      if (!st) return sendJSON(res, 401, { error: "no_session" });
      if (limited("api:" + st.id, 240, 60000)) return sendJSON(res, 429, { error: "rate_limited" });

      if (method === "GET" && p === "/api/me") return sendJSON(res, 200, { me: st.s, replies: repliesOf(st.id), settings: publicSettings() });
      if (method === "GET" && p === "/api/replies") return sendJSON(res, 200, { replies: repliesOf(st.id) });
      if (method === "PUT" && p === "/api/me") {
        const body = await readJSON(req, 450000);
        const clean = sanitizeMe(body, st.s);
        if (Buffer.byteLength(JSON.stringify(clean)) > 400000) return sendJSON(res, 413, { error: "too_large" });
        db.students[st.id] = clean; save();
        return sendJSON(res, 200, { ok: true });
      }
      if (method === "POST" && p === "/api/chat") {
        const body = await readJSON(req, 60000);
        const settings = getSettings();
        const last = Array.isArray(body.messages) && body.messages.length ? String((body.messages[body.messages.length - 1] || {}).text || "") : "";
        const regexRisk = CRISIS.test(last) ? 2 : 0;
        if (!API_KEY || !settings.aiEnabled) return sendJSON(res, 503, { error: "ai_unavailable", risk: regexRisk });
        if (limited("chat:" + st.id, 12, 60000) || limited("chatday:" + st.id, 300, 86400000) || limited("chatip:" + ip, 120, 60000)) return sendJSON(res, 429, { error: "rate_limited", risk: regexRisk });
        if (!aiBudgetOK()) return sendJSON(res, 503, { error: "ai_unavailable", risk: regexRisk });
        const built = buildAI(body, settings);
        if (!built) return sendJSON(res, 400, { error: "bad_request" });
        aiDay.n++;
        let text;
        try { text = await callClaude(built.system, built.msgs, settings.aiTier); }
        catch (e) { console.error("เรียก AI ไม่สำเร็จ:", e.message); return sendJSON(res, 502, { error: "ai_failed", risk: regexRisk }); }
        const m = /\[\[RISK:\s*(\d)\s*\]\]/.exec(text);
        const tagRisk = m ? Math.min(2, Number(m[1])) : 0;
        const clean = text.replace(/\[\[RISK:\s*\d\s*\]\]/g, "").trim();
        if (!clean) return sendJSON(res, 502, { error: "ai_failed", risk: regexRisk });
        return sendJSON(res, 200, { text: clean, risk: Math.max(regexRisk, tagRisk) });
      }
      return sendJSON(res, 405, { error: "method" });
    }

    /* ----- admin ----- */
    if (p === "/api/admin/login" && method === "POST") {
      if (limited("login:" + ip, 10, 900000)) return sendJSON(res, 429, { error: "rate_limited" });
      const body = await readJSON(req, 5000);
      if (typeof body.password === "string" && sameDigest(body.password, ADMIN_PASSWORD)) {
        return sendJSON(res, 200, { ok: true }, { "Set-Cookie": "fj_admin=" + adminCookieValue() + "; Max-Age=" + ADMIN_TTL / 1000 + cookieFlags(req) });
      }
      return sendJSON(res, 401, { error: "bad_password" });
    }
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return sendJSON(res, 401, { error: "not_admin" });
      if (method !== "GET" && req.headers["x-requested-with"] !== "fj") return sendJSON(res, 403, { error: "csrf" });

      if (p === "/api/admin/logout" && method === "POST") {
        db.adminRevokedBefore = Date.now(); save();
        return sendJSON(res, 200, { ok: true }, { "Set-Cookie": "fj_admin=; Max-Age=0" + cookieFlags(req) });
      }
      if (p === "/api/admin/data" && method === "GET") {
        const students = {};
        Object.keys(db.students).forEach((id) => { students[id] = Object.assign({}, db.students[id], { replies: repliesOf(id) }); });
        return sendJSON(res, 200, { students, triage: db.triage, settings: getSettings(), defaults: DEFAULTS });
      }
      if (p === "/api/admin/reply" && method === "POST") {
        const b = await readJSON(req, 8000);
        const text = str(b.text, 1500).trim();
        if (!db.students[b.id] || !text) return sendJSON(res, 400, { error: "bad_request" });
        db.staff[b.id] = db.staff[b.id] || { replies: {} };
        const t = Date.now();
        db.staff[b.id].replies[String(t)] = { text, t };
        save();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === "/api/admin/triage" && method === "POST") {
        const b = await readJSON(req, 8000);
        if (!ID_RE.test(String(b.id || ""))) return sendJSON(res, 400, { error: "bad_request" });
        const status = ["open", "watching", "handled", "forwarded", "done"].includes(b.status) ? b.status : "open";
        db.triage[b.id] = { status, note: str(b.note, 800), t: Date.now() };
        save();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === "/api/admin/settings" && method === "PUT") {
        const b = await readJSON(req, 80000);
        const s = {};
        ["siteName", "heroTitle", "heroText", "cardConsult", "cardSuggest", "privacyNote", "disclaimer", "greeting", "officerName", "officerIntro", "persona"].forEach((k) => { s[k] = str(b[k], k === "persona" ? 20000 : 800).trim(); });
        s.categories = (Array.isArray(b.categories) ? b.categories : []).map((x) => str(x, 80).trim()).filter(Boolean).slice(0, 20);
        s.hotlines = (Array.isArray(b.hotlines) ? b.hotlines : []).map((x) => ({ label: str(x && x.label, 80).trim(), number: str(x && x.number, 60).trim() })).filter((x) => x.label && x.number).slice(0, 10);
        s.aiEnabled = b.aiEnabled === true;
        s.aiTier = b.aiTier === "quick" ? "quick" : "default";
        if (!s.categories.length || !s.persona) return sendJSON(res, 400, { error: "need_categories_and_persona" });
        db.settings = s; save();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === "/api/admin/settings/reset" && method === "POST") {
        db.settings = null; save();
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 404, { error: "not_found" });
    }
    return sendJSON(res, 404, { error: "not_found" });
  } catch (e) {
    if (e && e.status) return sendJSON(res, e.status, { error: e.status === 413 ? "too_large" : "bad_request" });
    console.error("ข้อผิดพลาด:", e && e.message);
    return sendJSON(res, 500, { error: "server" });
  }
}

/* ---------- static ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/admin") rel = "/admin.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("ไม่พบหน้านี้"); }
    res.writeHead(200, Object.assign({ "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" }, BASE_HEADERS));
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith("/api/")) return api(req, res, url);
  try { serveStatic(req, res, url); } catch (e) { res.writeHead(400); res.end(); }
});
server.listen(PORT, () => console.log("ฟังใจ เปิดที่ http://localhost:" + PORT + "  (มุมมองเจ้าของ: /admin)"));
