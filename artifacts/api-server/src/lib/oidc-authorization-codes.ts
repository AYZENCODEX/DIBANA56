/**
 * lib/oidc-authorization-codes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3b-d/3b-e/3b-g: authorization code
 * generation, persistence, and expiry policy.
 *
 * Scope discipline (this is 3b-d/3b-e/3b-g, not 3b-a/3b-b/3b-c/3b-f, and
 * NOT 3c):
 *   - No session detection, login redirect, or return-to state — that's
 *     3b-a/3b-b/3b-c (`routes/oidc-authorize.ts` +
 *     `lib/oidc-authorize-login-redirect.ts`).
 *   - No callback response-building (redirecting the user-agent back to
 *     the client with `?code=...&state=...`) — that's 3b-f, and lives in
 *     `routes/oidc-authorize.ts` since it's HTTP-response shaping, not
 *     code/data logic.
 *   - No code LOOKUP, no redemption, no single-use consumption, no access
 *     token issuance — those are Phase 3c-c..3c-f. `isAuthorizationCodeExpired()`
 *     below is exported specifically so Phase 3c's code lookup can call it
 *     rather than re-deriving the same comparison, but this file does not
 *     itself query `oidc_authorization_codes` by `code_hash` — writing
 *     that read path now would be building 3c-c ahead of 3c, which the
 *     roadmap's "no speculative implementation of future phases" rule
 *     (section 1.4) says not to do.
 *   - No "consumed"/"redeemed" tracking — deliberately not decided here;
 *     see migration 080's header for why that is Phase 3c-e's call, not
 *     this one's.
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * 3b-d: Code Generation.
 *
 * 32 random bytes (256 bits) of entropy, base64url-encoded — the identical
 * strength and format `lib/api-key-crypto.ts`'s `generateApiKey()` already
 * uses in this codebase for its other "unpredictable, opaque, shown-once"
 * bearer secret. RFC 6749 §10.10 only requires an authorization code be
 * "sufficiently random" (and, per §4.1.2, short-lived — see
 * `AUTHORIZATION_CODE_TTL_MS` below); reusing an existing, already-reviewed
 * entropy/format decision from this same codebase is preferable to
 * inventing a second one.
 */
export function generateAuthorizationCode(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * SHA-256 hex hash of a raw authorization code — identical pattern to
 * `hashApiKey()` (`api-key-crypto.ts`) and the same rationale as
 * `oidc_clients.client_secret_hash` / `api_keys.key_hash`: the raw code is
 * handed to the client exactly once, in the 3b-f callback redirect, and is
 * never itself persisted — only this one-way hash is, so a leak of
 * `oidc_authorization_codes` does not hand out live, redeemable codes.
 */
export function hashAuthorizationCode(rawCode: string): string {
  return crypto.createHash("sha256").update(rawCode, "utf8").digest("hex");
}

/**
 * 3b-g: Code Expiry — TTL policy.
 *
 * 60 seconds. RFC 6749 §4.1.2 caps authorization code lifetime at 10
 * minutes as an upper bound, but the roadmap's own global Authorization
 * Code security review (section 3.4) specifically asks for "short
 * lifetime" — 60s is the value most production OIDC providers (Google,
 * Okta, Auth0) actually converge on in practice: long enough to survive
 * the round trip through the client's own callback handler straight into
 * a token-exchange call, short enough that a code intercepted in transit
 * (e.g. a leaked `Referer` header, browser history, a proxy log) is very
 * unlikely to still be valid by the time anyone could replay it.
 */
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

/**
 * Pure: the `expires_at` value to persist for a code issued right now (or
 * at an injected `now`, for deterministic tests). No DB access.
 */
export function computeAuthorizationCodeExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS);
}

/**
 * 3b-g: pure expiry check — "reject expired authorization codes" as a
 * policy/predicate, not as a database operation. Exported now so Phase
 * 3c's (not-yet-built) code lookup can call this instead of re-deriving
 * the same `now >= expiresAt` comparison itself, the same "the check
 * exists before the route that enforces it" precedent every Phase 2
 * validation function already set for Phase 3a. This function never
 * touches the database and never deletes/marks a row — see the file
 * header for why "what happens to an expired row" is left to Phase 3c-e.
 */
export function isAuthorizationCodeExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/**
 * 3b-e: everything a persisted authorization code must be bound to, per
 * the roadmap's own list — client; redirect URI; user; scope; PKCE
 * challenge; nonce. (Expiry is computed separately, not part of the
 * caller-supplied binding — see `persistAuthorizationCode()` below.)
 */
export interface AuthorizationCodeBinding {
  clientId: string;
  redirectUri: string;
  userId: number;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  nonce: string | null;
}

/**
 * 3b-e: Code Persistence — the one INSERT this sub-phase adds.
 *
 * Stores `hashAuthorizationCode(rawCode)` (never `rawCode` itself) bound
 * to every field `AuthorizationCodeBinding` names, plus an `expires_at`
 * computed from `now` (3b-g). Returns `boolean` rather than the inserted
 * row: no caller in this phase needs anything back beyond "did this
 * durably persist" — the one thing a caller might otherwise want back
 * (the raw code) is already known to it, since it generated that value
 * itself before calling this function.
 *
 * A failed insert is logged and reported as `false` rather than thrown —
 * the caller (`routes/oidc-authorize.ts`) must not proceed to callback the
 * client with a `code` that was never durably stored (Phase 3c's token
 * endpoint would have nothing to redeem it against), so `false` here is a
 * signal to fail the whole authorization attempt, not something to retry
 * silently or ignore.
 */
export async function persistAuthorizationCode(
  rawCode: string,
  binding: AuthorizationCodeBinding,
  now: Date = new Date(),
): Promise<boolean> {
  const codeHash = hashAuthorizationCode(rawCode);
  const expiresAt = computeAuthorizationCodeExpiry(now);
  try {
    await pool.query(
      `INSERT INTO oidc_authorization_codes
         (code_hash, client_id, redirect_uri, user_id, scopes, code_challenge, code_challenge_method, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [
        codeHash,
        binding.clientId,
        binding.redirectUri,
        binding.userId,
        JSON.stringify(binding.scopes),
        binding.codeChallenge,
        binding.codeChallengeMethod,
        binding.nonce,
        expiresAt,
      ],
    );
    return true;
  } catch (err) {
    // Section 5's "do not log ... authorization codes" rule: neither
    // rawCode nor codeHash is logged here. codeHash is a one-way digest,
    // not a usable credential either way, but there is no reason to log
    // it — clientId/userId (already non-sensitive identifiers logged
    // elsewhere on this request) are enough to debug a persistence
    // failure from server logs alone.
    logger.warn(
      { err, clientId: binding.clientId, userId: binding.userId },
      "[oidc-authorization-codes] failed to persist authorization code",
    );
    return false;
  }
}
