/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/verify-license
 * =============================================================
 *
 * This file lives at functions/api/verify-license.js, which
 * Cloudflare Pages automatically maps to the route
 * /api/verify-license — no manual routing configuration needed.
 *
 * Request body:  { "code": "<whatever the user typed into the Pro unlock field>" }
 * Success (200): { "valid": true|false, "message": "<shown to the user>" }
 * Failure (4xx/5xx): { "error": "<human-readable message>" }
 *
 * IMPORTANT — current scope: this does NOT integrate Gumroad yet.
 * It only accepts the temporary development code "TEST" to unlock
 * Pro; everything else is reported as invalid. The full Gumroad
 * license-verification flow is included below as a ready-to-enable
 * commented block for when you're ready to replace this.
 * =============================================================
 */

// Temporary development-only unlock code. Anyone who enters this
// exact code (case-insensitive) gets Pro access. This is intentional
// for now, per current project scope — replace it with real Gumroad
// verification (see the commented block below) before sharing the
// site with real customers.
const DEV_BYPASS_CODE = "TEST";

// Not used yet (Gumroad isn't wired up), but left here ready to go —
// set this to your real Gumroad product permalink when you enable the
// commented-out Gumroad block below.
const GUMROAD_PERMALINK = "YOUR_GUMROAD_PRODUCT_PERMALINK";

/**
 * Handles POST requests to /api/verify-license.
 */
export async function onRequestPost(context) {
  const { request } = context;
  const corsHeaders = buildCorsHeaders();

  try {
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

    // ---- TEMPORARY DEVELOPMENT VERIFIER (current) ----
    // Accepts only the exact code "TEST" (case-insensitive). Everything
    // else is reported as invalid. No external service is called.
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

    // ---- GUMROAD (uncomment when ready, and remove the "TEMPORARY ----
    // ---- DEVELOPMENT VERIFIER" block above — index.html does not ----
    // ---- need to change either way). ----
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
  } catch (err) {
    console.error("Unhandled error in /api/verify-license:", err);
    return jsonResponse(
      { error: "Unexpected server error. Please try again." },
      500,
      corsHeaders
    );
  }
}

/**
 * Handles the CORS "preflight" OPTIONS request that browsers send
 * before certain POST requests.
 */
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: buildCorsHeaders() });
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
