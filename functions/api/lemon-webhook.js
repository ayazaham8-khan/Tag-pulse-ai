/**
 * =============================================================
 * TagPulse AI — Lemon Squeezy Webhook
 * Cloudflare Pages Function
 *
 * POST /api/lemon-webhook
 *
 * Handles:
 *   - order_created
 *   - license_key_created
 *   - order_refunded
 *
 * Purpose:
 *   - Verify Lemon Squeezy webhook signature
 *   - Verify the purchase matches a recognized TagPulse product + variant
 *   - Store the license key as SHA-256 only
 *   - Give the customer the right number of Pro generations for
 *     whichever tier they bought
 *   - Link the purchase to the browser user_id when supplied
 *   - Prevent duplicate webhook processing
 *
 * Required Cloudflare bindings/secrets:
 *
 *   DB
 *   LEMON_WEBHOOK_SECRET
 *
 * Lemon Squeezy — Live Mode, two Pro tiers:
 *
 *   Starter:      Product ID 1305746, Variant ID 2042144, 100 credits
 *   Power Seller: Product ID 1335511, Variant ID 2086845, 700 credits
 * =============================================================
 */

/**
 * All recognized Pro products/variants and what each one grants.
 * To add or change a tier, edit this list only — every check and
 * every credit amount in this file is derived from it.
 */
const PRO_TIERS = [
  {
    name: "Starter",
    productId: "1305746",
    variantId: "2042144",
    credits: 100
  },
  {
    name: "Power Seller",
    productId: "1335511",
    variantId: "2086845",
    credits: 700
  }
];


/**
 * =============================================================
 * POST /api/lemon-webhook
 * =============================================================
 */
export async function onRequestPost(context) {

  const { request, env } = context;

  /*
   * -----------------------------------------------------------
   * 1. Required configuration
   * -----------------------------------------------------------
   */

  if (!env.DB) {

    console.error(
      "Lemon webhook: D1 binding DB is missing."
    );

    return jsonResponse(
      {
        error:
          "Server database is not configured."
      },
      500
    );
  }


  if (!env.LEMON_WEBHOOK_SECRET) {

    console.error(
      "Lemon webhook: LEMON_WEBHOOK_SECRET is missing."
    );

    return jsonResponse(
      {
        error:
          "Webhook secret is not configured."
      },
      500
    );
  }


  /*
   * -----------------------------------------------------------
   * 2. Read RAW request body
   *
   * IMPORTANT:
   * We must verify the signature against the original
   * raw request body before JSON parsing.
   * -----------------------------------------------------------
   */

  let rawBody;

  try {

    rawBody =
      await request.text();

  } catch (err) {

    console.error(
      "Lemon webhook: failed to read request body.",
      err
    );

    return jsonResponse(
      {
        error:
          "Could not read webhook request."
      },
      400
    );
  }


  /*
   * -----------------------------------------------------------
   * 3. Read Lemon Squeezy signature
   * -----------------------------------------------------------
   */

  const signature =
    request.headers.get(
      "X-Signature"
    );


  if (!signature) {

    console.error(
      "Lemon webhook: missing X-Signature header."
    );

    return jsonResponse(
      {
        error:
          "Missing webhook signature."
      },
      401
    );
  }


  /*
   * -----------------------------------------------------------
   * 4. Verify signature
   * -----------------------------------------------------------
   */

  const signatureValid =
    await verifyWebhookSignature(
      rawBody,
      signature,
      env.LEMON_WEBHOOK_SECRET
    );


  if (!signatureValid) {

    console.error(
      "Lemon webhook: invalid signature."
    );

    return jsonResponse(
      {
        error:
          "Invalid webhook signature."
      },
      401
    );
  }


  /*
   * -----------------------------------------------------------
   * 5. Parse JSON
   * -----------------------------------------------------------
   */

  let payload;

  try {

    payload =
      JSON.parse(rawBody);

  } catch (err) {

    console.error(
      "Lemon webhook: invalid JSON.",
      err
    );

    return jsonResponse(
      {
        error:
          "Webhook body must be valid JSON."
      },
      400
    );
  }


  /*
   * -----------------------------------------------------------
   * 6. Determine event
   *
   * Lemon sends X-Event-Name and also meta.event_name.
   * -----------------------------------------------------------
   */

  const headerEvent =
    request.headers.get(
      "X-Event-Name"
    );

  const metaEvent =
    payload?.meta?.event_name;

  const eventName =
    headerEvent ||
    metaEvent ||
    "";


  console.log(
    "Lemon webhook event:",
    eventName
  );


  /*
   * -----------------------------------------------------------
   * 7. Ignore events we don't need
   *
   * Return 200 so Lemon does not retry them.
   * -----------------------------------------------------------
   */

  if (
    eventName !== "order_created" &&
    eventName !== "license_key_created" &&
    eventName !== "order_refunded"
  ) {

    console.log(
      "Lemon webhook: ignoring event:",
      eventName
    );

    return jsonResponse(
      {
        received: true,
        ignored: true,
        event: eventName
      },
      200
    );
  }


  /*
   * -----------------------------------------------------------
   * 8. Extract data
   * -----------------------------------------------------------
   */

  const data =
    payload?.data;


  if (!data) {

    console.error(
      "Lemon webhook: missing data object."
    );

    return jsonResponse(
      {
        error:
          "Webhook payload is missing data."
      },
      400
    );
  }


  const attributes =
    data.attributes || {};


  /*
   * ===========================================================
   * ORDER REFUND
   * ===========================================================
   */

  if (
    eventName === "order_refunded"
  ) {

    return await handleOrderRefund(
      env.DB,
      data,
      attributes
    );
  }


  /*
   * ===========================================================
   * LICENSE KEY CREATED
   * ===========================================================
   *
   * This is the most important event for TagPulse.
   *
   * Lemon Squeezy sends the actual license key in:
   *
   * data.attributes.key
   *
   * The webhook stores only the SHA-256 hash.
   *
   * ===========================================================
   */

  if (
    eventName === "license_key_created"
  ) {

    return await handleLicenseCreated(
      env.DB,
      payload,
      data,
      attributes
    );
  }


  /*
   * ===========================================================
   * ORDER CREATED
   * ===========================================================
   *
   * We acknowledge the order.
   *
   * The actual license/credit provisioning is performed by
   * license_key_created because that event contains the actual
   * license key.
   *
   * ===========================================================
   */

  if (
    eventName === "order_created"
  ) {

    console.log(
      "Lemon webhook: order_created received.",
      data.id
    );

    return jsonResponse(
      {
        received: true,
        event: "order_created",
        order_id: String(data.id || "")
      },
      200
    );
  }


  return jsonResponse(
    {
      received: true
    },
    200
  );
}


/**
 * =============================================================
 * HANDLE LICENSE CREATED
 * =============================================================
 */
async function handleLicenseCreated(
  db,
  payload,
  data,
  attributes
) {

  /*
   * -----------------------------------------------------------
   * 1. Verify product
   * -----------------------------------------------------------
   */

  const productId =
    String(
      attributes.product_id || ""
    );

  const variantId =
    String(
      attributes.variant_id || ""
    );


  const tier =
    PRO_TIERS.find(
      (t) =>
        t.productId === productId &&
        t.variantId === variantId
    );


  if (
    !tier
  ) {

    console.error(
      "Lemon webhook: license belongs to another product.",
      {
        productId,
        variantId
      }
    );

    /*
     * Return 200 because the webhook itself was valid.
     * We simply don't provision TagPulse credits.
     */

    return jsonResponse(
      {
        received: true,
        provisioned: false,
        reason:
          "Product or variant does not belong to TagPulse AI."
      },
      200
    );
  }


  /*
   * -----------------------------------------------------------
   * 2. Get actual license key
   * -----------------------------------------------------------
   */

  const licenseKey =
    typeof attributes.key === "string"
      ? attributes.key.trim()
      : "";


  if (!licenseKey) {

    console.error(
      "Lemon webhook: license_key_created contained no license key."
    );

    return jsonResponse(
      {
        error:
          "License key was missing from webhook payload."
      },
      500
    );
  }


  /*
   * -----------------------------------------------------------
   * 3. Get custom browser user ID
   *
   * This comes from:
   *
   * checkout[custom][user_id]
   *
   * and is delivered by Lemon inside:
   *
   * payload.meta.custom_data.user_id
   *
   * -----------------------------------------------------------
   */

  const customData =
    payload?.meta?.custom_data || {};


  const userId =
    typeof customData.user_id === "string"
      ? customData.user_id.trim()
      : "";


  /*
   * -----------------------------------------------------------
   * 4. Hash license
   *
   * NEVER store the plaintext license key.
   * -----------------------------------------------------------
   */

  const licenseHash =
    await sha256(
      licenseKey
    );


  /*
   * -----------------------------------------------------------
   * 5. Check if this license already exists
   *
   * Webhooks can be retried, so this must be idempotent.
   * -----------------------------------------------------------
   */

  const existing =
    await db.prepare(
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


  /*
   * -----------------------------------------------------------
   * 6. Existing license
   * -----------------------------------------------------------
   */

  if (existing) {

    /*
     * If the license already exists, do NOT give another
     * 500 credits.
     */

    console.log(
      "Lemon webhook: license already provisioned.",
      existing.id
    );


    /*
     * If the first webhook did not contain user_id but a later
     * event does, attach it.
     */

    if (
      userId &&
      !existing.user_id
    ) {

      await db.prepare(
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


    return jsonResponse(
      {
        received: true,
        provisioned: false,
        already_exists: true,
        credits_remaining:
          Number(
            existing.credits_remaining
          )
      },
      200
    );
  }


  /*
   * -----------------------------------------------------------
   * 7. Insert new Pro license
   * -----------------------------------------------------------
   */

  try {

    await db.prepare(
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
         NULL
       )`
    )
      .bind(
        licenseHash,
        tier.credits,
        userId || null
      )
      .run();

  } catch (err) {

    /*
     * Another webhook request may have inserted the same
     * license milliseconds earlier.
     */

    console.error(
      "Lemon webhook: license insert failed.",
      err
    );


    const raceCheck =
      await db.prepare(
        `SELECT
           id,
           credits_remaining
         FROM licenses
         WHERE license_key_hash = ?1
         LIMIT 1`
      )
        .bind(
          licenseHash
        )
        .first();


    if (raceCheck) {

      return jsonResponse(
        {
          received: true,
          provisioned: false,
          already_exists: true,
          credits_remaining:
            Number(
              raceCheck.credits_remaining
            )
        },
        200
      );
    }


    return jsonResponse(
      {
        error:
          "License could not be saved."
      },
      500
    );
  }


  /*
   * -----------------------------------------------------------
   * 8. Success
   * -----------------------------------------------------------
   */

  console.log(
    "Lemon webhook: Pro license provisioned.",
    {
      userId:
        userId || null,
      tier:
        tier.name,
      credits:
        tier.credits
    }
  );


  return jsonResponse(
    {
      received: true,
      provisioned: true,
      credits_remaining:
        tier.credits
    },
    200
  );
}


/**
 * =============================================================
 * HANDLE ORDER REFUND
 * =============================================================
 *
 * For now we revoke the matching customer's active license
 * when we can identify it through the license-key relationship
 * only if Lemon includes sufficient license information.
 *
 * We deliberately do NOT guess which license belongs to an
 * order when the webhook payload does not contain the key.
 *
 * =============================================================
 */
async function handleOrderRefund(
  db,
  data,
  attributes
) {

  console.log(
    "Lemon webhook: order_refunded received.",
    data.id
  );


  /*
   * Lemon's order_refunded payload does not necessarily include
   * the plaintext license key.
   *
   * Therefore we acknowledge the refund here.
   *
   * The Pro status endpoint / license validation remains the
   * authoritative mechanism for future access checks.
   */

  return jsonResponse(
    {
      received: true,
      event: "order_refunded",
      order_id:
        String(
          data.id || ""
        ),
      note:
        "Refund received. License validity will be checked through Lemon Squeezy validation."
    },
    200
  );
}


/**
 * =============================================================
 * VERIFY LEMON SQUEEZY WEBHOOK SIGNATURE
 * =============================================================
 *
 * Lemon Squeezy signs the RAW request body using HMAC-SHA256.
 *
 * Header:
 *
 * X-Signature
 *
 * =============================================================
 */
async function verifyWebhookSignature(
  rawBody,
  receivedSignature,
  secret
) {

  try {

    /*
     * Convert secret to crypto key.
     */

    const encoder =
      new TextEncoder();


    const key =
      await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        {
          name: "HMAC",
          hash: "SHA-256"
        },
        false,
        [
          "sign"
        ]
      );


    /*
     * Generate HMAC.
     */

    const signatureBuffer =
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(
          rawBody
        )
      );


    /*
     * Convert generated signature to lowercase hex.
     */

    const generatedSignature =
      Array.from(
        new Uint8Array(
          signatureBuffer
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


    /*
     * Compare safely.
     */

    return timingSafeEqual(
      generatedSignature,
      receivedSignature.trim().toLowerCase()
    );

  } catch (err) {

    console.error(
      "Webhook signature verification failed:",
      err
    );

    return false;
  }
}


/**
 * =============================================================
 * TIMING-SAFE STRING COMPARISON
 * =============================================================
 */
function timingSafeEqual(
  a,
  b
) {

  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }


  if (
    a.length !== b.length
  ) {
    return false;
  }


  let result = 0;


  for (
    let i = 0;
    i < a.length;
    i++
  ) {

    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }


  return result === 0;
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
  status
) {

  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,
      headers: {
        "Content-Type":
          "application/json"
      }
    }
  );
}


/**
 * =============================================================
 * OPTIONS
 * =============================================================
 */
export async function onRequestOptions() {

  return new Response(
    null,
    {
      status: 204
    }
  );
}
