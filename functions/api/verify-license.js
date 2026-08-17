/**
 * =============================================================
 * TagPulse AI — Lemon Squeezy License Verification
 * Cloudflare Pages Function
 * POST /api/verify-license
 * =============================================================
 *
 * Request body:
 * {
 *   "code": "<Lemon Squeezy license key>",
 *   "user_id": "<browser-generated stable user id>"
 * }
 *
 * Success:
 * {
 *   "valid": true,
 *   "message": "Pro unlocked! 500 generations available.",
 *   "credits_remaining": 500
 * }
 *
 * Invalid:
 * {
 *   "valid": false,
 *   "message": "..."
 * }
 *
 * D1 binding:
 * DB
 *
 * Lemon Squeezy:
 * Test Mode
 *
 * Product ID: 1296090
 * Variant ID: 2027791
 * =============================================================
 */

const LEMON_ACTIVATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/activate";

const LEMON_VALIDATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/validate";

const LEMON_PRODUCT_ID = "1296090";
const LEMON_VARIANT_ID = "2027791";

const PAID_CREDITS = 500;

/**
 * Handles POST /api/verify-license
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = buildCorsHeaders();

  try {
    // ---------------------------------------------------------
    // 1. D1 must exist
    // ---------------------------------------------------------
    if (!env.DB) {
      console.error("D1 binding DB is missing.");

      return jsonResponse(
        {
          error: "Server database is not configured."
        },
        500,
        corsHeaders
      );
    }

    // ---------------------------------------------------------
    // 2. Parse request
    // ---------------------------------------------------------
    let body;

    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse(
        {
          error: "Request body must be valid JSON."
        },
        400,
        corsHeaders
      );
    }

    const code =
      body && typeof body.code === "string"
        ? body.code.trim()
        : "";

    const userId =
      body && typeof body.user_id === "string"
        ? body.user_id.trim()
        : "";

    // ---------------------------------------------------------
    // 3. Validate input
    // ---------------------------------------------------------
    if (!code) {
      return jsonResponse(
        {
          error: "A non-empty license key is required."
        },
        400,
        corsHeaders
      );
    }

    if (!userId || userId.length > 128) {
      return jsonResponse(
        {
          error: "A valid user_id is required."
        },
        400,
        corsHeaders
      );
    }

    // ---------------------------------------------------------
    // 4. Never store the real license key
    // ---------------------------------------------------------
    const licenseHash = await sha256(code);

    // ---------------------------------------------------------
    // 5. Check whether this license is already registered
    // ---------------------------------------------------------
    const existing = await env.DB.prepare(
      `SELECT
         id,
         user_id,
         instance_id,
         status,
         credits_remaining
       FROM licenses
       WHERE license_key_hash = ?1
       LIMIT 1`
    )
      .bind(licenseHash)
      .first();

    // =========================================================
    // EXISTING LICENSE
    // =========================================================
    if (existing) {

      // -------------------------------------------------------
      // Prevent the same license from being attached to
      // another browser/user_id.
      // -------------------------------------------------------
      if (
        existing.user_id &&
        existing.user_id !== userId
      ) {
        return jsonResponse(
          {
            valid: false,
            message:
              "This license is already activated on another TagPulse session."
          },
          403,
          corsHeaders
        );
      }

      // -------------------------------------------------------
      // Validate the existing Lemon Squeezy license.
      // If we have an instance_id, validate that exact instance.
      // -------------------------------------------------------
      const validation = await validateLicense(
        code,
        existing.instance_id || null
      );

      // -------------------------------------------------------
      // Verify that the license belongs to OUR product.
      // -------------------------------------------------------
      if (!matchesOurProduct(validation)) {
        return jsonResponse(
          {
            valid: false,
            message:
              "This license key does not belong to the TagPulse AI Pro product."
          },
          403,
          corsHeaders
        );
      }

      if (!validation.valid) {
        const lemonStatus =
          validation.license_key &&
          validation.license_key.status
            ? validation.license_key.status
            : "inactive";

        await env.DB.prepare(
          `UPDATE licenses
           SET status = ?1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?2`
        )
          .bind(lemonStatus, existing.id)
          .run();

        return jsonResponse(
          {
            valid: false,
            message:
              "This license key is no longer valid."
          },
          403,
          corsHeaders
        );
      }

      // -------------------------------------------------------
      // Make sure the user_id is attached.
      // -------------------------------------------------------
      if (!existing.user_id) {
        await env.DB.prepare(
          `UPDATE licenses
           SET user_id = ?1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?2`
        )
          .bind(userId, existing.id)
          .run();
      }

      const remaining =
        Number(existing.credits_remaining);

      return jsonResponse(
        {
          valid: true,
          message:
            "Pro unlocked! " +
            remaining +
            " generations remaining.",
          credits_remaining: remaining
        },
        200,
        corsHeaders
      );
    }

    // =========================================================
    // NEW LICENSE
    // =========================================================

    // ---------------------------------------------------------
    // Activate the Lemon Squeezy license.
    // ---------------------------------------------------------
    const activation = await activateLicense(
      code,
      userId
    );

    if (!activation.activated) {
      return jsonResponse(
        {
          valid: false,
          message:
            activation.error ||
            "This license key could not be activated."
        },
        200,
        corsHeaders
      );
    }

    // ---------------------------------------------------------
    // SECURITY CHECK:
    // Make sure the license belongs to our exact
    // TagPulse AI product + variant.
    // ---------------------------------------------------------
    if (!matchesOurProduct(activation)) {
      return jsonResponse(
        {
          valid: false,
          message:
            "This license key does not belong to the TagPulse AI Pro product."
        },
        403,
        corsHeaders
      );
    }

    // ---------------------------------------------------------
    // Make sure Lemon says the license is active.
    // ---------------------------------------------------------
    if (
      !activation.license_key ||
      activation.license_key.status !== "active"
    ) {
      return jsonResponse(
        {
          valid: false,
          message:
            "This license key is not active."
        },
        403,
        corsHeaders
      );
    }

    // ---------------------------------------------------------
    // Get Lemon Squeezy instance ID.
    // ---------------------------------------------------------
    const instanceId =
      activation.instance &&
      activation.instance.id
        ? activation.instance.id
        : null;

    if (!instanceId) {
      console.error(
        "Lemon Squeezy activation succeeded but no instance ID was returned."
      );

      return jsonResponse(
        {
          error:
            "License activation returned an incomplete response."
        },
        502,
        corsHeaders
      );
    }

    // ---------------------------------------------------------
    // Save ONLY the SHA-256 hash of the license key.
    // Never save the plaintext license key.
    // ---------------------------------------------------------
    try {
      await env.DB.prepare(
        `INSERT INTO licenses
         (
           license_key_hash,
           status,
           credits_remaining,
           initial_credits,
           created_at,
           updated_at,
           last_used_at,
           user_id,
           instance_id
         )
         VALUES
         (
           ?1,
           'active',
           ?2,
           ?2,
           CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP,
           NULL,
           ?3,
           ?4
         )`
      )
        .bind(
          licenseHash,
          PAID_CREDITS,
          userId,
          instanceId
        )
        .run();

    } catch (dbError) {

      console.error(
        "Failed to save license in D1:",
        dbError
      );

      // A race condition may mean another request saved it
      // immediately before this INSERT.
      const raceCheck = await env.DB.prepare(
        `SELECT
           id,
           user_id,
           credits_remaining
         FROM licenses
         WHERE license_key_hash = ?1
         LIMIT 1`
      )
        .bind(licenseHash)
        .first();

      if (
        raceCheck &&
        (!raceCheck.user_id ||
          raceCheck.user_id === userId)
      ) {
        return jsonResponse(
          {
            valid: true,
            message:
              "Pro unlocked! " +
              Number(raceCheck.credits_remaining) +
              " generations remaining.",
            credits_remaining:
              Number(raceCheck.credits_remaining)
          },
          200,
          corsHeaders
        );
      }

      return jsonResponse(
        {
          error:
            "The license was activated but could not be saved. Please contact support."
        },
        500,
        corsHeaders
      );
    }

    return jsonResponse(
      {
        valid: true,
        message:
          "Pro unlocked! 500 generations available.",
        credits_remaining: PAID_CREDITS
      },
      200,
      corsHeaders
    );

  } catch (err) {
    console.error(
      "Unhandled /api/verify-license error:",
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
 * Lemon Squeezy — Activate
 * =============================================================
 */
async function activateLicense(
  licenseKey,
  userId
) {
  const params = new URLSearchParams();

  params.append(
    "license_key",
    licenseKey
  );

  params.append(
    "instance_name",
    "TagPulse-" + userId.slice(0, 40)
  );

  let response;

  try {
    response = await fetch(
      LEMON_ACTIVATE_URL,
      {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );
  } catch (err) {
    console.error(
      "Lemon Squeezy activation request failed:",
      err
    );

    throw new Error(
      "Couldn't reach the license service. Please try again."
    );
  }

  let data = {};

  try {
    data = await response.json();
  } catch (_) {
    throw new Error(
      "Lemon Squeezy returned an invalid response."
    );
  }

  if (!response.ok) {
    return {
      activated: false,
      error:
        data.error ||
        "License activation failed."
    };
  }

  return data;
}

/**
 * =============================================================
 * Lemon Squeezy — Validate
 * =============================================================
 */
async function validateLicense(
  licenseKey,
  instanceId
) {
  const params = new URLSearchParams();

  params.append(
    "license_key",
    licenseKey
  );

  if (instanceId) {
    params.append(
      "instance_id",
      instanceId
    );
  }

  let response;

  try {
    response = await fetch(
      LEMON_VALIDATE_URL,
      {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );
  } catch (err) {
    console.error(
      "Lemon Squeezy validation request failed:",
      err
    );

    throw new Error(
      "Couldn't reach the license service. Please try again."
    );
  }

  let data = {};

  try {
    data = await response.json();
  } catch (_) {
    throw new Error(
      "Lemon Squeezy returned an invalid response."
    );
  }

  if (!response.ok) {
    return {
      valid: false,
      error:
        data.error ||
        "License validation failed."
    };
  }

  return data;
}

/**
 * =============================================================
 * Product / Variant security check
 * =============================================================
 */
function matchesOurProduct(data) {
  if (!data || !data.meta) {
    return false;
  }

  const productId =
    String(data.meta.product_id || "");

  const variantId =
    String(data.meta.variant_id || "");

  return (
    productId === LEMON_PRODUCT_ID &&
    variantId === LEMON_VARIANT_ID
  );
}

/**
 * =============================================================
 * SHA-256
 * =============================================================
 */
async function sha256(value) {
  const data =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return Array.from(
    new Uint8Array(digest)
  )
    .map(
      b => b.toString(16).padStart(2, "0")
    )
    .join("");
}

/**
 * =============================================================
 * JSON response helper
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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type"
  };
}

/**
 * =============================================================
 * OPTIONS / CORS preflight
 * =============================================================
 */
export async function onRequestOptions() {
  return new Response(
    null,
    {
      status: 204,
      headers: buildCorsHeaders()
    }
  );
}
