/**
 * =============================================================
 * TagPulse AI — Cloudflare Worker backend
 * =============================================================
 *
 * This Worker does two jobs:
 *
 *   1. Serves the static site (index.html and any other files in
 *      the `public/` folder) via the `assets` binding configured
 *      in wrangler.jsonc.
 *
 *   2. Handles the app's two backend API routes:
 *        POST /api/generate         -> calls Google Gemini
 *        POST /api/verify-license   -> checks a Pro unlock code
 *
 * The Gemini API key is read ONLY from an environment variable
 * (env.GEMINI_API_KEY) that you set with `wrangler secret put`.
 * It is never hardcoded here and never sent to the browser.
 *
 * No Gumroad integration yet — /api/verify-license currently only
 * accepts the local "TEST" bypass code, exactly like the frontend
 * did before this migration. The full Gumroad license-verification
 * logic is included below as a ready-to-enable commented block.
 * =============================================================
 */

// The exact Gemini model TagPulse AI uses. Kept as a single constant
// so it's easy to find and change later if Google renames/replaces it.
const GEMINI_MODEL = "gemini-3.6-flash";

// How long we'll wait for Gemini before giving up and returning a
// friendly timeout error instead of leaving the user's request hanging.
const GEMINI_TIMEOUT_MS = 30000;

// Local test code that unlocks Pro during development. This mirrors
// the DEV_BYPASS_CODE that used to live in the frontend — see the
// "GUMROAD (uncomment when ready)" block in handleVerifyLicense below
// for how to replace this with real license checks later.
const DEV_BYPASS_CODE = "TEST";

// Not used yet (Gumroad isn't wired up), but left here ready to go —
// set this to your real Gumroad product permalink when you enable the
// commented-out Gumroad block in handleVerifyLicense.
const GUMROAD_PERMALINK = "YOUR_GUMROAD_PRODUCT_PERMALINK";

export default {
  /**
   * Every request to the Worker — for both the static site and the
   * API routes — comes through this single fetch() handler.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = buildCorsHeaders();

    // Browsers send a CORS "preflight" OPTIONS request before certain
    // POST requests. Answer it immediately so the real POST can follow.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Wrap everything in a top-level try/catch so a bug anywhere in
    // our own code returns a clean JSON error instead of crashing the
    // Worker or hanging the request.
    try {
      if (url.pathname === "/api/generate") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Use POST for /api/generate." }, 405, corsHeaders);
        }
        return await handleGenerate(request, env, corsHeaders);
      }

      if (url.pathname === "/api/verify-license") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Use POST for /api/verify-license." }, 405, corsHeaders);
        }
        return await handleVerifyLicense(request, env, corsHeaders);
      }

      // Any other /api/* path doesn't exist.
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({ error: "Not found." }, 404, corsHeaders);
      }

      // Not an API route at all — hand off to Cloudflare's static
      // asset serving, which serves index.html and friends from the
      // `public/` folder configured in wrangler.jsonc.
      return env.ASSETS.fetch(request);

    } catch (err) {
      console.error("Unhandled Worker error:", err);
      return jsonResponse(
        { error: "Unexpected server error. Please try again." },
        500,
        corsHeaders
      );
    }
  }
};

/**
 * POST /api/generate
 * Body: { "prompt": "<full prompt text built by the frontend>" }
 * Success: 200 { "text": "<raw JSON string produced by Gemini>" }
 * Failure: 4xx/5xx { "error": "<human-readable message>" }
 */
async function handleGenerate(request, env, corsHeaders) {
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

  // 2. Make sure the server actually has an API key configured.
  if (!env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in the Worker environment.");
    return jsonResponse(
      { error: "Server is not configured correctly (missing GEMINI_API_KEY)." },
      500,
      corsHeaders
    );
  }

  // 3. Call Gemini and translate any failure into a clean JSON error.
  try {
    const text = await callGemini(prompt, env.GEMINI_API_KEY);
    return jsonResponse({ text: text }, 200, corsHeaders);
  } catch (err) {
    if (err && err.message === "GEMINI_TIMEOUT") {
      return jsonResponse(
        { error: "The AI took too long to respond. Please try again." },
        504,
        corsHeaders
      );
    }
    console.error("Gemini call failed:", err);
    return jsonResponse(
      { error: (err && err.message) || "Something went wrong generating your SEO listing." },
      502,
      corsHeaders
    );
  }
}

/**
 * Calls the Gemini generateContent endpoint with the same
 * generationConfig / responseSchema the frontend used to send
 * directly, and returns the raw text of Gemini's first candidate.
 * Throws an Error (with message "GEMINI_TIMEOUT" on timeout) on
 * any failure, which handleGenerate() turns into a JSON response.
 */
async function callGemini(prompt, apiKey) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL +
    ":generateContent?key=" +
    apiKey;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              tags: { type: "ARRAY", items: { type: "STRING" } },
              description: { type: "STRING" }
            },
            required: ["title", "tags", "description"]
          }
        }
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("GEMINI_TIMEOUT");
    }
    // Network-level failure reaching Google at all.
    throw new Error("Couldn't reach the AI service. Please try again.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let message = "Gemini request failed (" + res.status + ").";
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

  const candidate = data && data.candidates && data.candidates[0];
  if (!candidate || candidate.finishReason === "SAFETY") {
    throw new Error("The AI couldn't generate a result for this input. Try rephrasing your product keyword.");
  }

  const text =
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts[0] &&
    candidate.content.parts[0].text;

  if (!text) {
    throw new Error("The AI didn't return a usable result. Please try again.");
  }

  return text;
}

/**
 * POST /api/verify-license
 * Body: { "code": "<whatever the user typed into the Pro unlock field>" }
 * Success: 200 { "valid": true|false, "message": "<shown to the user>" }
 * Failure: 4xx/5xx { "error": "<human-readable message>" }
 *
 * NOTE: per the current project scope, this does NOT call Gumroad yet.
 * It only checks the local DEV_BYPASS_CODE, exactly matching the
 * frontend's previous behavior before this migration. The full Gumroad
 * flow is included below as a ready-to-enable commented block.
 */
async function handleVerifyLicense(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, corsHeaders);
  }

  const code = body && typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return jsonResponse({ error: "A non-empty 'code' string is required." }, 400, corsHeaders);
  }

  // ---- TEST-ONLY (current) ----
  if (code.toUpperCase() === DEV_BYPASS_CODE) {
    return jsonResponse(
      { valid: true, message: "Pro unlocked (test mode)." },
      200,
      corsHeaders
    );
  }
  return jsonResponse(
    {
      valid: false,
      message: "That code isn't valid yet — Gumroad checkout isn't live. Use the test code during development."
    },
    200,
    corsHeaders
  );

  // ---- GUMROAD (uncomment when ready, and remove the "TEST-ONLY" ----
  // ---- block above — everything else in index.html and this file ----
  // ---- stays exactly the same). ----
  //
  // try {
  //   const params = new URLSearchParams();
  //   params.append("product_permalink", GUMROAD_PERMALINK);
  //   params.append("license_key", code);
  //
  //   const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
  //     method: "POST",
  //     headers: { "Content-Type": "application/x-www-form-urlencoded" },
  //     body: params.toString()
  //   });
  //   const data = await res.json();
  //
  //   if (data && data.success) {
  //     const purchase = data.purchase || {};
  //     if (purchase.refunded || purchase.chargebacked || purchase.disputed) {
  //       return jsonResponse(
  //         { valid: false, message: "This license key is no longer valid (refunded or disputed)." },
  //         200,
  //         corsHeaders
  //       );
  //     }
  //     return jsonResponse({ valid: true, message: "Pro unlocked!" }, 200, corsHeaders);
  //   }
  //
  //   return jsonResponse(
  //     { valid: false, message: (data && data.message) || "That license key isn't valid. Please double-check and try again." },
  //     200,
  //     corsHeaders
  //   );
  // } catch (err) {
  //   console.error("Gumroad verification failed:", err);
  //   return jsonResponse(
  //     { error: "Couldn't verify your key right now. Please try again." },
  //     502,
  //     corsHeaders
  //   );
  // }
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
 * CORS headers for the API routes. Wide open ("*") by default so the
 * app works immediately after deploy. If you'd rather lock this down
 * to just your own domain once you have one, change "*" below to your
 * site's URL, e.g. "https://tagpulse-ai.your-subdomain.workers.dev".
 */
function buildCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
