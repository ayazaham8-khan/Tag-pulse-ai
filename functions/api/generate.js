/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/generate
 *
 * Supabase Auth + D1-backed credit enforcement
 *
 * FREE USERS
 * - 5 generations total
 *
 * PAID USERS
 * - 500 generations total
 *
 * CREATOR PRO USERS
 * - 500 generations total
 * - Provisioned manually in D1 creator_pro table
 * - No Lemon Squeezy checkout required
 *
 * AUTHENTICATION
 * - Frontend sends:
 *     Authorization: Bearer <Supabase access token>
 *
 * - Server verifies the token against Supabase Auth.
 * - The verified Supabase user ID becomes the authoritative
 *   D1 user_id.
 *
 * IMPORTANT:
 * - The server NEVER trusts a frontend user_id.
 * - The frontend credit count is never trusted.
 * - D1 remains the source of truth for credits.
 *
 * PRO USERS
 * 1. Creator Pro entitlement in creator_pro
 * 2. Existing/manual Lemon Squeezy license-key flow
 * 3. Automatic Lemon Squeezy purchase flow linked to the
 *    authenticated Supabase user ID.
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
 * SUPABASE CONFIGURATION
 * =============================================================
 */

const SUPABASE_URL =
  "https://sjhjoapislwdhtqpbotz.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_GwuI7pu4wcqiJUIZlG6lmg_WKpE-16M";


/**
 * =============================================================
 * OPTIONS / PREFLIGHT HANDLER
 * =============================================================
 */

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(),
  });
}


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
    // 2. Authenticate Supabase user
    // ---------------------------------------------------------

    const authenticatedUser =
      await getAuthenticatedSupabaseUser(
        request
      );

    if (!authenticatedUser) {

      return jsonResponse(
        {
          error:
            "Please sign in to use TagPulse AI."
        },
        401,
        corsHeaders
      );
    }


    const normalizedUserId =
      authenticatedUser.id;


    // ---------------------------------------------------------
    // 3. Parse request body
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
    // 4. Read request values
    // ---------------------------------------------------------

    const prompt =
      body && body.prompt;

    const licenseKey =
      body && body.license_key;


    // ---------------------------------------------------------
    // 5. Validate prompt
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
    // CREATOR PRO RESOLUTION
    // =========================================================

    const creatorPro =
      await env.DB.prepare(
        `SELECT
           user_id,
           credits_remaining
         FROM creator_pro
         WHERE user_id = ?1
         LIMIT 1`
      )
        .bind(
          normalizedUserId
        )
        .first();


    // =========================================================
    // CREATOR PRO USER PATH
    // =========================================================

    if (creatorPro) {

      const currentCredits =
        Number(
          creatorPro.credits_remaining
        );

      if (
        !Number.isFinite(currentCredits) ||
        currentCredits <= 0
      ) {

        return jsonResponse(
          {
            error:
              "Your creator Pro allowance has been used.",
            credits_remaining: 0,
            is_pro: true,
            pro_type: "creator"
          },
          402,
          corsHeaders
        );
      }

      const reserved =
        await reserveCreatorCredit(
          env.DB,
          normalizedUserId
        );

      if (!reserved) {

        const latest =
          await getCreatorCredits(
            env.DB,
            normalizedUserId
          );

        return jsonResponse(
          {
            error:
              "No creator Pro credits remaining. Please try again.",
            credits_remaining:
              latest,
            is_pro: true,
            pro_type: "creator"
          },
          402,
          corsHeaders
        );
      }

      try {

        const text =
          await callGroq(
            prompt,
            env.GROQ_API_KEY
          );

        await env.DB.prepare(
          `UPDATE creator_pro
           SET updated_at = CURRENT_TIMESTAMP,
               last_used_at = CURRENT_TIMESTAMP
           WHERE user_id = ?1`
        )
          .bind(
            normalizedUserId
          )
          .run();

        await env.DB.prepare(
          `INSERT INTO generations
           (user_id, license_id)
           VALUES (?1, NULL)`
        )
          .bind(
            normalizedUserId
          )
          .run();

        const remaining =
          await getCreatorCredits(
            env.DB,
            normalizedUserId
          );

        return jsonResponse(
          {
            text,
            credits_remaining: remaining,
            is_pro: true,
            pro_type: "creator"
          },
          200,
          corsHeaders
        );

      } catch (err) {

        await refundCreatorCredit(
          env.DB,
          normalizedUserId
        );

        throw err;
      }
    }


    // =========================================================
    // PRO LICENSE RESOLUTION
    // =========================================================

    const normalizedLicense =
      typeof licenseKey === "string"
        ? licenseKey.trim()
        : "";

    let license = null;

    // METHOD A: MANUAL LICENSE KEY
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

      if (
        license.user_id &&
        license.user_id !== normalizedUserId
      ) {

        return jsonResponse(
          {
            error:
              "This license is already linked to another TagPulse account.",
            is_pro: false
          },
          403,
          corsHeaders
        );
      }

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


    // METHOD B: AUTOMATIC PRO ACCESS BY AUTHENTICATED USER ID
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
    // LEMON PRO USER PATH
    // =========================================================

    if (license) {

      const currentCredits =
        Number(
          license.credits_remaining
        );

      if (
        !Number.isFinite(currentCredits) ||
        currentCredits <= 0
      ) {

        return jsonResponse(
          {
            error:
              "Your 500-generation Pro allowance has been used.",
            credits_remaining: 0,
            is_pro: true,
            pro_type: "lemon"
          },
          402,
          corsHeaders
        );
      }

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
            credits_remaining: latest,
            is_pro: true,
            pro_type: "lemon"
          },
          402,
          corsHeaders
        );
      }

      try {

        const text =
          await callGroq(
            prompt,
            env.GROQ_API_KEY
          );

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

        const remaining =
          await getLicenseCredits(
            env.DB,
            license.id
          );

        return jsonResponse(
          {
            text,
            credits_remaining: remaining,
            is_pro: true,
            pro_type: "lemon"
          },
          200,
          corsHeaders
        );

      } catch (err) {

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
          credits_remaining: remaining,
          is_pro: false,
          pro_type: null
        },
        402,
        corsHeaders
      );
    }

    try {

      const text =
        await callGroq(
          prompt,
          env.GROQ_API_KEY
        );

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

      await env.DB.prepare(
        `INSERT INTO generations
         (user_id, license_id)
         VALUES (?1, NULL)`
      )
        .bind(
          normalizedUserId
        )
        .run();

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
          credits_remaining: row ? Number(row.credits_remaining) : 0,
          is_pro: false,
          pro_type: null
        },
        200,
        corsHeaders
      );

    } catch (err) {

      await refundFreeCredit(
        env.DB,
        normalizedUserId
      );

      throw err;
    }

  } catch (err) {

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
 * SUPABASE AUTHENTICATION
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
      .slice(
        7
      )
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

    if (!response.ok) {

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
 * RESERVE ONE CREATOR PRO CREDIT
 * =============================================================
 */

async function reserveCreatorCredit(
  db,
  userId
) {

  const result =
    await db.prepare(
      `UPDATE creator_pro
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
 * REFUND ONE CREATOR PRO CREDIT
 * =============================================================
 */

async function refundCreatorCredit(
  db,
  userId
) {

  await db.prepare(
    `UPDATE creator_pro
     SET credits_remaining =
           credits_remaining + 1,
         updated_at =
           CURRENT_TIMESTAMP
     WHERE user_id = ?1
       AND credits_remaining < ?2`
  )
    .bind(
      userId,
      PAID_CREDITS
    )
    .run();
}


/**
 * =============================================================
 * GET CURRENT CREATOR PRO CREDITS
 * =============================================================
 */

async function getCreatorCredits(
  db,
  userId
) {

  const row =
    await db.prepare(
      `SELECT
         credits_remaining
       FROM creator_pro
       WHERE user_id = ?1`
    )
      .bind(
        userId
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
 * RESERVE ONE FREE CREDIT
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

  let data;

  try {

    data =
      await res.json();

  } catch (_) {

    throw new Error(
      "Received a malformed response from the AI service."
    );
  }

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
 * SHA-256 HASHING HELPER
 * =============================================================
 */

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


/**
 * =============================================================
 * RESPONSE & CORS HELPERS
 * =============================================================
 */

function buildCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}
