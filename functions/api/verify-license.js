/**
 * =============================================================
 * TagPulse AI — Lemon Squeezy License Verification
 * Cloudflare Pages Function
 *
 * POST /api/verify-license
 *
 * Authentication:
 *   Authorization: Bearer <Supabase access token>
 *
 * Request body:
 * {
 *   "code": "<Lemon Squeezy license key>"
 * }
 *
 * IMPORTANT:
 *   The server NEVER trusts a frontend-supplied user_id.
 *   The user ID is obtained from the authenticated Supabase user.
 *
 * Success:
 * {
 *   "valid": true,
 *   "is_pro": true,
 *   "message": "Pro unlocked! 500 generations available.",
 *   "credits_remaining": 500
 * }
 *
 * D1 binding:
 *   DB
 *
 * Supabase:
 *   Publishable key is safe to use for authentication requests.
 *
 * Lemon Squeezy:
 *   Live Mode
 *
 * Product ID:
 *   1305746
 *
 * Variant ID:
 *   2042144
 * =============================================================
 */


/**
 * =============================================================
 * CONFIGURATION
 * =============================================================
 */

const SUPABASE_URL =
  "https://sjhjoapislwdhtqpbotz.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_GwuI7pu4wcqiJUIZlG6lmg_WKpE-16M";


const LEMON_ACTIVATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/activate";


const LEMON_VALIDATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/validate";


const LEMON_PRODUCT_ID =
  "1305746";


const LEMON_VARIANT_ID =
  "2042144";


const PAID_CREDITS =
  500;


/**
 * =============================================================
 * POST /api/verify-license
 * =============================================================
 */

export async function onRequestPost(context) {

  const { request, env } = context;

  const corsHeaders =
    buildCorsHeaders();


  try {

    // ---------------------------------------------------------
    // 1. D1 must exist
    // ---------------------------------------------------------

    if (!env.DB) {

      console.error(
        "verify-license: D1 binding DB is missing."
      );

      return jsonResponse(
        {
          error:
            "Server database is not configured."
        },
        500,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // 2. Authenticate the Supabase user
    // ---------------------------------------------------------
    //
    // IMPORTANT:
    // We do NOT accept user_id from the request body.
    //
    // The user's identity comes from the verified Supabase
    // access token.
    // ---------------------------------------------------------

    const authenticatedUser =
      await getAuthenticatedSupabaseUser(
        request
      );


    if (!authenticatedUser) {

      return jsonResponse(
        {
          valid: false,
          is_pro: false,
          error:
            "Please sign in to verify your license."
        },
        401,
        corsHeaders
      );
    }


    const userId =
      authenticatedUser.id;


    // ---------------------------------------------------------
    // 3. Parse request
    // ---------------------------------------------------------

    let body;

    try {

      body =
        await request.json();

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


    // ---------------------------------------------------------
    // 4. Read license key
    // ---------------------------------------------------------

    const code =
      body &&
      typeof body.code === "string"
        ? body.code.trim()
        : "";


    // ---------------------------------------------------------
    // 5. Validate license key
    // ---------------------------------------------------------

    if (
      !code ||
      code.length > 512
    ) {

      return jsonResponse(
        {
          error:
            "A valid license key is required."
        },
        400,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // 6. Hash license key
    //
    // NEVER store plaintext license keys in D1.
    // ---------------------------------------------------------

    const licenseHash =
      await sha256(
        code
      );


    // =========================================================
    // 7. CHECK D1 FOR EXISTING LICENSE
    // =========================================================

    const existing =
      await env.DB.prepare(
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
        .bind(
          licenseHash
        )
        .first();


    // =========================================================
    // EXISTING LICENSE
    // =========================================================

    if (existing) {

      // -------------------------------------------------------
      // Prevent another Supabase account from using the same
      // license.
      // -------------------------------------------------------

      if (
        existing.user_id &&
        existing.user_id !== userId
      ) {

        return jsonResponse(
          {
            valid: false,
            is_pro: false,
            message:
              "This license is already activated on another TagPulse account."
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Validate the license with Lemon Squeezy.
      // -------------------------------------------------------

      let validation;

      try {

        validation =
          await validateLicense(
            code,
            existing.instance_id || null
          );

      } catch (err) {

        console.error(
          "verify-license: Lemon validation failed:",
          err
        );

        return jsonResponse(
          {
            error:
              "Could not verify the license with Lemon Squeezy. Please try again."
          },
          502,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Verify exact TagPulse product + variant.
      // -------------------------------------------------------

      if (
        !matchesOurProduct(
          validation
        )
      ) {

        return jsonResponse(
          {
            valid: false,
            is_pro: false,
            message:
              "This license key does not belong to the TagPulse AI Pro product."
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Lemon says license is no longer valid.
      // -------------------------------------------------------

      if (
        !validation.valid
      ) {

        const lemonStatus =
          validation &&
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
          .bind(
            lemonStatus,
            existing.id
          )
          .run();


        return jsonResponse(
          {
            valid: false,
            is_pro: false,
            message:
              "This license key is no longer valid."
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Make sure Lemon says the license is active.
      // -------------------------------------------------------

      const lemonStatus =
        validation &&
        validation.license_key &&
        validation.license_key.status
          ? validation.license_key.status
          : "";


      if (
        lemonStatus !== "active"
      ) {

        await env.DB.prepare(
          `UPDATE licenses
           SET status = ?1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?2`
        )
          .bind(
            lemonStatus || "inactive",
            existing.id
          )
          .run();


        return jsonResponse(
          {
            valid: false,
            is_pro: false,
            message:
              "This license key is not active."
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Attach authenticated Supabase user if the license has
      // not been linked yet.
      // -------------------------------------------------------

      if (
        !existing.user_id
      ) {

        await env.DB.prepare(
          `UPDATE licenses
           SET user_id = ?1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?2`
        )
          .bind(
            userId,
            existing.id
          )
          .run();
      }


      // -------------------------------------------------------
      // Return current Pro balance.
      // -------------------------------------------------------

      const remaining =
        Math.max(
          0,
          Number(
            existing.credits_remaining || 0
          )
        );


      return jsonResponse(
        {
          valid: true,
          is_pro: true,

          message:
            "Pro unlocked! " +
            remaining +
            " generations remaining.",

          credits_remaining:
            remaining
        },
        200,
        corsHeaders
      );
    }


    // =========================================================
    // NEW LICENSE
    // =========================================================

    let activation;

    try {

      activation =
        await activateLicense(
          code,
          userId
        );

    } catch (err) {

      console.error(
        "verify-license: Lemon activation failed:",
        err
      );

      return jsonResponse(
        {
          error:
            "Could not contact Lemon Squeezy. Please try again."
        },
        502,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // Lemon rejected activation.
    // ---------------------------------------------------------

    if (
      !activation ||
      !activation.activated
    ) {

      return jsonResponse(
        {
          valid: false,
          is_pro: false,

          message:
            activation &&
            activation.error
              ? activation.error
              : "This license key could not be activated."
        },
        200,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // SECURITY:
    // Verify exact TagPulse product + variant.
    // ---------------------------------------------------------

    if (
      !matchesOurProduct(
        activation
      )
    ) {

      console.error(
        "verify-license: wrong product or variant.",
        activation.meta
      );

      return jsonResponse(
        {
          valid: false,
          is_pro: false,

          message:
            "This license key does not belong to the TagPulse AI Pro product."
        },
        403,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // Verify active status.
    // ---------------------------------------------------------

    if (
      !activation.license_key ||
      activation.license_key.status !== "active"
    ) {

      return jsonResponse(
        {
          valid: false,
          is_pro: false,

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
        ? String(
            activation.instance.id
          )
        : "";


    if (!instanceId) {

      console.error(
        "verify-license: Lemon activation returned no instance ID."
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


    // =========================================================
    // SAVE LICENSE
    // =========================================================

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
        "verify-license: failed to insert license:",
        dbError
      );


      // -------------------------------------------------------
      // Race-condition check.
      // -------------------------------------------------------

      const raceCheck =
        await env.DB.prepare(
          `SELECT
             id,
             user_id,
             status,
             credits_remaining
           FROM licenses
           WHERE license_key_hash = ?1
           LIMIT 1`
        )
          .bind(
            licenseHash
          )
          .first();


      if (
        raceCheck
      ) {

        // Another Supabase account owns it.
        if (
          raceCheck.user_id &&
          raceCheck.user_id !== userId
        ) {

          return jsonResponse(
            {
              valid: false,
              is_pro: false,

              message:
                "This license is already activated on another TagPulse account."
            },
            403,
            corsHeaders
          );
        }


        const remaining =
          Math.max(
            0,
            Number(
              raceCheck.credits_remaining || 0
            )
          );


        return jsonResponse(
          {
            valid: true,
            is_pro: true,

            message:
              "Pro unlocked! " +
              remaining +
              " generations remaining.",

            credits_remaining:
              remaining
          },
          200,
          corsHeaders
        );
      }


      return jsonResponse(
        {
          error:
            "The license was activated but could not be saved. Please try again."
        },
        500,
        corsHeaders
      );
    }


    // =========================================================
    // SUCCESS
    // =========================================================

    console.log(
      "verify-license: new Pro license activated.",
      {
        userId,
        instanceId
      }
    );


    return jsonResponse(
      {
        valid: true,
        is_pro: true,

        message:
          "Pro unlocked! 500 generations available.",

        credits_remaining:
          PAID_CREDITS
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
 * SUPABASE AUTHENTICATION
 * =============================================================
 *
 * The frontend sends:
 *
 * Authorization: Bearer <Supabase access token>
 *
 * We ask Supabase Auth for the authenticated user.
 *
 * The returned user.id is the ONLY user identity used by this
 * function.
 * =============================================================
 */

async function getAuthenticatedSupabaseUser(
  request
) {

  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";


  if (
    !authorization ||
    !authorization.startsWith(
      "Bearer "
    )
  ) {

    return null;
  }


  const accessToken =
    authorization
      .slice(7)
      .trim();


  if (!accessToken) {

    return null;
  }


  try {

    const response =
      await fetch(
        SUPABASE_URL +
          "/auth/v1/user",
        {
          method: "GET",

          headers: {
            "Accept":
              "application/json",

            "apikey":
              SUPABASE_PUBLISHABLE_KEY,

            "Authorization":
              "Bearer " +
              accessToken
          }
        }
      );


    if (
      !response.ok
    ) {

      console.warn(
        "Supabase authentication rejected request:",
        response.status
      );

      return null;
    }


    const data =
      await response.json();


    if (
      !data ||
      !data.id ||
      typeof data.id !== "string"
    ) {

      return null;
    }


    return data;

  } catch (err) {

    console.error(
      "Supabase authentication request failed:",
      err
    );

    return null;
  }
}


/**
 * =============================================================
 * LEMON SQUEEZY — ACTIVATE
 * =============================================================
 */

async function activateLicense(
  licenseKey,
  userId
) {

  const params =
    new URLSearchParams();


  params.append(
    "license_key",
    licenseKey
  );


  params.append(
    "instance_name",
    "TagPulse-" +
      userId.slice(0, 40)
  );


  let response;

  try {

    response =
      await fetch(
        LEMON_ACTIVATE_URL,
        {
          method: "POST",

          headers: {
            "Accept":
              "application/json",

            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            params.toString()
        }
      );

  } catch (err) {

    console.error(
      "Lemon Squeezy activation network error:",
      err
    );

    throw new Error(
      "LEMON_NETWORK_ERROR"
    );
  }


  let data;

  try {

    data =
      await response.json();

  } catch (_) {

    throw new Error(
      "LEMON_INVALID_RESPONSE"
    );
  }


  if (
    !response.ok
  ) {

    return {
      activated: false,

      error:
        data &&
        data.error
          ? data.error
          : "License activation failed."
    };
  }


  return data;
}


/**
 * =============================================================
 * LEMON SQUEEZY — VALIDATE
 * =============================================================
 */

async function validateLicense(
  licenseKey,
  instanceId
) {

  const params =
    new URLSearchParams();


  params.append(
    "license_key",
    licenseKey
  );


  if (
    instanceId
  ) {

    params.append(
      "instance_id",
      instanceId
    );
  }


  let response;

  try {

    response =
      await fetch(
        LEMON_VALIDATE_URL,
        {
          method: "POST",

          headers: {
            "Accept":
              "application/json",

            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            params.toString()
        }
      );

  } catch (err) {

    console.error(
      "Lemon Squeezy validation network error:",
      err
    );

    throw new Error(
      "LEMON_NETWORK_ERROR"
    );
  }


  let data;

  try {

    data =
      await response.json();

  } catch (_) {

    throw new Error(
      "LEMON_INVALID_RESPONSE"
    );
  }


  if (
    !response.ok
  ) {

    return {
      valid: false,

      error:
        data &&
        data.error
          ? data.error
          : "License validation failed."
    };
  }


  return data;
}


/**
 * =============================================================
 * PRODUCT + VARIANT SECURITY CHECK
 * =============================================================
 */

function matchesOurProduct(
  data
) {

  if (
    !data ||
    !data.meta
  ) {

    return false;
  }


  const productId =
    String(
      data.meta.product_id || ""
    );


  const variantId =
    String(
      data.meta.variant_id || ""
    );


  return (
    productId ===
      LEMON_PRODUCT_ID &&
    variantId ===
      LEMON_VARIANT_ID
  );
}


/**
 * =============================================================
 * SHA-256
 * =============================================================
 */

async function sha256(
  value
) {

  const data =
    new TextEncoder()
      .encode(
        value
      );


  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );


  return Array.from(
    new Uint8Array(
      digest
    )
  )
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(
            2,
            "0"
          )
    )
    .join("");
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
    JSON.stringify(
      data
    ),
    {
      status,

      headers:
        Object.assign(
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
      "Content-Type, Authorization"
  };
}


/**
 * =============================================================
 * OPTIONS / CORS PREFLIGHT
 * =============================================================
 */

export async function onRequestOptions() {

  return new Response(
    null,
    {
      status: 204,

      headers:
        buildCorsHeaders()
    }
  );
}
