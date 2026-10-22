/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/feedback
 *
 * Simple feedback-to-email. No ticketing, no storage of messages.
 *
 * REQUIRED CONFIGURATION (Pages > Settings > Variables and Secrets):
 *   RESEND_API_KEY       secret   API key of your Resend account
 *   FEEDBACK_TO_EMAIL    secret   where feedback is delivered (never sent
 *                                 to the browser)
 *   FEEDBACK_FROM_EMAIL  variable the verified sender, e.g.
 *                                 "TagPulse Feedback <feedback@your-domain>"
 *
 * Until all three exist this endpoint answers 503 and the form shows its
 * "couldn't send" message. It NEVER reports success unless the email
 * provider itself accepted the message (HTTP 2xx from Resend).
 *
 * Safeguards: same-origin check, 8 KB body cap, strict server-side
 * validation, honeypot field, per-visitor rate limit in D1 (only a salted
 * hash of the IP is kept, never the IP or the message), fixed email
 * subject (no user text in headers), reply-to only when the optional
 * address passes validation, provider responses never returned to the
 * browser, and no message text or email address is ever logged.
 * =============================================================
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_MESSAGE_CHARS = 2000;
const MAX_EMAIL_CHARS = 254;
const RATE_LIMIT_MAX = 5;             // messages ...
const RATE_LIMIT_WINDOW_SEC = 3600;   // ... per visitor per hour
const PROVIDER_TIMEOUT_MS = 10000;

const TYPE_LABELS = {
  general: "General Feedback",
  problem: "Report a Problem",
  question: "Ask a Question",
  improvement: "Suggest an Improvement"
};

const EMAIL_RE = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]{2,}$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function hasControlChars(value) {
  // CR/LF and other control characters (header-injection guard).
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

/**
 * Returns true when this visitor may send. Fails OPEN (returns true) if
 * the database is unavailable, matching how the rest of the app degrades,
 * because the other safeguards still apply.
 */
async function consumeRateLimit(env, request) {
  try {
    if (!env.DB) return true;
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = await sha256Hex("tagpulse-feedback:" + ip);
    const now = Math.floor(Date.now() / 1000);
    const since = now - RATE_LIMIT_WINDOW_SEC;

    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS feedback_attempts (visitor_hash TEXT NOT NULL, created_at INTEGER NOT NULL)"
    ).run();
    await env.DB.prepare("DELETE FROM feedback_attempts WHERE created_at < ?1").bind(since).run();

    // ONE atomic statement: insert this attempt only if the visitor is still
    // under the limit. A separate count-then-insert would let a burst of
    // parallel requests all read "0 so far" and all pass. D1 reports the
    // number of inserted rows in meta.changes (1 = allowed, 0 = limit hit).
    const result = await env.DB.prepare(
      "INSERT INTO feedback_attempts (visitor_hash, created_at) " +
      "SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM feedback_attempts WHERE visitor_hash = ?1 AND created_at >= ?3) < ?4"
    ).bind(key, now, since, RATE_LIMIT_MAX).run();

    if (!result || !result.meta || typeof result.meta.changes !== "number") {
      throw new Error("no change count returned");   // unknown outcome: handled below as "store unavailable"
    }
    return result.meta.changes === 1;
  } catch (err) {
    console.error("[TagPulse][feedback] rate-limit store unavailable - continuing without it");
    return true;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Same-origin only (browsers always send Origin on a cross-site POST).
    const origin = request.headers.get("Origin");
    if (origin) {
      let originHost = "";
      try { originHost = new URL(origin).host; } catch (_) {}
      if (originHost !== new URL(request.url).host) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    // 2. Delivery must be configured; otherwise we cannot honestly accept it.
    if (!env.RESEND_API_KEY || !env.FEEDBACK_TO_EMAIL || !env.FEEDBACK_FROM_EMAIL) {
      console.error("[TagPulse][feedback] not configured: set RESEND_API_KEY, FEEDBACK_TO_EMAIL and FEEDBACK_FROM_EMAIL");
      return json({ ok: false, error: "unavailable" }, 503);
    }

    // 3. Size limit, then parse.
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_BODY_BYTES) return json({ ok: false, error: "too_large" }, 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ ok: false, error: "too_large" }, 413);

    let body;
    try { body = JSON.parse(raw); } catch (_) { return json({ ok: false, error: "invalid" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "invalid" }, 400);

    // 4. Validate. A filled honeypot is treated as an invalid request.
    if (typeof body.website === "string" && body.website.trim() !== "") return json({ ok: false, error: "invalid" }, 400);

    const type = typeof body.type === "string" && Object.prototype.hasOwnProperty.call(TYPE_LABELS, body.type) ? body.type : null;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";

    if (!type || !message || message.length > MAX_MESSAGE_CHARS) return json({ ok: false, error: "invalid" }, 400);
    if (email && (email.length > MAX_EMAIL_CHARS || hasControlChars(email) || !EMAIL_RE.test(email))) {
      return json({ ok: false, error: "invalid" }, 400);
    }

    // 5. Per-visitor rate limit.
    if (!(await consumeRateLimit(env, request))) {
      return json({ ok: false, error: "rate_limited" }, 429);
    }

    // 6. Hand to the provider. Subject is fixed; user text goes only in the
    //    plain-text body.
    const payload = {
      from: env.FEEDBACK_FROM_EMAIL,
      to: [env.FEEDBACK_TO_EMAIL],
      subject: "[TagPulse feedback] " + TYPE_LABELS[type],
      text:
        "Type: " + TYPE_LABELS[type] + "\n" +
        "Reply email: " + (email || "(not provided)") + "\n" +
        "\n" + message + "\n"
    };
    if (email) payload.reply_to = email;

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, PROVIDER_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.RESEND_API_KEY
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Status only: the provider's body and our contents are never logged or returned.
      console.error("[TagPulse][feedback] email provider rejected the message", { status: res.status });
      return json({ ok: false, error: "send_failed" }, 502);
    }

    console.log("[TagPulse][feedback] delivered to provider", { type: type, messageChars: message.length, hasReplyEmail: !!email });
    return json({ ok: true }, 200);

  } catch (err) {
    console.error("[TagPulse][feedback] unexpected failure", { name: err && err.name });
    return json({ ok: false, error: "send_failed" }, 502);
  }
}
