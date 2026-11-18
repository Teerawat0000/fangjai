"use strict";
/* ทดสอบทั้งระบบ: เปิด AI จำลอง + เซิร์ฟเวอร์จริง แล้วยิง API ตามลำดับ */
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const MOCK_PORT = 4101, APP_PORT = 4100;
const seen = [];
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const j = JSON.parse(b || "{}");
    seen.push({ key: req.headers["x-api-key"], ver: req.headers["anthropic-version"], body: j });
    const last = j.messages[j.messages.length - 1].content;
    const risky = /อยากตาย/.test(last);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: (risky ? "พี่เป็นห่วงน้องนะ" : "ช่วงนี้เหนื่อยมากเลยนะ อะไรหนักที่สุดเหรอ") + "\n[[RISK:" + (risky ? 2 : 0) + "]]" }] }));
  });
});

let child, dir, pass = 0;
const base = "http://127.0.0.1:" + APP_PORT;
async function J(method, url, body, headers) {
  const r = await fetch(base + url, { method, headers: Object.assign(body ? { "content-type": "application/json" } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data, headers: r.headers };
}
function ok(name, cond) { assert.ok(cond, "ไม่ผ่าน: " + name); pass++; console.log("ผ่าน  " + name); }

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fj-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { PORT: APP_PORT, DATA_DIR: dir, ADMIN_PASSWORD: "test-password-123", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:" + MOCK_PORT })
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/settings"); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }

  /* settings สาธารณะต้องไม่มีคำสั่ง AI */
  let r = await J("GET", "/api/settings");
  ok("settings สาธารณะเปิดได้", r.status === 200 && r.data.siteName === "ฟังใจ");
  ok("settings สาธารณะไม่มีคำสั่ง AI", r.data.persona === undefined && r.data.aiTier === undefined);

  /* ต้องมีเซสชันก่อน */
  r = await J("GET", "/api/me");
  ok("ไม่มีโทเคน = 401", r.status === 401);
  r = await J("POST", "/api/chat", { messages: [{ r: "me", text: "สวัสดี" }] });
  ok("แชทโดยไม่มีโทเคน = 401", r.status === 401);

  r = await J("POST", "/api/session", {});
  ok("สร้างเซสชันได้", r.status === 200 && r.data.token.length >= 30 && /^[0-9A-F]{4}$/.test(r.data.code));
  const tok = r.data.token, code = r.data.code, A = { authorization: "Bearer " + tok };

  r = await J("GET", "/api/me", null, A);
  ok("อ่านข้อมูลตัวเองได้", r.status === 200 && r.data.me.code === code && r.data.me.anon === true);

  /* บันทึกข้อมูล + ตัดของแปลกปลอม */
  const me = {
    code: "HACK", anon: false, nick: "ฟ้า", evil: "x",
    threads: { t1: { id: "t1", started: 1, updated: 2, risk: 99, messages: [{ r: "me", text: "เครียดเรื่องสอบ", t: 1 }, { r: "admin", text: "ปลอม", t: 2 }, { r: "ai", text: "ฟังอยู่นะ", t: 3 }] }, "bad id!": { id: "bad id!", messages: [] } },
    officer: { messages: [{ id: "o1", text: "อยากคุยกับครู", t: 5, nick: "ฟ้า" }] },
    suggestions: { s1: { id: "s1", cat: "อาหาร", text: "ขอน้ำดื่มเย็น", t: 6, nick: "ฟ้า" } }, officerSeen: 0
  };
  r = await J("PUT", "/api/me", me, A);
  ok("บันทึกข้อมูลได้", r.status === 200);
  r = await J("GET", "/api/me", null, A);
  const saved = r.data.me;
  ok("รหัสถูกกำหนดโดยเซิร์ฟเวอร์ ปลอมไม่ได้", saved.code === code && saved.evil === undefined);
  ok("risk ถูกจำกัด 0-2", saved.threads.t1.risk === 2);
  ok("ข้อความบทบาทปลอมถูกตัด", saved.threads.t1.messages.length === 2);
  ok("id แปลกถูกตัด", Object.keys(saved.threads).length === 1);
  ok("ชื่อเล่นและข้อเสนอถูกเก็บ", saved.nick === "ฟ้า" && saved.suggestions.s1.text === "ขอน้ำดื่มเย็น");
  r = await J("PUT", "/api/me", { anon: true, nick: "ควรถูกลบ", threads: {}, officer: { messages: [] }, suggestions: {} }, A);
  r = await J("GET", "/api/me", null, A);
  ok("โหมดไม่ระบุตัวตนลบชื่อเล่น", r.data.me.anon === true && r.data.me.nick === "");
  await J("PUT", "/api/me", me, A);
  const big = { threads: {}, officer: { messages: [] }, suggestions: {}, pad: "x".repeat(500000) };
  r = await J("PUT", "/api/me", big, A);
  ok("ข้อมูลใหญ่เกินถูกปฏิเสธ", r.status === 413);

  /* แชท AI */
  r = await J("POST", "/api/chat", { messages: [{ r: "ai", text: "สวัสดี" }, { r: "me", text: "เครียดเรื่องสอบ" }], nick: "ฟ้า" }, A);
  ok("แชท AI ตอบได้ และไม่มีแท็กเสี่ยง", r.status === 200 && r.data.text.includes("เหนื่อย") && !/RISK/.test(r.data.text) && r.data.risk === 0);
  const call1 = seen[0];
  ok("ส่งคีย์และเวอร์ชันถูกต้อง", call1.key === "sk-ant-test" && call1.ver === "2023-06-01");
  ok("ข้อความเริ่มด้วย user และสลับบทบาทถูก", call1.body.messages[0].role === "user" && call1.body.messages.length === 1);
  ok("คำสั่งบุคลิกและสายด่วนอยู่ใน system", call1.body.system.includes("พี่") && call1.body.system.includes("1323") && call1.body.system.includes("ฟ้า"));
  r = await J("POST", "/api/chat", { messages: [{ r: "me", text: "หนูอยากตาย" }] }, A);
  ok("คำเสี่ยงได้ risk=2", r.status === 200 && r.data.risk === 2);
  r = await J("POST", "/api/chat", { messages: [{ r: "ai", text: "ทัก" }] }, A);
  ok("ข้อความสุดท้ายไม่ใช่ของน้อง = 400", r.status === 400);

  /* แอดมิน */
  r = await J("GET", "/api/admin/data");
  ok("แอดมินโดยไม่ล็อกอิน = 401", r.status === 401);
  r = await J("POST", "/api/admin/login", { password: "ผิด" });
  ok("รหัสผ่านผิด = 401", r.status === 401);
  r = await J("POST", "/api/admin/login", { password: "test-password-123" });
  ok("รหัสผ่านถูกเข้าได้", r.status === 200);
  const setCookie = r.headers.get("set-cookie");
  ok("คุกกี้เป็น HttpOnly + SameSite=Strict", /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie));
  const cookie = setCookie.split(";")[0], AD = { cookie, "x-requested-with": "fj" };
  r = await J("GET", "/api/admin/data", null, { cookie });
  const ids = Object.keys(r.data.students);
  ok("แอดมินเห็นข้อมูลน้อง", r.status === 200 && ids.length === 1 && r.data.students[ids[0]].code === code);
  ok("แอดมินเห็นคำสั่ง AI", typeof r.data.settings.persona === "string" && r.data.settings.persona.length > 100);
  ok("ไม่เปิดเผยโทเคนของน้อง", !JSON.stringify(r.data).includes(tok));
  const sid = ids[0];

  r = await J("POST", "/api/admin/reply", { id: sid, text: "ครูอยู่ห้องแนะแนวนะ" }, { cookie });
  ok("ส่งคำขอแอดมินโดยไม่มีหัว CSRF = 403", r.status === 403);
  r = await J("POST", "/api/admin/reply", { id: sid, text: "ครูอยู่ห้องแนะแนวนะ" }, AD);
  ok("เจ้าหน้าที่ตอบน้องได้", r.status === 200);
  r = await J("GET", "/api/replies", null, A);
  ok("น้องเห็นคำตอบ", Object.values(r.data.replies).some((x) => x.text === "ครูอยู่ห้องแนะแนวนะ"));
  r = await J("POST", "/api/admin/triage", { id: "t1", status: "handled", note: "คุยกับครูแล้ว" }, AD);
  ok("ตั้งสถานะเรื่องได้", r.status === 200);
  r = await J("GET", "/api/admin/data", null, { cookie });
  ok("สถานะและบันทึกถูกเก็บ", r.data.triage.t1.status === "handled" && r.data.triage.t1.note === "คุยกับครูแล้ว");
  r = await J("GET", "/api/me", null, A);
  ok("น้องไม่เห็นบันทึกของเจ้าของ", !JSON.stringify(r.data).includes("คุยกับครูแล้ว"));

  const cur = (await J("GET", "/api/admin/data", null, { cookie })).data.settings;
  const next = Object.assign({}, cur, { siteName: "ฟังใจ ทดสอบ", persona: "คำสั่งใหม่ของฉัน", hotlines: [{ label: "ครูแนะแนว", number: "โทร 100" }] });
  r = await J("PUT", "/api/admin/settings", next, AD);
  ok("แก้ตั้งค่าเว็บได้", r.status === 200);
  r = await J("GET", "/api/settings");
  ok("น้องเห็นชื่อและสายด่วนใหม่ แต่ไม่เห็นคำสั่ง AI", r.data.siteName === "ฟังใจ ทดสอบ" && r.data.hotlines[0].label === "ครูแนะแนว" && r.data.persona === undefined);
  await J("POST", "/api/chat", { messages: [{ r: "me", text: "ทดสอบคำสั่งใหม่" }] }, A);
  ok("คำสั่ง AI ใหม่ถูกใช้จริง", seen[seen.length - 1].body.system.startsWith("คำสั่งใหม่ของฉัน"));
  r = await J("PUT", "/api/admin/settings", Object.assign({}, next, { categories: [] }), AD);
  ok("ตั้งค่าไม่ครบถูกปฏิเสธ", r.status === 400);
  r = await J("POST", "/api/admin/settings/reset", {}, AD);
  r = await J("GET", "/api/settings");
  ok("คืนค่าเริ่มต้นได้", r.data.siteName === "ฟังใจ");

  /* ปิด AI */
  const cur2 = (await J("GET", "/api/admin/data", null, { cookie })).data.settings;
  await J("PUT", "/api/admin/settings", Object.assign({}, cur2, { aiEnabled: false }), AD);
  r = await J("POST", "/api/chat", { messages: [{ r: "me", text: "หนูอยากตาย" }] }, A);
  ok("ปิด AI แล้วตอบ 503 แต่ยังประเมินเสี่ยงให้", r.status === 503 && r.data.risk === 2);
  await J("PUT", "/api/admin/settings", Object.assign({}, cur2, { aiEnabled: true }), AD);

  /* ล็อกเอาต์ */
  r = await J("POST", "/api/admin/logout", {}, AD);
  ok("ออกจากระบบได้", r.status === 200);
  r = await J("GET", "/api/admin/data", null, { cookie });
  ok("คุกกี้เดิมใช้ไม่ได้หลังออกจากระบบ", r.status === 401);

  /* ไฟล์หน้าเว็บและความปลอดภัยของไฟล์ */
  r = await fetch(base + "/");
  const html = await r.text();
  ok("หน้าแรกเปิดได้", r.status === 200 && html.includes("ฟังใจ") && !html.includes("admin.js"));
  r = await fetch(base + "/admin");
  ok("หน้าเจ้าของเปิดได้", r.status === 200 && (await r.text()).includes("admin.js"));
  r = await fetch(base + "/..%2fserver.js");
  ok("เข้าถึงไฟล์นอก public ไม่ได้", r.status !== 200);
  r = await fetch(base + "/%2e%2e/.env");
  ok("เข้าถึง .env ไม่ได้", r.status !== 200);
  r = await fetch(base + "/db.json");
  ok("เข้าถึงฐานข้อมูลไม่ได้", r.status === 404);

  /* จำกัดความถี่แชท */
  const t2 = (await J("POST", "/api/session", {})).data.token;
  let last;
  for (let i = 0; i < 14; i++) last = await J("POST", "/api/chat", { messages: [{ r: "me", text: "ทดสอบ " + i }] }, { authorization: "Bearer " + t2 });
  ok("แชทถี่เกิน 12 ครั้ง/นาทีถูกจำกัด", last.status === 429);

  /* ข้อมูลยังอยู่หลังรีสตาร์ต */
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { PORT: APP_PORT, DATA_DIR: dir, ADMIN_PASSWORD: "test-password-123", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:" + MOCK_PORT }) });
  for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/settings"); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  r = await J("GET", "/api/me", null, A);
  ok("รีสตาร์ตแล้วข้อมูลและโทเคนเดิมยังใช้ได้", r.status === 200 && r.data.me.code === code && Object.keys(r.data.replies).length === 1);
  r = await J("GET", "/api/admin/data", null, { cookie });
  ok("รีสตาร์ตแล้วคุกกี้ที่ออกจากระบบไปแล้วยังใช้ไม่ได้", r.status === 401);

  console.log("\nผ่านทั้งหมด " + pass + " ข้อ");
  child.kill("SIGTERM"); mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => {
  console.error("\nล้มเหลว:", e.message);
  if (child) child.kill("SIGTERM");
  mock.close(); process.exit(1);
});
