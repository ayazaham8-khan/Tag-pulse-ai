// Backend tests for POST /api/feedback. MOCKED: the email provider (Resend) and D1 (node:sqlite shim).
// Nothing here sends a real email. Run: node --no-warnings --test tests/feedback.test.mjs   (from the project root)
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { onRequestPost } = await import(pathToFileURL(path.join(HERE, "../functions/api/feedback.js")).href);

const TO = "owner-secret@example.org", FROM = "TagPulse Feedback <feedback@tagpulse.test>", KEY = "re_TEST_SECRET_KEY_123";
const MSG = "UNIQUE-FEEDBACK-TEXT-8841 The tag counter is great.";
const ADDR = "visitor-addr@example.com";

// D1 shim backed by node:sqlite. It models Cloudflare D1's documented behavior:
//  * D1 accepts numbered placeholders (?1, ?2 ...) that may be reused or reordered,
//    and throws if a referenced parameter was not bound. node:sqlite's handling of
//    numbered placeholders differs between Node releases, so this shim rewrites each
//    "?N" into a plain "?" and builds the argument list itself. That behaves the same
//    on every Node version instead of depending on the runtime's binding quirks.
//  * run() resolves { success, meta: { changes } } like D1; first() resolves a row or null.
function toPositional(sql, params) {
  if (!/\?\d+/.test(sql)) return { sql, args: params };      // plain "?" statements pass through
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => {
    const i = Number(n) - 1;
    if (!(i in params) || params[i] === undefined) throw new Error("D1_ERROR: missing bound value for ?" + n);
    args.push(params[i]);
    return "?";
  });
  return { sql: out, args };
}
const latency = () => new Promise((r) => setImmediate(r));   // D1 is a network call: let parallel requests interleave
function makeDB() {
  const raw = new DatabaseSync(":memory:");
  const stmt = (sql, p = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() { await latency(); const q = toPositional(sql, p); const r = raw.prepare(q.sql).run(...q.args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { await latency(); const q = toPositional(sql, p); const r = raw.prepare(q.sql).get(...q.args); return r === undefined ? null : Object.assign({}, r); }
  });
  return { raw, prepare: (s) => stmt(s) };
}

let providerCalls, providerReply, logs;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) {
    providerCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (providerReply === "throw") throw new Error("network down");
    return new Response(JSON.stringify(providerReply.body || {}), { status: providerReply.status });
  }
  return realFetch(url, init);
};
for (const k of ["log", "warn", "error"]) console[k] = (...a) => { logs.push(a); };
function reset(reply = { status: 200, body: { id: "em_1" } }) { providerCalls = []; providerReply = reply; logs = []; }

const failedOpen = () => logs.some((l) => String(l[0]).includes("rate-limit store unavailable"));
const ENV = (db) => ({ DB: db, RESEND_API_KEY: KEY, FEEDBACK_TO_EMAIL: TO, FEEDBACK_FROM_EMAIL: FROM });
async function send(body, { env, headers = {}, raw } = {}) {
  const payload = raw !== undefined ? raw : JSON.stringify(body);
  const request = new Request("https://tagpulse.test/api/feedback", { method: "POST", headers: Object.assign({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, headers), body: payload });
  const res = await onRequestPost({ request, env: env || ENV(makeDB()) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}
const good = (over = {}) => Object.assign({ type: "general", message: MSG, email: ADDR, website: "" }, over);

test("success only after the provider accepts: 200 {ok:true}, one provider call", async () => {
  reset(); const r = await send(good());
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true }); assert.equal(providerCalls.length, 1);
});
test("provider call: Resend endpoint, bearer key, configured from/to, fixed subject, reply_to, plain text", async () => {
  reset(); await send(good({ type: "problem" }));
  const c = providerCalls[0];
  assert.equal(c.url, "https://api.resend.com/emails");
  assert.equal(c.init.headers.Authorization, "Bearer " + KEY);
  assert.equal(c.body.from, FROM); assert.deepEqual(c.body.to, [TO]);
  assert.equal(c.body.subject, "[TagPulse feedback] Report a Problem");
  assert.equal(c.body.reply_to, ADDR);
  assert.ok(c.body.text.includes(MSG) && c.body.text.includes("Report a Problem"));
  assert.equal(c.body.html, undefined);
});
test("email is optional: no reply_to, still delivered", async () => {
  reset(); const r = await send(good({ email: "" }));
  assert.equal(r.status, 200); assert.equal(providerCalls[0].body.reply_to, undefined);
  assert.ok(providerCalls[0].body.text.includes("(not provided)"));
});
test("provider rejects (500 / 401 / 422): never reported as success, provider body not leaked", async () => {
  for (const st of [500, 401, 422]) {
    reset({ status: st, body: { message: "PROVIDER-SECRET-DETAIL for " + TO } });
    const r = await send(good());
    assert.equal(r.status, 502); assert.equal(r.json.ok, false);
    assert.ok(!r.text.includes("PROVIDER-SECRET") && !r.text.includes(TO) && !r.text.includes(KEY));
  }
});
test("provider unreachable (fetch throws): 502, not success", async () => {
  reset("throw"); const r = await send(good());
  assert.equal(r.status, 502); assert.equal(r.json.ok, false);
});
test("not configured (any of the three missing): 503, no provider call, no fake success", async () => {
  for (const missing of ["RESEND_API_KEY", "FEEDBACK_TO_EMAIL", "FEEDBACK_FROM_EMAIL"]) {
    reset(); const env = ENV(makeDB()); delete env[missing];
    const r = await send(good(), { env });
    assert.equal(r.status, 503); assert.equal(r.json.ok, false); assert.equal(providerCalls.length, 0);
  }
});
test("validation: missing/blank/oversized message, bad type, bad emails", async () => {
  const bad = [good({ message: "" }), good({ message: "   " }), good({ message: "x".repeat(2001) }), good({ type: "spam" }), good({ type: undefined }),
    good({ email: "not-an-email" }), good({ email: "a@b" }), good({ email: "a b@c.com" }), good({ email: "x".repeat(250) + "@a.com" }), good({ message: 42 })];
  for (const b of bad) { reset(); const r = await send(b); assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80)); assert.equal(providerCalls.length, 0); }
  reset(); assert.equal((await send(good({ message: "x".repeat(2000) }))).status, 200);
});
test("email-header injection: CR/LF in email is rejected; subject never contains user text; message CRLF stays in body", async () => {
  for (const e of ["a\u0007b@c.com", "a@b.com\r\nBcc: evil@x.com", "a@b.com\nBcc: evil@x.com", "a@b.com%0d%0aBcc:x"]) {
    reset(); const r = await send(good({ email: e })); assert.equal(r.status, 400); assert.equal(providerCalls.length, 0);
  }
  reset(); await send(good({ message: "hi\r\nSubject: hacked\r\nBcc: evil@x.com" }));
  assert.equal(providerCalls[0].body.subject, "[TagPulse feedback] General Feedback");
  assert.equal(providerCalls[0].body.bcc, undefined); assert.equal(providerCalls[0].body.cc, undefined);
});
test("honeypot filled -> rejected, no provider call", async () => {
  reset(); const r = await send(good({ website: "http://spam.example" }));
  assert.equal(r.status, 400); assert.equal(providerCalls.length, 0);
});
test("malformed / non-object / oversized bodies", async () => {
  reset(); assert.equal((await send(null, { raw: "{not json" })).status, 400);
  assert.equal((await send(null, { raw: "[1,2]" })).status, 400);
  assert.equal((await send(null, { raw: "null" })).status, 400);
  const huge = JSON.stringify(good({ message: "x".repeat(9000) }));
  assert.equal((await send(null, { raw: huge })).status, 413);
  assert.equal((await send(null, { raw: huge, headers: { "Content-Length": "999999" } })).status, 413);
  assert.equal(providerCalls.length, 0);
});
test("same-origin only: foreign Origin 403; same Origin and no Origin allowed", async () => {
  reset(); assert.equal((await send(good(), { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal(providerCalls.length, 0);
  assert.equal((await send(good(), { headers: { Origin: "https://tagpulse.test" } })).status, 200);
  assert.equal((await send(good())).status, 200);
});
test("rate limit: 5 per visitor per hour, 6th is 429; another visitor unaffected; only a hash is stored", async () => {
  reset(); const env = ENV(makeDB());
  for (let i = 0; i < 5; i++) assert.equal((await send(good(), { env })).status, 200);
  const sixth = await send(good(), { env });
  assert.equal(sixth.status, 429); assert.equal(sixth.json.error, "rate_limited"); assert.equal(providerCalls.length, 5);
  assert.equal(failedOpen(), false, "rate limiting silently failed open");
  assert.equal((await send(good(), { env, headers: { "CF-Connecting-IP": "198.51.100.7" } })).status, 200);
  const rows = env.DB.raw.prepare("SELECT * FROM feedback_attempts").all();
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("203.0.113.9") && !dump.includes(MSG) && !dump.includes(ADDR));
  assert.ok(/^[0-9a-f]{64}$/.test(rows[0].visitor_hash));
});
test("rate limit window expires and old rows are purged", async () => {
  reset(); const env = ENV(makeDB());
  for (let i = 0; i < 5; i++) await send(good(), { env });
  env.DB.raw.prepare("UPDATE feedback_attempts SET created_at = created_at - 4000").run();
  assert.equal((await send(good(), { env })).status, 200);
  assert.equal(failedOpen(), false, "rate limiting silently failed open");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM feedback_attempts").get().n, 1);
});
test("rate-limited and invalid requests do not consume provider calls; invalid ones do not use up the limit", async () => {
  reset(); const env = ENV(makeDB());
  for (let i = 0; i < 8; i++) await send(good({ message: "" }), { env });
  for (let i = 0; i < 5; i++) assert.equal((await send(good(), { env })).status, 200);
  assert.equal((await send(good(), { env })).status, 429);
  assert.equal(failedOpen(), false, "rate limiting silently failed open");
});
test("DB unavailable: fails open (still delivers), no crash", async () => {
  reset(); const r = await send(good(), { env: { RESEND_API_KEY: KEY, FEEDBACK_TO_EMAIL: TO, FEEDBACK_FROM_EMAIL: FROM } });
  assert.equal(r.status, 200);
  reset(); const broken = { prepare() { throw new Error("db down"); } };
  assert.equal((await send(good(), { env: ENV(broken) })).status, 200);
  assert.equal(failedOpen(), true, "the degraded path must be logged");
});
test("privacy: message, reply email, receiving address, key and provider text never appear in any log or any response", async () => {
  for (const reply of [{ status: 200 }, { status: 500, body: { message: "PROVIDER-SECRET" } }, "throw"]) {
    reset(reply); const r = await send(good());
    const all = JSON.stringify([logs, r.text]);
    for (const s of [MSG, "UNIQUE-FEEDBACK-TEXT", ADDR, TO, KEY, "PROVIDER-SECRET", "203.0.113.9"]) assert.ok(!all.includes(s), "leaked: " + s);
  }
  reset(); await send(good(), { env: Object.assign(ENV(makeDB()), { RESEND_API_KEY: "" }) });
  assert.ok(!JSON.stringify(logs).includes(KEY));
});
test("response never exposes configuration or provider details", async () => {
  reset(); const r = await send(good());
  assert.deepEqual(Object.keys(r.json), ["ok"]);
  reset({ status: 500 }); const f = await send(good());
  assert.deepEqual(Object.keys(f.json).sort(), ["error", "ok"]);
});

test("rate limit holds under a parallel burst (atomic check-and-insert): 12 simultaneous sends -> exactly 5 delivered, 7 limited", async () => {
  reset(); const env = ENV(makeDB());
  const rs = await Promise.all(Array.from({ length: 12 }, () => send(good(), { env })));
  assert.equal(rs.filter((r) => r.status === 200).length, 5);
  assert.equal(rs.filter((r) => r.status === 429).length, 7);
  assert.equal(providerCalls.length, 5);
  assert.equal(failedOpen(), false, "rate limiting silently failed open");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM feedback_attempts").get().n, 5);
});
test("rate-limit statements are valid D1 SQL: numbered placeholders, every parameter bound, a count is returned", async () => {
  reset(); const env = ENV(makeDB()); const seen = [];
  const spy = { prepare(sql) { seen.push(sql); return env.DB.prepare(sql); } };
  await send(good(), { env: Object.assign({}, env, { DB: spy }) });
  assert.equal(failedOpen(), false);
  assert.ok(seen.some((q) => /^INSERT INTO feedback_attempts/.test(q) && /\?1/.test(q) && /\?4/.test(q)), seen.join(" | "));
  assert.ok(seen.every((q) => !/\$|:\w/.test(q.replace(/'[^']*'/g, ""))), "only ?N placeholders are used");
});
test("a D1 that returns no change count is treated as 'store unavailable' (logged, fails open), never as a silent block or silent pass", async () => {
  reset(); const env = ENV(makeDB());
  const noMeta = { prepare(sql) { const s = env.DB.prepare(sql); return { bind: (...a) => { const b = s.bind(...a); return { run: async () => { await b.run(); return { success: true }; }, first: () => b.first() }; }, run: async () => { await s.run(); return { success: true }; } }; } };
  const r = await send(good(), { env: Object.assign({}, env, { DB: noMeta }) });
  assert.equal(r.status, 200); assert.equal(failedOpen(), true);
});
test("test shim fidelity: ?N may be reused/reordered, and a missing bound value throws like D1", async () => {
  const db = makeDB();
  await db.prepare("CREATE TABLE t (a INTEGER, b INTEGER)").run();
  const ins = await db.prepare("INSERT INTO t (a, b) VALUES (?2, ?1)").bind(10, 20).run();
  assert.equal(ins.meta.changes, 1);
  assert.deepEqual(await db.prepare("SELECT a, b FROM t WHERE a = ?1 AND b = ?2").bind(20, 10).first(), { a: 20, b: 10 });
  assert.deepEqual(await db.prepare("SELECT ?1 AS x, ?1 AS y").bind(7).first(), { x: 7, y: 7 });
  await assert.rejects(() => db.prepare("SELECT ?1, ?2").bind(1).first(), /missing bound value/);
});
