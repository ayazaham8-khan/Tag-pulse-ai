/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/generate
 *
 * D1-backed credit enforcement:
 *
 * FREE USERS
 * - 5 generations total
 *
 * PAID USERS
 * - 500 generations total
 *
 * IMPORTANT:
 * The server NEVER trusts the frontend credit count.
 *
 * Pro users can now be identified in TWO ways:
 *
 * 1. Existing/manual license-key flow:
 *    request.license_key
 *
 * 2. Automatic Lemon Squeezy checkout flow:
 *    request.user_id
 *
 * This allows a user who has just purchased through Lemon
 * Squeezy to use Pro automatically without copying a license key.
 *
 * Flow:
 *
 * Lemon Squeezy
 *       ↓
 * license_key_created webhook
 *       ↓
 * D1 licenses table
 *       ↓
 * user_id linked to license
 *       ↓
 * /api/generate receives user_id
 *       ↓
 * server finds active Pro license
 *       ↓
 * 500-credit system
 *
 * Failed AI requests refund the reserved credit.
 * =============================================================
 */


/**
 * =============================================================
 * CONFIGURATION
 * =============================================================
 */

const GROQ_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const GROQ_MODEL_PRIMARY =
  "openai/gpt-oss-120b";

const GROQ_MODEL_FALLBACK =
  "qwen/qwen3.6-27b";

const GROQ_TIMEOUT_MS = 30000;

const FREE_CREDITS = 5;

const PAID_CREDITS = 500;


/**
 * =============================================================
 * POST /api/generate
 * =============================================================
 */

export async function onRequestPost(context) {

  const { request, env } = context;

  const corsHeaders =
    buildCorsHeaders();

  try {

    // ---------------------------------------------------------
    // 1. Check D1 binding
    // ---------------------------------------------------------

    if (!env.DB) {

      console.error(
        "D1 binding DB is missing."
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
    // 2. Parse request body
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
    // 3. Read request values
    // ---------------------------------------------------------

    const prompt =
      body && body.prompt;

    const userId =
      body && body.user_id;

    const licenseKey =
      body && body.license_key;


    // ---------------------------------------------------------
    // 4. Validate prompt
    // ---------------------------------------------------------

    if (
      !prompt ||
      typeof prompt !== "string" ||
      !prompt.trim()
    ) {

      return jsonResponse(
        {
          error:
            "A non-empty 'prompt' string is required."
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
      typeof userId !== "string" ||
      !userId.trim() ||
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


    const normalizedUserId =
      userId.trim();


    // ---------------------------------------------------------
    // 6. Make sure Groq API key exists
    // ---------------------------------------------------------

    if (!env.GROQ_API_KEY) {

      console.error(
        "GROQ_API_KEY is not set."
      );

      return jsonResponse(
        {
          error:
            "Server is not configured correctly (missing GROQ_API_KEY)."
        },
        500,
        corsHeaders
      );
    }


    // =========================================================
    // PRO LICENSE RESOLUTION
    // =========================================================
    //
    // We support BOTH:
    //
    // A) license_key
    // B) user_id
    //
    // If a license key is supplied, use it first.
    //
    // If no license key is supplied, search by user_id.
    //
    // This is what enables automatic Pro access after Lemon
    // Squeezy checkout.
    // =========================================================


    const normalizedLicense =
      typeof licenseKey === "string"
        ? licenseKey.trim()
        : "";


    let license = null;


    // =========================================================
    // METHOD A:
    // MANUAL LICENSE KEY
    // =========================================================

    if (normalizedLicense) {

      const licenseHash =
        await sha256(
          normalizedLicense
        );


      license =
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


      // -------------------------------------------------------
      // License key was supplied but does not exist.
      // -------------------------------------------------------

      if (!license) {

        return jsonResponse(
          {
            error:
              "This license key is not recognized.",
            is_pro: false
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Prevent a license from being used by another user.
      // -------------------------------------------------------

      if (
        license.user_id &&
        license.user_id !== normalizedUserId
      ) {

        return jsonResponse(
          {
            error:
              "This license is already linked to another TagPulse session.",
            is_pro: false
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // License must be active.
      // -------------------------------------------------------

      if (
        license.status !== "active"
      ) {

        return jsonResponse(
          {
            error:
              "This license key is no longer active.",
            is_pro: false
          },
          403,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // If the license exists but user_id is empty,
      // attach it to the current browser/user.
      // -------------------------------------------------------

      if (!license.user_id) {

        await env.DB.prepare(
          `UPDATE licenses
           SET user_id = ?1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?2`
        )
          .bind(
            normalizedUserId,
            license.id
          )
          .run();

        license.user_id =
          normalizedUserId;
      }
    }


    // =========================================================
    // METHOD B:
    // AUTOMATIC PRO ACCESS BY USER ID
    // =========================================================
    //
    // This is used after Lemon Squeezy purchase.
    //
    // The webhook stores:
    //
    // user_id
    // status
    // credits_remaining
    //
    // in the licenses table.
    //
    // Therefore the frontend does NOT need to send the
    // plaintext license key.
    // =========================================================

    if (!license) {

      license =
        await env.DB.prepare(
          `SELECT
             id,
             user_id,
             status,
             credits_remaining
           FROM licenses
           WHERE user_id = ?1
             AND status = 'active'
           ORDER BY id DESC
           LIMIT 1`
        )
          .bind(
            normalizedUserId
          )
          .first();
    }


    // =========================================================
    // PRO USER PATH
    // =========================================================

    if (license) {

      // -------------------------------------------------------
      // Make sure credits are numeric.
      // -------------------------------------------------------

      const currentCredits =
        Number(
          license.credits_remaining
        );


      // -------------------------------------------------------
      // No Pro credits remaining.
      // -------------------------------------------------------

      if (
        !Number.isFinite(currentCredits) ||
        currentCredits <= 0
      ) {

        return jsonResponse(
          {
            error:
              "Your 500-generation Pro allowance has been used.",
            credits_remaining: 0,
            is_pro: true
          },
          402,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Reserve one Pro credit BEFORE calling Groq.
      //
      // This atomic UPDATE prevents two simultaneous requests
      // from consuming the same credit.
      // -------------------------------------------------------

      const reserved =
        await reserveLicenseCredit(
          env.DB,
          license.id
        );


      if (!reserved) {

        const latest =
          await getLicenseCredits(
            env.DB,
            license.id
          );

        return jsonResponse(
          {
            error:
              "No Pro credits remaining. Please try again.",
            credits_remaining:
              latest,
            is_pro: true
          },
          402,
          corsHeaders
        );
      }


      // -------------------------------------------------------
      // Generate with Groq.
      // -------------------------------------------------------

      try {

        const text =
          await callGroq(
            prompt,
            env.GROQ_API_KEY
          );


        // -----------------------------------------------------
        // Generation succeeded.
        // Update license usage information.
        // -----------------------------------------------------

        await env.DB.prepare(
          `UPDATE licenses
           SET updated_at = CURRENT_TIMESTAMP,
               last_used_at = CURRENT_TIMESTAMP
           WHERE id = ?1`
        )
          .bind(
            license.id
          )
          .run();


        // -----------------------------------------------------
        // Record generation.
        // -----------------------------------------------------

        await env.DB.prepare(
          `INSERT INTO generations
           (user_id, license_id)
           VALUES (?1, ?2)`
        )
          .bind(
            normalizedUserId,
            license.id
          )
          .run();


        // -----------------------------------------------------
        // Get exact remaining balance from D1.
        // -----------------------------------------------------

        const remaining =
          await getLicenseCredits(
            env.DB,
            license.id
          );


        return jsonResponse(
          {
            text,

            credits_remaining:
              remaining,

            is_pro: true
          },
          200,
          corsHeaders
        );


      } catch (err) {

        // -----------------------------------------------------
        // Groq failed.
        // Refund the reserved credit.
        // -----------------------------------------------------

        await refundLicenseCredit(
          env.DB,
          license.id
        );


        throw err;
      }
    }


    // =========================================================
    // FREE USER PATH
    // =========================================================
    //
    // If no active Pro license was found for this user_id,
    // the user remains on the normal 5-generation free system.
    // =========================================================


    // ---------------------------------------------------------
    // Create free-user record if it doesn't exist.
    // ---------------------------------------------------------

    await env.DB.prepare(
      `INSERT OR IGNORE INTO free_users
       (user_id, credits_remaining)
       VALUES (?1, ?2)`
    )
      .bind(
        normalizedUserId,
        FREE_CREDITS
      )
      .run();


    // ---------------------------------------------------------
    // Reserve one free credit.
    // ---------------------------------------------------------

    const reserved =
      await reserveFreeCredit(
        env.DB,
        normalizedUserId
      );


    if (!reserved) {

      const row =
        await env.DB.prepare(
          `SELECT
             credits_remaining
           FROM free_users
           WHERE user_id = ?1`
        )
          .bind(
            normalizedUserId
          )
          .first();


      const remaining =
        row
          ? Number(
              row.credits_remaining
            )
          : 0;


      return jsonResponse(
        {
          error:
            "You've used all 5 free generations. Upgrade to Pro for 500 generations.",

          credits_remaining:
            remaining,

          is_pro: false
        },
        402,
        corsHeaders
      );
    }


    // ---------------------------------------------------------
    // Generate with Groq.
    // ---------------------------------------------------------

    try {

      const text =
        await callGroq(
          prompt,
          env.GROQ_API_KEY
        );


      // -------------------------------------------------------
      // Generation succeeded.
      // -------------------------------------------------------

      await env.DB.prepare(
        `UPDATE free_users
         SET updated_at = CURRENT_TIMESTAMP,
             last_used_at = CURRENT_TIMESTAMP
         WHERE user_id = ?1`
      )
        .bind(
          normalizedUserId
        )
        .run();


      // -------------------------------------------------------
      // Record free generation.
      // -------------------------------------------------------

      await env.DB.prepare(
        `INSERT INTO generations
         (user_id, license_id)
         VALUES (?1, NULL)`
      )
        .bind(
          normalizedUserId
        )
        .run();


      // -------------------------------------------------------
      // Return exact remaining free credits.
      // -------------------------------------------------------

      const row =
        await env.DB.prepare(
          `SELECT
             credits_remaining
           FROM free_users
           WHERE user_id = ?1`
        )
          .bind(
            normalizedUserId
          )
          .first();


      return jsonResponse(
        {
          text,

          credits_remaining:
            row
              ? Number(
                  row.credits_remaining
                )
              : 0,

          is_pro: false
        },
        200,
        corsHeaders
      );


    } catch (err) {

      // -------------------------------------------------------
      // Groq failed.
      // Refund the reserved free credit.
      // -------------------------------------------------------

      await refundFreeCredit(
        env.DB,
        normalizedUserId
      );


      throw err;
    }


  } catch (err) {

    // =========================================================
    // TIMEOUT
    // =========================================================

    if (
      err &&
      err.message === "GROQ_TIMEOUT"
    ) {

      return jsonResponse(
        {
          error:
            "The AI took too long to respond. Please try again."
        },
        504,
        corsHeaders
      );
    }


    // =========================================================
    // GENERAL ERROR
    // =========================================================

    console.error(
      "Unhandled /api/generate error:",
      err
    );


    return jsonResponse(
      {
        error:
          err && err.message
            ? err.message
            : "Something went wrong generating your SEO listing."
      },
      502,
      corsHeaders
    );
  }
}


/**
 * =============================================================
 * CORS OPTIONS
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


/**
 * =============================================================
 * RESERVE ONE FREE CREDIT
 * =============================================================
 *
 * Atomic UPDATE:
 *
 * credits_remaining > 0
 *
 * prevents negative balances and double-spending.
 * =============================================================
 */

async function reserveFreeCredit(
  db,
  userId
) {

  const result =
    await db.prepare(
      `UPDATE free_users
       SET credits_remaining =
             credits_remaining - 1,
           updated_at =
             CURRENT_TIMESTAMP
       WHERE user_id = ?1
         AND credits_remaining > 0`
    )
      .bind(
        userId
      )
      .run();


  return (
    Number(
      result.meta?.changes || 0
    ) === 1
  );
}


/**
 * =============================================================
 * REFUND FREE CREDIT
 * =============================================================
 *
 * Called if Groq fails after a credit was reserved.
 * =============================================================
 */

async function refundFreeCredit(
  db,
  userId
) {

  await db.prepare(
    `UPDATE free_users
     SET credits_remaining =
           credits_remaining + 1,
         updated_at =
           CURRENT_TIMESTAMP
     WHERE user_id = ?1
       AND credits_remaining < ?2`
  )
    .bind(
      userId,
      FREE_CREDITS
    )
    .run();
}


/**
 * =============================================================
 * RESERVE ONE PRO CREDIT
 * =============================================================
 */

async function reserveLicenseCredit(
  db,
  licenseId
) {

  const result =
    await db.prepare(
      `UPDATE licenses
       SET credits_remaining =
             credits_remaining - 1,
           updated_at =
             CURRENT_TIMESTAMP
       WHERE id = ?1
         AND status = 'active'
         AND credits_remaining > 0`
    )
      .bind(
        licenseId
      )
      .run();


  return (
    Number(
      result.meta?.changes || 0
    ) === 1
  );
}


/**
 * =============================================================
 * REFUND PRO CREDIT
 * =============================================================
 */

async function refundLicenseCredit(
  db,
  licenseId
) {

  await db.prepare(
    `UPDATE licenses
     SET credits_remaining =
           credits_remaining + 1,
         updated_at =
           CURRENT_TIMESTAMP
     WHERE id = ?1
       AND credits_remaining < ?2`
  )
    .bind(
      licenseId,
      PAID_CREDITS
    )
    .run();
}


/**
 * =============================================================
 * GET CURRENT PRO CREDITS
 * =============================================================
 */

async function getLicenseCredits(
  db,
  licenseId
) {

  const row =
    await db.prepare(
      `SELECT
         credits_remaining
       FROM licenses
       WHERE id = ?1`
    )
      .bind(
        licenseId
      )
      .first();


  return row
    ? Number(
        row.credits_remaining
      )
    : 0;
}


/**
 * =============================================================
 * GROQ CALL WITH FALLBACK
 * =============================================================
 */

async function callGroq(
  prompt,
  apiKey
) {

  try {

    return await callGroqModel(
      GROQ_MODEL_PRIMARY,
      prompt,
      apiKey
    );

  } catch (err) {

    // ---------------------------------------------------------
    // Do not make a second 30-second request after timeout.
    // ---------------------------------------------------------

    if (
      err &&
      err.message === "GROQ_TIMEOUT"
    ) {

      throw err;
    }


    console.error(
      GROQ_MODEL_PRIMARY +
        " failed, falling back to " +
        GROQ_MODEL_FALLBACK +
        ":",
      err
    );


    return await callGroqModel(
      GROQ_MODEL_FALLBACK,
      prompt,
      apiKey
    );
  }
}


/**
 * =============================================================
 * SINGLE GROQ MODEL REQUEST
 * =============================================================
 */

async function callGroqModel(
  model,
  prompt,
  apiKey
) {

  const controller =
    new AbortController();


  const timeoutId =
    setTimeout(
      () =>
        controller.abort(),
      GROQ_TIMEOUT_MS
    );


  let res;


  try {

    res =
      await fetch(
        GROQ_URL,
        {
          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            "Authorization":
              "Bearer " + apiKey
          },

          body:
            JSON.stringify(
              {
                model,

                messages: [
                  {
                    role: "user",
                    content: prompt
                  }
                ],

                temperature: 0.9,

                response_format: {
                  type: "json_object"
                }
              }
            ),

          signal:
            controller.signal
        }
      );


  } catch (err) {

    if (
      err &&
      err.name === "AbortError"
    ) {

      throw new Error(
        "GROQ_TIMEOUT"
      );
    }


    throw new Error(
      "Couldn't reach the AI service. Please try again."
    );


  } finally {

    clearTimeout(
      timeoutId
    );
  }


  // ---------------------------------------------------------
  // Groq returned an HTTP error.
  // ---------------------------------------------------------

  if (!res.ok) {

    let message =
      "Groq request failed (" +
      res.status +
      ").";


    try {

      const errBody =
        await res.json();


      if (
        errBody?.error?.message
      ) {

        message =
          errBody.error.message;
      }

    } catch (_) {}


    throw new Error(
      message
    );
  }


  // ---------------------------------------------------------
  // Parse Groq response.
  // ---------------------------------------------------------

  let data;


  try {

    data =
      await res.json();

  } catch (_) {

    throw new Error(
      "Received a malformed response from the AI service."
    );
  }


  // ---------------------------------------------------------
  // Get first choice.
  // ---------------------------------------------------------

  const choice =
    data?.choices?.[0];


  if (
    !choice ||
    choice.finish_reason ===
      "content_filter"
  ) {

    throw new Error(
      "The AI couldn't generate a result for this input. Try rephrasing your product keyword."
    );
  }


  // ---------------------------------------------------------
  // Get assistant text.
  // ---------------------------------------------------------

  const text =
    choice.message?.content;


  if (!text) {

    throw new Error(
      "The AI didn't return a usable result. Please try again."
    );
  }


  return text;
}


/**
 * =============================================================
 * SHA-256
 * =============================================================
 *
 * Used only when the user manually submits a license key.
 *
 * The plaintext license key is never stored in D1.
 * =============================================================
 */

async function sha256(
  value
) {

  const data =
    new TextEncoder()
      .encode(value);


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
      b =>
        b
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
 * JSON RESPONSE HELPER
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
 * CORS HEADERS
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
