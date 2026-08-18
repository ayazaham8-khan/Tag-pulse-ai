/**
 * =============================================================
 * TagPulse AI — License Verification
 * Cloudflare Pages Function
 *
 * POST /api/verify-license
 *
 * Purpose:
 * - Verify a Lemon Squeezy license key
 * - Verify TagPulse product + variant
 * - Bind license to browser user_id
 * - Store ONLY SHA-256 license hash in D1
 * - Give 500 Pro credits on first activation
 * - Prevent the same license from being used by another user
 *
 * D1 binding:
 *   DB
 *
 * Lemon Squeezy:
 *   Test Mode
 *
 * Product:
 *   1296090
 *
 * Variant:
 *   2027791
 * =============================================================
 */


/**
 * =============================================================
 * CONFIGURATION
 * =============================================================
 */

const LEMON_ACTIVATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/activate";

const LEMON_VALIDATE_URL =
  "https://api.lemonsqueezy.com/v1/licenses/validate";

const LEMON_PRODUCT_ID =
  "1296090";

const LEMON_VARIANT_ID =
  "2027791";

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
    // 1. Check D1
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
    // 2. Parse JSON
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
    // 3. Read inputs
    // ---------------------------------------------------------

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


    // ---------------------------------------------------------
    // 4. Validate license key
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
    // 5. Validate user ID
    // ---------------------------------------------------------

    if (
      !userId ||
      userId.length > 128
    ) {

      return jsonResponse(
        {
          error:
            "A valid user_id is required."
        },
        400,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // 6. Hash license key
    //
    // IMPORTANT:
    // Plaintext license is NEVER stored in D1.
    // ---------------------------------------------------------

    const licenseHash =
      await sha256(code);


    // =========================================================
    // 7. CHECK D1 FOR EXISTING LICENSE
    // =========================================================

    const existing =
      await env.DB.prepare(
        `SELECT
           id,
           license_key_hash,
           status,
           credits_remaining,
           initial_credits,
           user_id,
           instance_id
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
      // Prevent another browser/user from using this license.
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
              "This license is already activated on another TagPulse session."
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
            existing.instance_id
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
      // Verify product + variant.
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
      // Make sure the license is active.
      // -------------------------------------------------------

      const lemonLicenseStatus =
        validation &&
        validation.license_key &&
        validation.license_key.status
          ? validation.license_key.status
          : "";


      if (
        lemonLicenseStatus !== "active"
      ) {

        await env.DB.prepare(
          `UPDATE licenses
           SET status = ?1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?2`
        )
          .bind(
            lemonLicenseStatus || "inactive",
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
      // Attach user_id if this license has no owner yet.
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
      // Return current credit balance.
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
    // Security:
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
    // Get Lemon instance ID.
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
      // Another request may have inserted it first.
      // -------------------------------------------------------

      const raceCheck =
        await env.DB.prepare(
          `SELECT
             id,
             status,
             credits_remaining,
             user_id
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

        // Another user owns it.
        if (
          raceCheck.user_id &&
          raceCheck.user_id !== userId
        ) {

          return jsonResponse(
            {
              valid: false,
              is_pro: false,
              message:
                "This license is already activated on another TagPulse session."
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
 * LEMON SQUEEZY — ACTIVATE LICENSE
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
      "Lemon activation network error:",
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
 * LEMON SQUEEZY — VALIDATE LICENSE
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
      "Lemon validation network error:",
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
    productId === LEMON_PRODUCT_ID &&
    variantId === LEMON_VARIANT_ID
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
      "Content-Type"
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
