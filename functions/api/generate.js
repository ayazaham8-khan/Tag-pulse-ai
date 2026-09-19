/**
 * =============================================================
 * TagPulse AI — Cloudflare Pages Function
 * POST /api/generate
 *
 * Supabase Auth + D1-backed credit enforcement
 *
 * FREE USERS
 * - 3 generations total
 *
 * PAID USERS
 * - Starter: 100 generations
 * - Power Seller: 700 generations
 * - Actual per-license amount is stored on the license row itself
 *   (initial_credits), not a single fixed number.
 *
 * CREATOR PRO USERS
 * - Provisioned manually in D1 creator_pro table with whatever
 *   amount the site owner grants — not tied to either paid tier
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

// TEMPORARY: confirmed returning HTTP 404 for our account in
// production (see the "Groq primary AND fallback both failed"
// diagnostic capture). Attempting it currently guarantees a
// second failed request for no benefit, so it's bypassed for now.
// Re-enable only after confirming a working model via the
// existing checkGroqModelAvailability() live-check output.
const GROQ_FALLBACK_ENABLED = false;

// Explicit output-token ceiling — previously unset. Sized for the
// longest realistic listing JSON (140-char title + 15 keywords/
// tags + a multi-sentence description + JSON structural overhead
// is comfortably under 600 tokens) plus generous headroom for
// gpt-oss-120b's reasoning-token usage, without being unbounded.
const GROQ_MAX_COMPLETION_TOKENS = 2048;

const GROQ_TIMEOUT_MS = 30000;

const FREE_CREDITS = 3;


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
    //
    // The frontend must send:
    //
    // Authorization: Bearer <Supabase access token>
    //
    // We NEVER accept body.user_id as the identity.
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
    // 2.5. Creator Pro invitation provisioning
    //
    // If this authenticated user's verified email matches a
    // pending row in creator_invites, this atomically consumes
    // the invite and provisions creator_pro (500 credits) —
    // without ever touching an existing creator_pro balance.
    //
    // No-op for everyone else (normal users, Lemon users,
    // already-provisioned creators, already-used invites).
    // ---------------------------------------------------------

    await provisionCreatorFromInvite(
      env.DB,
      normalizedUserId,
      authenticatedUser.email
    );


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
    //
    // Creator Pro is stored separately in:
    //
    //   creator_pro
    //
    // This is intentionally checked before the Lemon license.
    //
    // A creator account therefore does not need:
    //
    // - a Lemon Squeezy license
    // - checkout
    // - a card
    //
    // The creator_pro table itself is server-controlled.
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


      // -------------------------------------------------------
      // No creator credits remaining.
      // -------------------------------------------------------

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


      // -------------------------------------------------------
      // Reserve one creator Pro credit BEFORE calling Groq.
      // -------------------------------------------------------

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
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // Record generation.
        //
        // creator Pro is not a Lemon license, so license_id is
        // intentionally NULL.
        // -----------------------------------------------------

        await env.DB.prepare(
          `INSERT INTO generations
           (user_id, license_id)
           VALUES (?1, NULL)`
        )
          .bind(
            normalizedUserId
          )
          .run();


        // -----------------------------------------------------
        // Get exact remaining creator balance.
        // -----------------------------------------------------

        const remaining =
          await getCreatorCredits(
            env.DB,
            normalizedUserId
          );


        return jsonResponse(
          {
            text,

            credits_remaining:
              remaining,

            is_pro: true,

            pro_type: "creator"
          },
          200,
          corsHeaders
        );


      } catch (err) {

        // -----------------------------------------------------
        // Groq failed — refund reserved creator credit.
        // -----------------------------------------------------

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
    //
    // We support:
    //
    // A) authenticated user + manual license_key
    // B) authenticated user + automatic D1 Pro license
    //
    // The authenticated Supabase user ID is ALWAYS authoritative.
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
      // License key does not exist.
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
      // Prevent license theft / account switching.
      // -------------------------------------------------------

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
      // If an existing license has no owner, bind it to the
      // authenticated Supabase user.
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
    // AUTOMATIC PRO ACCESS BY AUTHENTICATED USER ID
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
    // LEMON PRO USER PATH
    // =========================================================

    if (license) {

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
              "Your Pro generation allowance has been used.",
            credits_remaining: 0,
            is_pro: true,
            pro_type: "lemon"
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
            is_pro: true,
            pro_type: "lemon"
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

            is_pro: true,

            pro_type: "lemon"
          },
          200,
          corsHeaders
        );


      } catch (err) {

        // -----------------------------------------------------
        // Groq failed — refund reserved Pro credit.
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
    // No creator Pro entitlement.
    // No active Lemon Pro license.
    // Therefore use the normal 5-generation system.
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
            "You've used all " +
            FREE_CREDITS +
            " free generations. Upgrade to Pro for more generations.",

          credits_remaining:
            remaining,

          is_pro: false,

          pro_type: null
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

          is_pro: false,

          pro_type: null
        },
        200,
        corsHeaders
      );


    } catch (err) {

      // -------------------------------------------------------
      // Groq failed — refund reserved free credit.
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
      err.category === "timeout"
    ) {

      return jsonResponse(
        {
          error:
            "The AI took too long to respond (model: " +
            (err.groqModel || GROQ_MODEL_PRIMARY) +
            "). Please try again."
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
      (err && err.errorDetail) ||
        describeGroqError(err) ||
        (err && err.message) ||
        err
    );


    return jsonResponse(
      {
        error:
          err && err.message
            ? err.message
            : "Something went wrong generating your SEO listing.",
        error_detail:
          (err && err.errorDetail) || undefined
      },
      (err && typeof err.groqStatus === "number")
        ? err.groqStatus
        : 502,
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
 * CREATOR PRO INVITATION PROVISIONING
 * =============================================================
 *
 * If the authenticated user's verified email matches a pending
 * row in creator_invites, atomically:
 *
 *   1. Mark that invitation 'used' — only if it is still
 *      'pending' (prevents a second grant on repeat logins or
 *      repeated requests).
 *   2. Create the creator_pro row with 500 credits — only if
 *      step 1 actually consumed a pending invite for this exact
 *      user_id, AND only if a creator_pro row does not already
 *      exist for this user (so an existing Creator Pro balance,
 *      however it was created, is never reset or overwritten).
 *
 * Both statements run inside a single D1 batch(), which executes
 * as one transaction — either both apply or neither does. That
 * means a mid-way failure (e.g. the INSERT failing for some
 * reason) can never leave an invitation permanently consumed
 * without Creator Pro actually being created; the whole batch
 * rolls back and the invite remains 'pending' for the next
 * authenticated request to retry.
 *
 * The gating logic (has a pending invite? does creator_pro
 * already exist?) is expressed entirely inside the SQL itself
 * via EXISTS / NOT EXISTS, not in application code — this is
 * what keeps two simultaneous requests for the same invited
 * creator safe: D1 serializes write transactions against the
 * same rows, so the second batch to run always sees the first
 * batch's committed effects before its own statements execute.
 *
 * This function never throws to its caller. If provisioning
 * fails for any reason, it is only logged — normal generation,
 * free-user, and Lemon flows continue completely unaffected.
 * =============================================================
 */

async function provisionCreatorFromInvite(
  db,
  userId,
  email
) {

  if (
    !userId ||
    !email ||
    typeof email !== "string"
  ) {
    return;
  }


  const normalizedEmail =
    email
      .trim()
      .toLowerCase();


  if (!normalizedEmail) {
    return;
  }


  try {

    const results =
      await db.batch(
        [

          db.prepare(
            `UPDATE creator_invites
             SET status = 'used',
                 used_at = CURRENT_TIMESTAMP,
                 user_id = ?1
             WHERE LOWER(TRIM(email)) = ?2
               AND status = 'pending'`
          )
            .bind(
              userId,
              normalizedEmail
            ),

          db.prepare(
            `INSERT INTO creator_pro
               (user_id, credits_remaining)
             SELECT
               ?1,
               500
             WHERE EXISTS (
               SELECT 1
               FROM creator_invites
               WHERE LOWER(TRIM(email)) = ?2
                 AND status = 'used'
                 AND user_id = ?1
             )
             AND NOT EXISTS (
               SELECT 1
               FROM creator_pro
               WHERE user_id = ?1
             )`
          )
            .bind(
              userId,
              normalizedEmail
            )

        ]
      );


    // -------------------------------------------------------
    // Read back the invite UPDATE's actual row-change count
    // from D1's batch result meta, purely for logging/
    // confirmation — the correctness of the operation does
    // NOT depend on this check (that lives in the SQL's
    // EXISTS / NOT EXISTS conditions above).
    // -------------------------------------------------------

    const inviteChanges =
      Number(
        results?.[0]?.meta?.changes || 0
      );


    if (inviteChanges === 1) {

      console.log(
        "Creator invite consumed; Creator Pro provisioning attempted.",
        {
          userId,
          email: normalizedEmail
        }
      );
    }

  } catch (err) {

    console.error(
      "Creator invite provisioning failed (invitation left untouched):",
      err
    );
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

  // This is only ever called immediately after this same request's
  // reserveCreatorCredit() succeeded (see the catch block above), so
  // it always restores exactly the one credit that request reserved.
  // No upper-bound ceiling is applied — Creator Pro balances are
  // manually granted and not tied to a fixed tier amount, so a
  // hardcoded cap here could incorrectly block a legitimate refund
  // for a creator whose granted balance exceeds that cap.

  await db.prepare(
    `UPDATE creator_pro
     SET credits_remaining =
           credits_remaining + 1,
         updated_at =
           CURRENT_TIMESTAMP
     WHERE user_id = ?1`
  )
    .bind(
      userId
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
       AND credits_remaining < initial_credits`
  )
    .bind(
      licenseId
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

  let primaryErr;

  try {

    return await callGroqModel(
      GROQ_MODEL_PRIMARY,
      prompt,
      apiKey
    );

  } catch (err) {

    primaryErr = err;

    if (
      primaryErr &&
      primaryErr.category === "timeout"
    ) {

      // Unchanged behavior: a primary timeout does not attempt
      // the fallback model.
      throw primaryErr;
    }


    if (!GROQ_FALLBACK_ENABLED) {

      // Fallback is temporarily disabled (see GROQ_FALLBACK_ENABLED
      // above) — do not attempt it, and do not report this as a
      // "both models failed" event, since only the primary was
      // actually attempted.
      console.error(
        "Groq primary model failed (fallback disabled):",
        describeGroqError(primaryErr)
      );

      throw buildFallbackDisabledError(
        primaryErr
      );
    }


    console.error(
      "Groq primary model failed, falling back:",
      describeGroqError(primaryErr)
    );
  }


  try {

    const text =
      await callGroqModel(
        GROQ_MODEL_FALLBACK,
        prompt,
        apiKey
      );


    console.error(
      "Groq primary model failed but fallback succeeded:",
      describeGroqError(primaryErr)
    );

    return text;

  } catch (fallbackErr) {

    console.error(
      "Groq primary AND fallback both failed:",
      {
        primary: describeGroqError(primaryErr),
        fallback: describeGroqError(fallbackErr)
      }
    );


    const availability =
      await checkGroqModelAvailability(
        apiKey,
        [
          GROQ_MODEL_PRIMARY,
          GROQ_MODEL_FALLBACK,
          "qwen/qwen3.8-27b",
          "openai/gpt-oss-20b"
        ]
      );

    if (availability) {

      console.error(
        "Live Groq model availability check:",
        availability
      );
    }


    throw buildBothFailedError(
      primaryErr,
      fallbackErr,
      availability
    );
  }
}


/**
 * =============================================================
 * STRUCTURED OUTPUT SCHEMAS
 * -------------------------------------------------------------
 * Two shapes only, matching the two output contracts that
 * actually exist in public/index.html today:
 *
 *   - TAGS_OUTPUT_SCHEMA    -> { title, tags, description }
 *     Read by validateParsedOutput() (POD/generic), and by the
 *     dedicated validateEtsyOutput() and
 *     validateDigitalPrintableOutput() — all three only ever
 *     read parsed.title / parsed.tags / parsed.description.
 *
 *   - KEYWORDS_OUTPUT_SCHEMA -> { title, keywords, description }
 *     Read by validatePinterestOutput(), which only ever reads
 *     parsed.title / parsed.keywords / parsed.description.
 *
 * No other field is read by any validator or renderer in the
 * frontend, so no other field is declared here.
 *
 * Exact tag/keyword COUNT (13 vs 15) and per-item/title/
 * description character limits are intentionally NOT expressed
 * here: Groq's strict-mode Structured Outputs does not support
 * minItems/maxItems or string length constraints (they are
 * silently unsupported / can cause the schema to be rejected).
 * Those exact counts and lengths continue to be enforced exactly
 * as before, by the existing, unmodified frontend validators —
 * strict mode's job here is only to guarantee a syntactically and
 * structurally valid {title, tags|keywords, description} object
 * every time, eliminating the "Failed to validate JSON" failure
 * class this was added to fix.
 * =============================================================
 */

const TAGS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    tags: {
      type: "array",
      items: { type: "string" }
    },
    description: { type: "string" }
  },
  required: ["title", "tags", "description"],
  additionalProperties: false
};

const KEYWORDS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    keywords: {
      type: "array",
      items: { type: "string" }
    },
    description: { type: "string" }
  },
  required: ["title", "keywords", "description"],
  additionalProperties: false
};

/**
 * The backend never receives the selected platform/category —
 * the frontend only ever sends the finished prompt string. Each
 * prompt builder embeds its own literal example output shape in
 * its "OUTPUT FORMAT" section, and exactly one of them
 * (buildPinterestPrompt) declares a `"keywords":` field; the
 * other three (buildStandardPrompt/buildEtsyPrompt/
 * buildDigitalPrintablePrompt) all declare `"tags":`. That literal
 * substring is therefore a reliable, already-unique signal for
 * which schema this specific request needs — verified against the
 * current prompt builders, which are unmodified by this change.
 */
function selectResponseFormat(
  prompt
) {

  const isKeywordsShape =
    typeof prompt === "string" &&
    prompt.includes('"keywords":');

  if (isKeywordsShape) {

    return {
      type: "json_schema",
      json_schema: {
        name: "seo_listing_keywords",
        strict: true,
        schema: KEYWORDS_OUTPUT_SCHEMA
      }
    };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: "seo_listing_tags",
      strict: true,
      schema: TAGS_OUTPUT_SCHEMA
    }
  };
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

                max_completion_tokens:
                  GROQ_MAX_COMPLETION_TOKENS,

                response_format:
                  selectResponseFormat(prompt)
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

      throw makeGroqError(
        "timeout",
        model,
        null,
        "The AI took too long to respond."
      );
    }


    throw makeGroqError(
      "network",
      model,
      null,
      (err && err.message) ||
        "Couldn't reach the AI service."
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

    let errType = null;
    let errCode = null;
    let failedGeneration = null;


    try {

      const errBody =
        await res.json();


      if (
        errBody?.error?.message
      ) {

        message =
          errBody.error.message;
      }

      if (errBody?.error?.type) {
        errType = errBody.error.type;
      }

      if (errBody?.error?.code) {
        errCode = errBody.error.code;
      }

      if (errBody?.error?.failed_generation) {
        // Bounded generously (not the standard 300-char log cap) —
        // this is the single most diagnostic field for a strict-
        // mode schema failure (it's the model's actual raw output
        // that failed validation), so we want enough of it to see
        // whether/where it was truncated or malformed.
        failedGeneration =
          truncateForLog(
            errBody.error.failed_generation,
            4000
          );
      }

    } catch (_) {}


    let category = "http";

    if (res.status === 429) {
      category = "rate_limit";
    } else if (res.status >= 500) {
      category = "server_error";
    } else if (res.status >= 400) {
      category = "client_error";
    }


    throw makeGroqError(
      category,
      model,
      res.status,
      message,
      {
        type: errType,
        code: errCode,
        failedGeneration: failedGeneration
      }
    );
  }


  let data;


  try {

    data =
      await res.json();

  } catch (_) {

    throw makeGroqError(
      "malformed",
      model,
      res.status,
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

    throw makeGroqError(
      "content_filter",
      model,
      res.status,
      "The AI couldn't generate a result for this input. Try rephrasing your product keyword."
    );
  }


  const text =
    choice.message?.content;


  if (!text) {

    throw makeGroqError(
      "empty",
      model,
      res.status,
      "The AI didn't return a usable result. Please try again."
    );
  }


  return text;
}


/**
 * =============================================================
 * GROQ ERROR DIAGNOSTICS
 * -------------------------------------------------------------
 * Everything below is diagnostic-only additions: they change what
 * information an error carries and how it's logged, not when a
 * failure happens or how a success is produced. None of this
 * touches prompt construction, credits, or the success-path
 * response shape.
 * =============================================================
 */

/**
 * Builds an Error carrying structured diagnostic fields, so the
 * caller can distinguish timeout / network / rate-limit / client
 * error / server error / malformed / content-filter / empty
 * without re-parsing a message string.
 *
 * `extra` is optional and only ever passed by the !res.ok branch
 * above, which is the only place Groq's own error body (with a
 * possible type/code/failed_generation) is available. Every other
 * call site (timeout, network, malformed, content_filter, empty)
 * omits it, so those errors are completely unaffected by this
 * addition.
 */
function makeGroqError(
  category,
  model,
  status,
  message,
  extra
) {

  const err =
    new Error(
      message ||
        ("Groq request failed" +
          (status ? " (" + status + ")" : "") +
          ".")
    );

  err.category = category;
  err.groqModel = model;
  err.groqStatus = status || null;
  err.groqMessage = message || null;
  err.groqType = (extra && extra.type) || null;
  err.groqCode = (extra && extra.code) || null;
  err.groqFailedGeneration = (extra && extra.failedGeneration) || null;

  return err;
}

/**
 * Caps a string for safe logging — Groq error messages are
 * ordinary API error text (never the API key, a token, or a
 * license key), but this keeps logs bounded regardless.
 */
function truncateForLog(
  text,
  max
) {

  max = max || 300;
  text = String(text || "");

  return text.length > max
    ? text.slice(0, max) + "…"
    : text;
}

/**
 * Reduces a Groq error (structured or not) to a small, safe-to-log
 * object: model, category, status, message, and — when Groq's own
 * error body included them — type, code, and failed_generation
 * (the model's raw output that failed strict-mode validation).
 * Never includes the API key, an Authorization header, the user's
 * prompt/Product Details, or any user/credit data — none of those
 * are ever attached to these error objects in the first place.
 */
function describeGroqError(err) {

  if (!err) {
    return null;
  }

  return {
    model: err.groqModel || null,
    category: err.category || "unknown",
    status: err.groqStatus || null,
    message: truncateForLog(
      err.groqMessage || err.message || ""
    ),
    type: err.groqType || null,
    code: err.groqCode || null,
    failed_generation: err.groqFailedGeneration || null
  };
}

/**
 * Best-effort, read-only check against Groq's own model list,
 * using the server-side GROQ_API_KEY only (never sent to or
 * logged for the frontend). Only called when both the primary and
 * fallback model attempts have already failed, so it never adds
 * latency to a normal successful request. Bounded to a short 5s
 * timeout and never throws — a failure here must never hide or
 * replace the real underlying error.
 */
async function checkGroqModelAvailability(
  apiKey,
  modelIds
) {

  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(
      () => controller.abort(),
      5000
    );

  try {

    const res =
      await fetch(
        "https://api.groq.com/openai/v1/models",
        {
          method: "GET",
          headers: {
            "Authorization": "Bearer " + apiKey
          },
          signal: controller.signal
        }
      );

    if (!res.ok) {
      return null;
    }

    const data =
      await res.json();

    const availableIds =
      new Set(
        (data?.data || []).map(m => m.id)
      );

    const result = {};

    modelIds.forEach(id => {
      result[id] = availableIds.has(id);
    });

    return result;

  } catch (_) {

    // Diagnostic-only — never let this check itself fail the
    // actual error response.
    return null;

  } finally {

    clearTimeout(timeoutId);
  }
}

/**
 * Builds the Error thrown when the primary model fails and the
 * fallback is currently disabled (GROQ_FALLBACK_ENABLED = false).
 * Deliberately separate from buildBothFailedError() below — this
 * error must never claim two models were attempted when only one
 * was, per the diagnostics-accuracy requirement.
 */
function buildFallbackDisabledError(
  primaryErr
) {

  const p = describeGroqError(primaryErr) || {};

  const err =
    new Error(
      'The AI model "' + (p.model || GROQ_MODEL_PRIMARY) + '" failed: ' +
      (p.status ? "HTTP " + p.status + " — " : "") +
      (p.message || "unknown error") +
      ". (Fallback model is currently disabled.)"
    );

  err.category = primaryErr && primaryErr.category;
  err.groqModel = p.model || GROQ_MODEL_PRIMARY;
  err.groqStatus =
    (typeof p.status === "number" && p.status) ||
    502;
  err.fallbackDisabled = true;
  err.primary = p;
  err.errorDetail = p;

  return err;
}

/**
 * Builds the single Error thrown when BOTH the primary and
 * fallback model attempts fail, with both models' real status
 * codes and messages folded into one human-readable message
 * (surfaced verbatim to the frontend toast — no frontend change
 * needed) plus the same detail preserved as structured fields for
 * logging.
 */
function buildBothFailedError(
  primaryErr,
  fallbackErr,
  availability
) {

  const p = describeGroqError(primaryErr) || {};
  const f = describeGroqError(fallbackErr) || {};

  const parts = [
    "Both Groq models failed.",

    'Primary "' + (p.model || GROQ_MODEL_PRIMARY) + '": ' +
      (p.status ? "HTTP " + p.status + " — " : "") +
      (p.message || "unknown error") + ".",

    'Fallback "' + (f.model || GROQ_MODEL_FALLBACK) + '": ' +
      (f.status ? "HTTP " + f.status + " — " : "") +
      (f.message || "unknown error") + "."
  ];

  if (availability) {

    parts.push(
      "Live check — primary available: " +
        (availability[GROQ_MODEL_PRIMARY] ? "yes" : "no") +
        ", fallback available: " +
        (availability[GROQ_MODEL_FALLBACK] ? "yes" : "no") +
        "."
    );
  }

  const err =
    new Error(
      parts.join(" ")
    );

  err.bothFailed = true;
  err.primary = p;
  err.fallback = f;
  err.availability = availability || null;
  err.errorDetail = { primary: p, fallback: f, availability: availability || null };

  // Preserve a real HTTP status where we have one — prefer the
  // fallback's (the more recent attempt), then the primary's,
  // and only default to 502 if neither call produced a usable
  // numeric status (e.g. both were network-level failures).
  err.groqStatus =
    (typeof f.status === "number" && f.status) ||
    (typeof p.status === "number" && p.status) ||
    502;

  return err;
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
      "Content-Type, Authorization"
  };
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
