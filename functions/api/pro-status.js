/**
 * =============================================================
 * TagPulse AI — Pro Status
 * Cloudflare Pages Function
 *
 * POST /api/pro-status
 *
 * Purpose:
 *   - Check whether the current browser/user has an active
 *     TagPulse AI Pro license.
 *   - Return current Pro credits.
 *   - Used by the frontend after returning from Lemon Squeezy.
 *
 * Request body:
 * {
 *   "user_id": "<browser-generated stable user id>"
 * }
 *
 * Success — Pro:
 * {
 *   "is_pro": true,
 *   "credits_remaining": 500
 * }
 *
 * Success — Free:
 * {
 *   "is_pro": false,
 *   "credits_remaining": 5
 * }
 *
 * D1 binding required:
 *   DB
 *
 * Lemon Squeezy:
 *   Test Mode
 * =============================================================
 */


/**
 * =============================================================
 * POST /api/pro-status
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
        "Pro status: D1 binding DB is missing."
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
    // 2. Parse JSON body
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
    // 3. Read user_id
    // ---------------------------------------------------------

    const userId =
      body &&
      typeof body.user_id === "string"
        ? body.user_id.trim()
        : "";


    // ---------------------------------------------------------
    // 4. Validate user_id
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


    // =========================================================
    // 5. CHECK PRO LICENSE
    // =========================================================
    //
    // A user is considered Pro when:
    //
    //   user_id matches
    //   AND
    //   license status = active
    //
    // We order by id DESC so that if a user somehow has more
    // than one license, the newest active license is preferred.
    //
    // =========================================================

    const license =
      await env.DB.prepare(
        `SELECT
           id,
           status,
           credits_remaining
         FROM licenses
         WHERE user_id = ?1
           AND status = 'active'
         ORDER BY id DESC
         LIMIT 1`
      )
        .bind(userId)
        .first();


    // =========================================================
    // 6. PRO USER
    // =========================================================

    if (license) {

      const credits =
        Math.max(
          0,
          Number(
            license.credits_remaining || 0
          )
        );


      return jsonResponse(
        {
          is_pro: true,

          credits_remaining:
            credits
        },
        200,
        corsHeaders
      );
    }


    // =========================================================
    // 7. FREE USER
    // =========================================================
    //
    // No active license was found.
    //
    // Read the user's free credits from D1.
    //
    // IMPORTANT:
    // We do NOT create the free_users row here.
    //
    // generate.js already creates it when necessary.
    //
    // =========================================================

    const freeUser =
      await env.DB.prepare(
        `SELECT
           credits_remaining
         FROM free_users
         WHERE user_id = ?1
         LIMIT 1`
      )
        .bind(userId)
        .first();


    const freeCredits =
      freeUser
        ? Math.max(
            0,
            Number(
              freeUser.credits_remaining || 0
            )
          )
        : 5;


    return jsonResponse(
      {
        is_pro: false,

        credits_remaining:
          freeCredits
      },
      200,
      corsHeaders
    );


  } catch (err) {

    console.error(
      "Unhandled /api/pro-status error:",
      err
    );


    return jsonResponse(
      {
        error:
          "Unable to check Pro status. Please try again."
      },
      500,
      corsHeaders
    );
  }
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
