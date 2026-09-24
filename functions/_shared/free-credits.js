/**
 * =============================================================
 * TagPulse AI — FREE CREDIT POLICY (single source of truth)
 * =============================================================
 *
 * The number of free generations a NEW free account starts with.
 *
 * Imported by:
 *   - functions/api/generate.js    (creates the free_users row with
 *                                   this balance on first use, and
 *                                   caps free-credit refunds at it)
 *   - functions/api/pro-status.js  (shows this balance to a free user
 *                                   whose free_users row does not
 *                                   exist yet)
 *
 * Change it HERE ONLY. It applies to accounts created after the
 * change: existing free_users rows keep whatever balance they have —
 * nothing in the code ever rewrites an existing balance (row creation
 * is INSERT OR IGNORE).
 *
 * This file exports no onRequest handler, so Cloudflare Pages does
 * not treat it as an API route.
 * =============================================================
 */
export const FREE_CREDITS = 3;
