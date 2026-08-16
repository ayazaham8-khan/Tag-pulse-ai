/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/verify-license
 *
 * Current phase:
 * D1-backed development verifier.
 *
 * IMPORTANT:
 * "TEST" is ONLY for development/testing.
 * It must be removed before public launch.
 *
 * Request:
 * {
 *   "code": "...",
 *   "user_id": "..."
 * }
 *
 * Response:
 * {
 *   "valid": true|false,
 *   "message": "...",
 *   "credits_remaining": 500,
 *   "is_pro": true
 * }
 * =============================================================
 */

const DEV_BYPASS_CODE = "TEST";

const PRO_INITIAL_CREDITS = 500;


/**
 * =============================================================
 * POST /api/verify-license
 * =============================================================
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = buildCorsHeaders();

  try {
    if (!env.DB) {
      console.error(
        "D1 binding DB is missing."
      );

      return jsonResponse(
        {
          error:
            "Server database is not configured correctly."
        },
        500,
        corsHeaders
      );
    }

    let body;

    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse(
        {
          error:
            "Request body must be valid JSON."
        },
        400,
        corsHeaders
      );
    }

    const code =
      body &&
      typeof body.code === "string"
        ? body.code.trim()
        : "";

    const userId =
      body &&
      typeof body.user_id === "string"
        ? body.user_id.trim()
        : "";

    if (!code) {
      return jsonResponse(
        {
          error:
            "A non-empty 'code' string is required."
        },
        400,
        corsHeaders
      );
    }

    if (
      !userId ||
      !isValidUserId(userId)
    ) {
      return jsonResponse(
        {
          error:
            "A valid user ID is required."
        },
        400,
        corsHeaders
      );
    }


    /*
     * =========================================================
     * DEVELOPMENT TEST MODE
     *
     * Creates a separate D1 test license for each test user.
     *
     * The actual stored value is:
     *
     * SHA256("TEST:" + user_id)
     *
     * so we never store the plaintext TEST value.
     * =========================================================
     */

    if (
      code.toUpperCase() ===
      DEV_BYPASS_CODE
    ) {
      const internalTestLicense =
        "TEST:" + userId;

      const hash =
        await sha256(
          internalTestLicense
        );

      /*
       * Create the test Pro license if it doesn't exist.
       *
       * INSERT OR IGNORE means repeated TEST
       * verification doesn't reset the user's
       * existing balance back to 500.
       */
      await env.DB.prepare(
        `
        INSERT OR IGNORE INTO licenses
          (
            license_key_hash,
            status,
            credits_remaining,
            initial_credits
          )
        VALUES
          (?, 'active', ?, ?)
        `
      )
        .bind(
          hash,
          PRO_INITIAL_CREDITS,
          PRO_INITIAL_CREDITS
        )
        .run();


      const license =
        await env.DB.prepare(
          `
          SELECT
            id,
            status,
            credits_remaining
          FROM licenses
          WHERE license_key_hash = ?
          LIMIT 1
          `
        )
          .bind(hash)
          .first();


      if (
        !license ||
        license.status !==
          "active"
      ) {
        return jsonResponse(
          {
            valid: false,
            message:
              "This test license is not active."
          },
          200,
          corsHeaders
        );
      }


      return jsonResponse(
        {
          valid: true,
          message:
            "Pro unlocked in development test mode.",
          credits_remaining:
            Number(
              license.credits_remaining
            ),
          is_pro: true
        },
        200,
        corsHeaders
      );
    }


    /*
     * =========================================================
     * REAL LICENSES
     *
     * At this stage no external payment provider is connected.
     * Existing D1 licenses can still be verified if their
     * hashed license key already exists in the database.
     *
     * Lemon Squeezy integration will be added in the next phase.
     * =========================================================
     */

    const hash =
      await sha256(code);

    const license =
      await env.DB.prepare(
        `
        SELECT
          id,
          status,
          credits_remaining
        FROM licenses
        WHERE license_key_hash = ?
        LIMIT 1
        `
      )
        .bind(hash)
        .first();


    if (
      !license ||
      license.status !==
        "active"
    ) {
      return jsonResponse(
        {
          valid: false,
          message:
            "That license key isn't valid. Please double-check it."
        },
        200,
        corsHeaders
      );
    }


    if (
      Number(
        license.credits_remaining
      ) <= 0
    ) {
      return jsonResponse(
        {
          valid: true,
          message:
            "Your license is valid, but all 500 generations have been used.",
          credits_remaining: 0,
          is_pro: true
        },
        200,
        corsHeaders
      );
    }


    return jsonResponse(
      {
        valid: true,
        message:
          "Pro license verified.",
        credits_remaining:
          Number(
            license.credits_remaining
          ),
        is_pro: true
      },
      200,
      corsHeaders
    );

  } catch (err) {
    console.error(
      "Unhandled error in /api/verify-license:",
      err
    );

    return jsonResponse(
      {
        error:
          "Unexpected server error. Please try again."
      },
      500,
      corsHeaders
    );
  }
}


/**
 * =============================================================
 * OPTIONS
 * =============================================================
 */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders()
  });
}


/**
 * =============================================================
 * SHA-256
 * =============================================================
 */
async function sha256(value) {
  const data =
    new TextEncoder().encode(value);

  const hashBuffer =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  const hashArray =
    Array.from(
      new Uint8Array(hashBuffer)
    );

  return hashArray
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}


/**
 * =============================================================
 * USER ID VALIDATION
 * =============================================================
 */
function isValidUserId(value) {
  return (
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}


/**
 * =============================================================
 * JSON RESPONSE
 * =============================================================
 */
function jsonResponse(
  data,
  status,
  corsHeaders
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: Object.assign(
        {
          "Content-Type":
            "application/json"
        },
        corsHeaders
      )
    }
  );
}


/**
 * =============================================================
 * CORS
 * =============================================================
 */
function buildCorsHeaders() {
  return {
    "Access-Control-Allow-Origin":
      "*",
    "Access-Control-Allow-Methods":
      "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type"
  };
}
