/**
 * lib/oidc-authorization-code-consumption.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c-c/3c-d/3c-e: Code Lookup, Code Binding
 * Checks, Single-Use Consumption.
 *
 * This is the file `lib/oidc-authorization-codes.ts`'s own header pointed
 * at: "this file does not itself query `oidc_authorization_codes` by
 * `code_hash` — writing that read path now would be building 3c-c ahead of
 * 3c." 3c is now in scope, so this is that read path.
 *
 * Scope discipline (this is 3c-c/3c-d/3c-e, not 3c-a/3c-b/3c-f/3c-g/3d):
 *   - No token-request parsing (3c-a) or client authentication (3c-b) —
 *     `routes/oidc-token.ts` resolves both before ever calling into this
 *     file, same "route composes, lib validates" order every earlier phase
 *     used.
 *   - No access token issuance (3c-f) — this file's job ends at "here is
 *     the validated, now-consumed code's binding data", not at minting
 *     anything from it.
 *   - No PKCE verifier comparison (3d) — `codeChallenge`/`codeChallengeMethod`
 *     are returned as plain fields on the mapped row for `lib/oidc-pkce.ts`
 *     (Phase 3d) to check; this file only confirms the CLIENT/REDIRECT_URI/
 *     EXPIRY binding (section 3.4's other three "bound to" bullets), not the
 *     PKCE challenge bullet.
 *
 * 3c-e ATOMICITY, CONCRETELY
 * `consumeAuthorizationCode()` below is a single
 * `UPDATE ... WHERE consumed_at IS NULL RETURNING *` statement — the
 * read ("is this code still unused") and the write ("mark it used") happen
 * in the same round trip, under Postgres's own row lock, so two concurrent
 * redemption attempts for the identical code can never both observe
 * `consumed_at IS NULL` and both proceed. Exactly one wins; the other gets
 * zero rows back and is rejected as `invalid_grant`, same as a code that
 * never existed at all — see the function's own doc comment for why a
 * second, non-authoritative read exists purely to tell those two cases
 * apart for logging.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { toStringArray } from "./oidc-clients";
import { hashAuthorizationCode, isAuthorizationCodeExpired } from "./oidc-authorization-codes";

/** The full binding data 3b-e persisted for a code, now mapped out of Postgres's snake_case/JSONB row shape — same `map*Row()` precedent as `oidc-clients.ts`'s `mapOidcClientRow()`. */
export interface StoredAuthorizationCode {
  id: number;
  clientId: string;
  redirectUri: string;
  userId: number;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  expiresAt: Date;
  createdAt: Date;
  consumedAt: Date | null;
}

interface StoredAuthorizationCodeDbRow {
  id: number;
  client_id: string;
  redirect_uri: string;
  user_id: number;
  scopes: unknown;
  code_challenge: string;
  code_challenge_method: string;
  nonce: string | null;
  expires_at: Date;
  created_at: Date;
  consumed_at: Date | null;
}

function mapAuthorizationCodeRow(row: StoredAuthorizationCodeDbRow): StoredAuthorizationCode {
  return {
    id: row.id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    userId: row.user_id,
    scopes: toStringArray(row.scopes),
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    nonce: row.nonce,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

const RETURNING_COLUMNS = `id, client_id, redirect_uri, user_id, scopes, code_challenge, code_challenge_method, nonce, expires_at, created_at, consumed_at`;

/** 3c-e: why a code redemption failed — distinguished only for the `oidc.code.replay` vs. generic-failure observability split (section 5); both are reported to the client as the identical `invalid_grant` (see routes/oidc-token.ts). */
export type AuthorizationCodeConsumptionResult =
  | { ok: true; code: StoredAuthorizationCode }
  | { ok: false; reason: "not_found" | "already_used" };

/**
 * 3c-c + 3c-e composed: look up a raw authorization code by its hash AND
 * atomically claim it (single-use) in the same statement — see file header
 * for why these two are one operation, not two.
 *
 * Never receives or logs the raw code itself beyond hashing it in-memory
 * (section 5's "do not log ... authorization codes" rule, same discipline
 * `persistAuthorizationCode()` already followed for the write side).
 */
export async function consumeAuthorizationCode(
  rawCode: string,
  now: Date = new Date(),
): Promise<AuthorizationCodeConsumptionResult> {
  const codeHash = hashAuthorizationCode(rawCode);
  try {
    const claimed = await pool.query(
      `UPDATE oidc_authorization_codes
         SET consumed_at = $2
       WHERE code_hash = $1 AND consumed_at IS NULL
       RETURNING ${RETURNING_COLUMNS}`,
      [codeHash, now],
    );
    if (claimed.rows.length > 0) {
      return { ok: true, code: mapAuthorizationCodeRow(claimed.rows[0] as StoredAuthorizationCodeDbRow) };
    }

    // Zero rows: either no such code_hash ever existed, or it did and is
    // already consumed (a replay). This second, read-only query changes
    // NOTHING about the outcome above — it exists solely so the caller can
    // log `oidc.code.replay` (section 5) instead of a generic failure when
    // that's genuinely what happened. A transient DB error on THIS query
    // still safely reports "not_found" rather than throwing, since the
    // security decision (reject) was already made by the UPDATE above.
    const existing = await pool.query(
      `SELECT 1 FROM oidc_authorization_codes WHERE code_hash = $1 AND consumed_at IS NOT NULL LIMIT 1`,
      [codeHash],
    );
    return { ok: false, reason: existing.rows.length > 0 ? "already_used" : "not_found" };
  } catch (err) {
    logger.warn({ err }, "[oidc-authorization-code-consumption] failed to consume authorization code");
    return { ok: false, reason: "not_found" };
  }
}

/** 3c-d: which part of the client/redirect_uri/expiry binding failed — internal detail only, always reported publicly as `invalid_grant` (section 4's global error model has no more specific code for any of these three). */
export type AuthorizationCodeBindingCheckResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "client_mismatch" | "redirect_uri_mismatch" };

/**
 * 3c-d: Code Binding Checks — "verify client/redirect/code relationship".
 *
 * Pure, DB-free — takes an already-consumed `StoredAuthorizationCode` (from
 * `consumeAuthorizationCode()` above) and the token request's own
 * `client_id`/`redirect_uri` (already authenticated/parsed by 3c-b/3c-a),
 * same pure-function-on-top-of-a-resolved-row discipline as
 * `validateOidcRedirectUri()` (2C) and `checkOidcRequest`-style checks
 * throughout this roadmap.
 *
 * Deliberately runs AFTER consumption, not before: a code whose binding
 * turns out to be wrong (stolen and replayed against a different client,
 * for instance) must still be burned by that attempt — see 3.4's "single
 * use" requirement, which does not carve out an exception for "single use
 * only if every other check also happens to pass". A caller with a
 * mismatched binding gets the exact same `invalid_grant` either way; the
 * only difference consumption-order makes is that the code can never be
 * retried against the correct client afterward either.
 *
 * Expiry is checked first (3b-g's `isAuthorizationCodeExpired()`, reused
 * exactly as that function's own doc comment anticipated), then client,
 * then redirect_uri — the same order section 3.4 lists them in ("short
 * lifetime; single use; bound to client; bound to redirect URI; ...").
 */
export function checkAuthorizationCodeBinding(
  code: StoredAuthorizationCode,
  expected: { clientId: string; redirectUri: string },
  now: Date = new Date(),
): AuthorizationCodeBindingCheckResult {
  if (isAuthorizationCodeExpired(code.expiresAt, now)) {
    return { ok: false, reason: "expired" };
  }
  if (code.clientId !== expected.clientId) {
    return { ok: false, reason: "client_mismatch" };
  }
  if (code.redirectUri !== expected.redirectUri) {
    return { ok: false, reason: "redirect_uri_mismatch" };
  }
  return { ok: true };
}
