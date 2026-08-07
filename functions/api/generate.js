/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/generate
 * =============================================================
 *
 * This file lives at functions/api/generate.js, which Cloudflare
 * Pages automatically maps to the route /api/generate — no manual
 * routing configuration needed.
 *
 * Request body:  { "prompt": "<full prompt text built by the frontend>" }
 * Success (200): { "text": "<raw JSON string produced by the AI>" }
 * Failure (4xx/5xx): { "error": "<human-readable message>" }
 *
 * The Groq API key is read ONLY from context.env.GROQ_API_KEY,
 * which you set as an Environment Variable in the Cloudflare Pages
 * dashboard (see README.md). It is never hardcoded here and never
 * sent to the browser.
 * =============================================================
 */

// Groq's official OpenAI-compatible Chat Completions endpoint.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Primary model. If it's unavailable, callGroq() automatically retries
// with GROQ_MODEL_FALLBACK below — kept as constants so it's easy to
// find and change later if Groq renames/replaces either model.
const GROQ_MODEL_PRIMARY = "openai/gpt-oss-120b";
const GROQ_MODEL_FALLBACK = "llama-3.3-70b-versatile";

// How long we'll wait for Groq before giving up and returning a
// friendly timeout error instead of leaving the user's request hanging.
// Applied per attempt (primary and fallback each get their own window).
const GROQ_TIMEOUT_MS = 30000;

/**
 * Handles POST requests to /api/generate.
 * Cloudflare Pages calls this automatically — the function name
 * "onRequestPost" is what tells Pages which HTTP method it's for.
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = buildCorsHeaders();

  // Wrap everything so a bug here returns a clean JSON error instead
  // of a broken/empty response.
  try {
    // 1. Parse and validate the request body.
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400, corsHeaders);
    }

    const prompt = body && body.prompt;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return jsonResponse(
        { error: "A non-empty 'prompt' string is required." },
        400,
        corsHeaders
      );
    }

    // 2. Make sure the Pages project actually has an API key configured.
    if (!env.GROQ_API_KEY) {
      console.error("GROQ_API_KEY is not set in this Pages project's Environment Variables.");
      return jsonResponse(
        { error: "Server is not configured correctly (missing GROQ_API_KEY)." },
        500,
        corsHeaders
      );
    }

    // 3. Call Groq and translate any failure into a clean JSON error.
    try {
      const text = await callGroq(prompt, env.GROQ_API_KEY);
      return jsonResponse({ text: text }, 200, corsHeaders);
    } catch (err) {
      if (err && err.message === "GROQ_TIMEOUT") {
        return jsonResponse(
          { error: "The AI took too long to respond. Please try again." },
          504,
          corsHeaders
        );
      }
      console.error("Groq call failed:", err);
      return jsonResponse(
        { error: (err && err.message) || "Something went wrong generating your SEO listing." },
        502,
        corsHeaders
      );
    }
  } catch (err) {
    console.error("Unhandled error in /api/generate:", err);
    return jsonResponse(
      { error: "Unexpected server error. Please try again." },
      500,
      corsHeaders
    );
  }
}

/**
 * Handles the CORS "preflight" OPTIONS request that browsers send
 * before certain POST requests. Without this, some browsers would
 * block the real POST request before it's even sent.
 */
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: buildCorsHeaders() });
}

/**
 * Calls Groq's Chat Completions API with the primary model, and
 * automatically retries once with the fallback model if the primary
 * one errors out (e.g. temporarily unavailable, decommissioned, or
 * rate-limited). Returns the raw text content of the AI's reply.
 * Throws an Error (message "GROQ_TIMEOUT" on timeout) on failure.
 */
async function callGroq(prompt, apiKey) {
  try {
    return await callGroqModel(GROQ_MODEL_PRIMARY, prompt, apiKey);
  } catch (err) {
    // A timeout is a genuine failure of that specific attempt, not a
    // sign the model is unavailable — surface it as-is rather than
    // burning a second attempt (and a second 30s wait) on the fallback.
    if (err && err.message === "GROQ_TIMEOUT") {
      throw err;
    }
    console.error(GROQ_MODEL_PRIMARY + " failed, falling back to " + GROQ_MODEL_FALLBACK + ":", err);
    return await callGroqModel(GROQ_MODEL_FALLBACK, prompt, apiKey);
  }
}

/**
 * Calls Groq's OpenAI-compatible /chat/completions endpoint for a
 * single specific model and returns the assistant message's text.
 */
async function callGroqModel(model, prompt, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
        // "json_object" mode guarantees syntactically valid JSON output.
        // The exact shape (title/tags/description) is already spelled
        // out in the prompt itself, which Groq requires for json_object
        // mode to work reliably.
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("GROQ_TIMEOUT");
    }
    throw new Error("Couldn't reach the AI service. Please try again.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let message = "Groq request failed (" + res.status + ").";
    try {
      const errBody = await res.json();
      if (errBody && errBody.error && errBody.error.message) {
        message = errBody.error.message;
      }
    } catch (e) {
      // Response wasn't JSON — fall back to the generic message above.
    }
    throw new Error(message);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error("Received a malformed response from the AI service.");
  }

  const choice = data && data.choices && data.choices[0];
  if (!choice || choice.finish_reason === "content_filter") {
    throw new Error("The AI couldn't generate a result for this input. Try rephrasing your product keyword.");
  }

  const text = choice.message && choice.message.content;
  if (!text) {
    throw new Error("The AI didn't return a usable result. Please try again.");
  }

  return text;
}

/**
 * Small helper so every response in this file is built the same way:
 * JSON body, correct status code, and CORS headers attached.
 */
function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders)
  });
}

/**
 * CORS headers for this endpoint. Wide open ("*") by default so the
 * app works immediately after deploy. If you'd rather lock this down
 * to just your own domain once you have one, change "*" below to your
 * site's URL, e.g. "https://tagpulse-ai.pages.dev".
 */
function buildCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
