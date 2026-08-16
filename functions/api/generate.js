/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/generate
 *
 * D1-backed credit system:
 * Free users  : 5 generations
 * Pro licenses: 500 generations
 *
 * Request body:
 * {
 *   "prompt": "...",
 *   "user_id": "...",
 *   "license_key": "..."
 * }
 *
 * Success:
 * {
 *   "text": "...",
 *   "credits_remaining": 4,
 *   "is_pro": false
 * }
 * =============================================================
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const GROQ_MODEL_PRIMARY = "openai/gpt-oss-120b";
const GROQ_MODEL_FALLBACK = "openai/gpt-oss-120b";

const GROQ_TIMEOUT_MS = 30000;

const FREE_CREDITS = 5;
const PRO_CREDITS = 500;


/**
 * =============================================================
 * POST /api/generate
 * =============================================================
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = buildCorsHeaders();

  try {
    if (!env.DB) {
      console.error("D1 binding DB is missing.");
      return jsonResponse(
        { error: "Server database is not configured correctly." },
        500,
        corsHeaders
      );
    }

    let body;

    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse(
        { error: "Request body must be valid JSON." },
        400,
        corsHeaders
      );
    }

    const prompt = body && body.prompt;
    const userId = body && body.user_id;
    const licenseKey = body && body.license_key;

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return jsonResponse(
        { error: "A non-empty 'prompt' string is required." },
        400,
        corsHeaders
      );
    }

    if (!userId || typeof userId !== "string" || !isValidUserId(userId)) {
      return jsonResponse(
        { error: "A valid user ID is required." },
        400,
        corsHeaders
      );
    }

    if (!env.GROQ_API_KEY) {
      console.error("GROQ_API_KEY is not configured.");

      return jsonResponse(
        {
          error:
            "Server is not configured correctly (missing GROQ_API_KEY)."
        },
        500,
        corsHeaders
      );
    }

    /*
     * ---------------------------------------------------------
     * 1. Determine whether this is a Pro license request.
     * ---------------------------------------------------------
     */

    let account = null;

    if (
      typeof licenseKey === "string" &&
      licenseKey.trim()
    ) {
      account = await getLicenseAccount(
        env.DB,
        licenseKey.trim()
      );
    }

    /*
     * ---------------------------------------------------------
     * 2. If valid Pro license exists, reserve one Pro credit.
     * Otherwise use the anonymous free-user account.
     * ---------------------------------------------------------
     */

    let reservation;

    if (account && account.status === "active") {
      reservation = await reserveLicenseCredit(
        env.DB,
        account.id
      );

      if (!reservation.success) {
        return jsonResponse(
          {
            error:
              "Your 500 Pro generations have been used. There are no credits remaining on this license.",
            credits_remaining: 0,
            is_pro: true
          },
          402,
          corsHeaders
        );
      }

      /*
       * Important:
       * A valid Pro license always takes priority over free credits.
       */
      reservation.isPro = true;
      reservation.licenseId = account.id;
      reservation.userId = userId;
    } else {
      reservation = await reserveFreeCredit(
        env.DB,
        userId
      );

      if (!reservation.success) {
        return jsonResponse(
          {
            error:
              "Your 5 free generations are finished. Upgrade to Pro to continue.",
            credits_remaining: 0,
            is_pro: false
          },
          402,
          corsHeaders
        );
      }

      reservation.isPro = false;
      reservation.licenseId = null;
      reservation.userId = userId;
    }

    /*
     * ---------------------------------------------------------
     * 3. Call Groq.
     *
     * Credit has already been atomically reserved.
     * If Groq fails, we refund the credit.
     * ---------------------------------------------------------
     */

    let text;

    try {
      text = await callGroq(
        prompt.trim(),
        env.GROQ_API_KEY
      );
    } catch (err) {
      /*
       * Refund the reserved credit because the user did not
       * receive a successful generation.
       */
      try {
        await refundCredit(env.DB, reservation);
      } catch (refundError) {
        console.error(
          "Credit refund failed:",
          refundError
        );
      }

      if (err && err.message === "GROQ_TIMEOUT") {
        return jsonResponse(
          {
            error:
              "The AI took too long to respond. Your credit was not consumed. Please try again."
          },
          504,
          corsHeaders
        );
      }

      console.error("Groq call failed:", err);

      return jsonResponse(
        {
          error:
            (err && err.message) ||
            "Something went wrong generating your SEO listing. Your credit was not consumed."
        },
        502,
        corsHeaders
      );
    }

    /*
     * ---------------------------------------------------------
     * 4. Record successful generation.
     * ---------------------------------------------------------
     */

    try {
      await env.DB.prepare(
        `
        INSERT INTO generations
          (user_id, license_id)
        VALUES
          (?, ?)
        `
      )
        .bind(
          reservation.userId,
          reservation.licenseId
        )
        .run();
    } catch (err) {
      /*
       * Do NOT fail the user's successful AI result just because
       * analytics/history insertion failed.
       *
       * The credit was already safely deducted.
       */
      console.error(
        "Generation history insert failed:",
        err
      );
    }

    /*
     * ---------------------------------------------------------
     * 5. Return result + authoritative server-side balance.
     * ---------------------------------------------------------
     */

    return jsonResponse(
      {
        text,
        credits_remaining: reservation.creditsRemaining,
        is_pro: reservation.isPro
      },
      200,
      corsHeaders
    );

  } catch (err) {
    console.error(
      "Unhandled error in /api/generate:",
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
 * OPTIONS /api/generate
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
 * LICENSE LOOKUP
 * =============================================================
 */
async function getLicenseAccount(db, licenseKey) {
  const hash = await sha256(licenseKey);

  const result = await db.prepare(
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

  return result || null;
}


/**
 * =============================================================
 * RESERVE FREE CREDIT
 *
 * The UPDATE is atomic:
 *
 * credits_remaining > 0
 *
 * prevents two simultaneous requests from spending the same
 * final credit.
 * =============================================================
 */
async function reserveFreeCredit(db, userId) {
  /*
   * Create the user if this is their first generation.
   */
  await db.prepare(
    `
    INSERT OR IGNORE INTO free_users
      (user_id, credits_remaining)
    VALUES
      (?, ?)
    `
  )
    .bind(userId, FREE_CREDITS)
    .run();

  /*
   * Atomically consume one credit.
   */
  const update = await db.prepare(
    `
    UPDATE free_users
    SET
      credits_remaining = credits_remaining - 1,
      updated_at = CURRENT_TIMESTAMP,
      last_used_at = CURRENT_TIMESTAMP
    WHERE
      user_id = ?
      AND credits_remaining > 0
    `
  )
    .bind(userId)
    .run();

  if (!update.success || update.meta.changes !== 1) {
    return {
      success: false
    };
  }

  const row = await db.prepare(
    `
    SELECT credits_remaining
    FROM free_users
    WHERE user_id = ?
    LIMIT 1
    `
  )
    .bind(userId)
    .first();

  return {
    success: true,
    creditsRemaining: Number(
      row?.credits_remaining ?? 0
    )
  };
}


/**
 * =============================================================
 * RESERVE PRO LICENSE CREDIT
 * =============================================================
 */
async function reserveLicenseCredit(db, licenseId) {
  const update = await db.prepare(
    `
    UPDATE licenses
    SET
      credits_remaining = credits_remaining - 1,
      updated_at = CURRENT_TIMESTAMP,
      last_used_at = CURRENT_TIMESTAMP
    WHERE
      id = ?
      AND status = 'active'
      AND credits_remaining > 0
    `
  )
    .bind(licenseId)
    .run();

  if (!update.success || update.meta.changes !== 1) {
    return {
      success: false
    };
  }

  const row = await db.prepare(
    `
    SELECT credits_remaining
    FROM licenses
    WHERE id = ?
    LIMIT 1
    `
  )
    .bind(licenseId)
    .first();

  return {
    success: true,
    creditsRemaining: Number(
      row?.credits_remaining ?? 0
    )
  };
}


/**
 * =============================================================
 * REFUND RESERVED CREDIT
 *
 * Used only if Groq fails after we reserved the credit.
 * =============================================================
 */
async function refundCredit(db, reservation) {
  if (
    reservation.isPro &&
    reservation.licenseId
  ) {
    await db.prepare(
      `
      UPDATE licenses
      SET
        credits_remaining = credits_remaining + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
      .bind(reservation.licenseId)
      .run();

    return;
  }

  await db.prepare(
    `
    UPDATE free_users
    SET
      credits_remaining = credits_remaining + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
    `
  )
    .bind(reservation.userId)
    .run();
}


/**
 * =============================================================
 * GROQ
 * =============================================================
 */
async function callGroq(prompt, apiKey) {
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
 * SINGLE GROQ REQUEST
 * =============================================================
 */
async function callGroqModel(
  model,
  prompt,
  apiKey
) {
  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
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
        body: JSON.stringify({
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
        }),
        signal: controller.signal
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
    clearTimeout(timeoutId);
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
        errBody &&
        errBody.error &&
        errBody.error.message
      ) {
        message =
          errBody.error.message;
      }
    } catch (_) {}

    throw new Error(message);
  }

  let data;

  try {
    data = await res.json();
  } catch (_) {
    throw new Error(
      "Received a malformed response from the AI service."
    );
  }

  const choice =
    data &&
    data.choices &&
    data.choices[0];

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
    choice.message &&
    choice.message.content;

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
