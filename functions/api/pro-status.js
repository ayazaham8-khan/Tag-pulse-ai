/**
 * =============================================================
 * TagPulse AI — Pro Status
 * Cloudflare Pages Function
 *
 * POST /api/pro-status
 *
 * Purpose:
 *   - Verify the authenticated Supabase user.
 *   - Check Creator Pro entitlement in D1.
 *   - Check Lemon Squeezy Pro license in D1.
 *   - Return current Pro/free credits.
 *
 * Authentication:
 *   Authorization: Bearer <Supabase access token>
 *
 * IMPORTANT:
 *   - The server NEVER trusts a frontend user_id.
 *   - The authenticated Supabase user ID is authoritative.
 *
 * D1 tables:
 *   creator_pro
 *   licenses
 *   free_users
 *
 * Pro types:
 *   creator
 *   lemon
 * =============================================================
 */


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


    const userId =
      authenticatedUser.id;


    // =========================================================
    // 3. CHECK CREATOR PRO
    // =========================================================
    //
    // Creator Pro is manually provisioned in:
    //
    //   creator_pro
    //
    // This path is checked before Lemon Squeezy.
    //
    // Creator accounts therefore do not need:
    //
    // - Lemon checkout
    // - a payment card
    // - a Lemon license
    //
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
          userId
        )
        .first();


    // =========================================================
    // 4. CREATOR PRO USER
    // =========================================================

    if (creatorPro) {

      const credits =
        Math.max(
          0,
          Number(
            creatorPro.credits_remaining || 0
          )
        );


      return jsonResponse(
        {
          is_pro: true,

          pro_type:
            "creator",

          credits_remaining:
            credits
        },
        200,
        corsHeaders
      );
    }


    // =========================================================
    // 5. CHECK LEMON SQUEEZY PRO LICENSE
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
        .bind(
          userId
        )
        .first();


    // =========================================================
    // 6. LEMON PRO USER
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

          pro_type:
            "lemon",

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
    // No creator Pro entitlement.
    // No active Lemon Pro license.
    //
    // Read normal free credits from D1.
    //
    // We intentionally do NOT create the free_users row here.
    // generate.js creates it when the user generates for the
    // first time.
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
        .bind(
          userId
        )
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

        pro_type:
          null,

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
 * SUPABASE AUTHENTICATION
 * =============================================================
 *
 * Reads:
 *
 *   Authorization: Bearer <Supabase access token>
 *
 * and verifies the token against Supabase Auth.
 *
 * The returned user ID comes from Supabase's authenticated
 * response and is not taken from the request body.
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
