/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/generate
 *
 * D1-backed credit enforcement:
 * - Free users: 5 generations total
 * - Paid users: 500 generations total
 * - Credits are enforced SERVER-SIDE
 * - Frontend credit count is never trusted
 * - Failed AI requests refund the reserved credit
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
 * POST /api/generate
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders =
    buildCorsHeaders();

  try {

    // ---------------------------------------------------------
    // 1. D1 binding
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
    // 2. Parse request
    // ---------------------------------------------------------
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

    const prompt =
      body && body.prompt;

    const userId =
      body && body.user_id;

    const licenseKey =
      body && body.license_key;

    // ---------------------------------------------------------
    // 3. Validate prompt
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
    // 4. Validate user ID
    // ---------------------------------------------------------
    if (
      !userId ||
      typeof userId !== "string" ||
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
    // 5. Groq key
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

    const normalizedLicense =
      typeof licenseKey === "string"
        ? licenseKey.trim()
        : "";

    // =========================================================
    // PAID LICENSE PATH
    // =========================================================
    if (normalizedLicense) {

      const licenseHash =
        await sha256(
          normalizedLicense
        );

      const license =
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
          .bind(licenseHash)
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

      // -------------------------------------------------------
      // License belongs to another browser/user.
      // -------------------------------------------------------
      if (
        license.user_id &&
        license.user_id !== userId
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

      if (
        Number(
          license.credits_remaining
        ) <= 0
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
      // -------------------------------------------------------
      const reserved =
        await reserveLicenseCredit(
          env.DB,
          license.id
        );

      if (!reserved) {
        return jsonResponse(
          {
            error:
              "No Pro credits remaining. Please try again.",
            credits_remaining: 0,
            is_pro: true
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
          .bind(license.id)
          .run();

        await env.DB.prepare(
          `INSERT INTO generations
           (user_id, license_id)
           VALUES (?1, ?2)`
        )
          .bind(
            userId,
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
            credits_remaining:
              remaining,
            is_pro: true
          },
          200,
          corsHeaders
        );

      } catch (err) {

        // AI failed, refund the reserved credit.
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
        userId,
        FREE_CREDITS
      )
      .run();

    const reserved =
      await reserveFreeCredit(
        env.DB,
        userId
      );

    if (!reserved) {

      const row =
        await env.DB.prepare(
          `SELECT credits_remaining
           FROM free_users
           WHERE user_id = ?1`
        )
          .bind(userId)
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
        .bind(userId)
        .run();

      await env.DB.prepare(
        `INSERT INTO generations
         (user_id, license_id)
         VALUES (?1, NULL)`
      )
        .bind(userId)
        .run();

      const row =
        await env.DB.prepare(
          `SELECT credits_remaining
           FROM free_users
           WHERE user_id = ?1`
        )
          .bind(userId)
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

      await refundFreeCredit(
        env.DB,
        userId
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
 * CORS OPTIONS
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
 * Reserve one free credit.
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
      .bind(userId)
      .run();

  return (
    Number(
      result.meta?.changes || 0
    ) === 1
  );
}

/**
 * Refund free credit after AI failure.
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
 * Reserve one paid credit.
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
      .bind(licenseId)
      .run();

  return (
    Number(
      result.meta?.changes || 0
    ) === 1
  );
}

/**
 * Refund paid credit after AI failure.
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
 * Get current paid credits.
 */
async function getLicenseCredits(
  db,
  licenseId
) {
  const row =
    await db.prepare(
      `SELECT credits_remaining
       FROM licenses
       WHERE id = ?1`
    )
      .bind(licenseId)
      .first();

  return row
    ? Number(
        row.credits_remaining
      )
    : 0;
}

/**
 * Groq call with fallback.
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
 * Single Groq model request.
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

    res = await fetch(
      GROQ_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Authorization":
            "Bearer " + apiKey
        },

        body: JSON.stringify(
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
 * SHA-256
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
    new Uint8Array(digest)
  )
    .map(
      b =>
        b
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

/**
 * JSON response helper.
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
 * CORS headers.
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
