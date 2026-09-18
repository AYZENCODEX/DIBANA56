/**
 * lib/oidc-token-revocation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 10b: Revocation Endpoint (RFC
 * 7009-scoped-down) and Phase 10c: Cascade Revocation by Client.
 *
 * "Given a token string an authenticated client wants dead, make it dead —
 * immediately, not just at its own natural expiry" — this file's only
 * job. Same "lib composes existing primitives, route/caller decides when
 * to call it" split `lib/oidc-token-introspection.ts` (10a) already set
 * for this provider's other single-token classifier; this is that same
 * shape, for the MUTATING half 10a's own header explicitly reserved for
 * "10b, a separate pass."
 *
 * TWO KINDS OF BEARER SECRET, TWO COMPLETELY DIFFERENT REVOCATION STORIES
 *   - A REFRESH TOKEN (`lib/oidc-refresh-tokens.ts`) is already a DB row
 *     from the moment it's minted (`persistRefreshToken()`, 3e-a) — 10b
 *     just needed to finally WRITE the `revoked_at` column that table has
 *     carried, unused, since migration 082. `revokeRefreshTokenByHash()`
 *     (this Season's UPDATE to that file) is that write.
 *   - An ACCESS TOKEN (`lib/oidc-access-token.ts`) is a stateless RS256
 *     JWT — NOTHING about it is persisted at issuance (`issueOidcAccessToken()`
 *     signs and returns, full stop). `verifyOidcAccessToken()` (4c-a)
 *     proves validity purely from the JWT's own bytes; there is no row to
 *     flip a flag on. The only way to kill an otherwise-still-valid
 *     access token before its own (short, 60-minute) `exp` is a DENYLIST:
 *     record this specific token's hash as revoked (migration 094, THIS
 *     pass's own new table), and have every live verification path
 *     consult it. `persistRevokedAccessToken()`/`isAccessTokenRevoked()`
 *     below are that denylist's write/read halves.
 *
 * `verifyOidcAccessToken()` ITSELF IS UNCHANGED — DELIBERATELY
 * The obvious-looking design would fold the denylist check INTO
 * `verifyOidcAccessToken()` (4c-a), so every caller gets revocation
 * checking "for free." This file does NOT do that, for the same reason
 * 4c-a's own header already draws a line between verification and
 * user-lookup ("whether that id maps to a real, non-banned user row is
 * 4c-f's job, not this file's"): 4c-a is a PURE, DB-free cryptographic
 * check (its own test file, `test-oidc-userinfo.ts`, runs it for real
 * with zero DB access) — folding an async DB read into it would turn
 * every one of its callers into a DB-dependent call whether or not that
 * caller actually cares about revocation, and would mean 4c-a can no
 * longer be tested (or reasoned about) without a live database. Instead,
 * revocation-checking is this file's OWN separate, explicitly-composed
 * step: a caller that wants "verified AND not revoked" calls
 * `verifyOidcAccessToken()` first (unchanged), then separately hashes the
 * raw token and awaits `isAccessTokenRevoked()` — exactly the same
 * "pure predicate, separate effectful I/O" split
 * `isRefreshTokenExpired()` (pure) vs. `lookupRefreshToken()` (DB) already
 * draws for the refresh-token side of this same provider.
 * `routes/oidc-userinfo.ts`, `lib/oidc-scope-enforcement.ts`, and
 * `lib/oidc-token-introspection.ts`'s own access-token branch are this
 * Season's three real callers that now compose both steps — see each
 * file's own UPDATE note for the specific wiring.
 *
 * `hashOidcAccessToken()` — A NEW HASH HELPER, NOT `hashRefreshToken()`
 * REUSED. Same "one small helper per file, scoped to the one secret that
 * file owns" precedent `hashRefreshToken()`/`hashAuthorizationCode()`/
 * `hashClientSecret()` already each independently established — this file
 * owns the access-token denylist, so it gets its own copy rather than an
 * import of a differently-scoped file's private concern.
 *
 * RFC 7009 §2.1/§2.2, SCOPED DOWN — WHY THIS ENDPOINT NEVER "FAILS" ON A
 * BAD TOKEN. Once client authentication passes, `POST /oidc/revoke` ALWAYS
 * responds `200` with an empty body (`routes/oidc-revoke.ts`) — RFC 7009
 * §2.2's own words: "the authorization server responds with HTTP status
 * code 200 if the token has been revoked successfully OR IF THE CLIENT
 * SUBMITTED AN INVALID TOKEN... invalid tokens do not cause an error
 * response since the client cannot handle such an error in a reasonable
 * way [and] the purpose of the revocation request... is already
 * achieved." `revokeOidcToken()` below returns an `OidcRevocationOutcome`
 * ({ revoked, tokenType? }) purely for THIS codebase's own logging/testing —
 * `routes/oidc-revoke.ts` never puts any part of it on the wire.
 *
 * WHY A TOKEN'S OWN `client_id` MUST MATCH THE REVOKING CLIENT — same
 * "no cross-client oracle" principle `lib/oidc-token-introspection.ts`'s
 * own header already establishes for introspect, applied here to a
 * MUTATING endpoint instead of a read-only one: RFC 7009 §2.1 itself
 * says a server "MUST verify... the token was issued to the client
 * making the revocation request." This file's answer to "what happens on
 * mismatch" is the same non-distinguishing one 10a already chose:
 * `{ revoked: false }`, identical to a token this provider has never
 * heard of — never a distinguishable error, and never an actual write,
 * so client A can neither learn that client B's token exists NOR revoke
 * it out from under B by guessing/observing the raw value.
 *
 * Scope discipline (this is 10b/10c, not 10d/10e):
 *   - No backchannel logout dispatch. `revokeOidcToken()` and the two
 *     cascade functions below only ever invalidate a TOKEN — they never
 *     call `dispatchBackchannelLogoutForUser()` (Phase 6e) or anything
 *     like it. That hook is Phase 10d's own, separate, single addition,
 *     wiring these same functions' RESULT into the existing backchannel
 *     infrastructure — not something either of them triggers themselves.
 *   - No caller wiring into `lib/oidc-user-consents.ts`'s `revokeConsent()`
 *     (7d) or `lib/oidc-client-admin.ts`'s suspend/delete paths (9c/9d).
 *     Both of those files' own headers already name the exact function
 *     this pass builds (`revokeAllTokensForClient()`) as "not yet built" —
 *     this pass builds it, real, for the first time, but does not itself
 *     go add the call site at either of those two documented locations.
 *     That composition is left for whichever pass actually wires 10d's
 *     backchannel-logout hook alongside it, so both real effects
 *     (token-kill + session-kill) land in one reviewable change, not two
 *     separate passes each partially wiring the same suspend/revoke flow.
 *   - No discovery-metadata change (10e) — `/.well-known/openid-configuration`
 *     advertising `revocation_endpoint` is that sub-phase's own, separate,
 *     single-line addition, exactly as 10a's own header already said for
 *     `introspection_endpoint`.
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { verifyOidcAccessToken } from "./oidc-access-token-verification";
import {
  lookupRefreshToken,
  revokeRefreshTokenByHash,
  revokeRefreshTokensForClient,
} from "./oidc-refresh-tokens";

/**
 * SHA-256 hex hash of a raw OIDC access token JWT — see file header for
 * why this is its own helper, not `hashRefreshToken()` reused. The exact
 * same algorithm (SHA-256, hex digest of the raw UTF-8 secret) every
 * other bearer-secret hash function in this roadmap already uses — only
 * the ARTIFACT being hashed differs.
 */
export function hashOidcAccessToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * 10b: write `tokenHash` into the access-token denylist (migration 094).
 * `ON CONFLICT (token_hash) DO NOTHING` — revoking the same access token
 * twice (e.g. a client that calls `/oidc/revoke` twice, or a cascade
 * revoke racing a single-token revoke) is a no-op on the second call, not
 * a constraint-violation error, same idempotent-revoke posture this
 * Season's refresh-token side already takes via its own `AND revoked_at
 * IS NULL` guard. Returns `false` only on a genuine DB error — same
 * true/false-on-error convention `persistRefreshToken()` already uses.
 */
export async function persistRevokedAccessToken(
  tokenHash: string,
  expiresAt: Date,
  clientId: string,
  userId: number,
): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO oidc_revoked_access_tokens (token_hash, client_id, user_id, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, clientId, userId, expiresAt],
    );
    return true;
  } catch (err) {
    logger.warn({ err, clientId, userId }, "[oidc-token-revocation] failed to persist revoked access token");
    return false;
  }
}

/**
 * 10b: has the access token whose hash is `tokenHash` been revoked?
 *
 * FAIL-CLOSED ON A DB ERROR — the one deliberate exception to this
 * codebase's usual "log and return the harmless/negative value" posture
 * (`getOidcClientById()`, `lookupRefreshToken()`, etc. all return `null`
 * on a DB error, letting the caller treat "doesn't exist" and "couldn't
 * check" identically). This function returns `true` (treat as revoked)
 * on a DB error instead, because the two failure directions are NOT
 * symmetric here: a false NEGATIVE (a live-revoked token wrongly reported
 * "still good" because the denylist couldn't be reached) silently
 * defeats the entire point of this endpoint existing, while a false
 * POSITIVE (a transient DB hiccup makes a handful of still-valid, short
 * (60-minute) -lived access tokens fail verification until it clears) is
 * a availability blip a client already has a working recovery path for
 * (its refresh token, unaffected by this check, mints a new one). Given
 * that asymmetry, this is the one place in this roadmap's OIDC family
 * where "unknown" is deliberately collapsed to the SAFER of the two
 * answers rather than the more available one.
 */
export async function isAccessTokenRevoked(tokenHash: string): Promise<boolean> {
  try {
    const result = await pool.query(`SELECT 1 FROM oidc_revoked_access_tokens WHERE token_hash = $1`, [tokenHash]);
    return result.rows.length > 0;
  } catch (err) {
    logger.warn({ err }, "[oidc-token-revocation] revocation check failed, treating token as revoked (fail-closed, see file header)");
    return true;
  }
}

/** 10b: `revokeOidcToken()`'s own internal-only result — never sent on the wire, see file header's RFC 7009 §2.2 note. `tokenType` is present only when a real match was found, purely for logging (`routes/oidc-revoke.ts`). */
export interface OidcRevocationOutcome {
  revoked: boolean;
  tokenType?: "access_token" | "refresh_token";
}

const NOT_REVOKED: OidcRevocationOutcome = { revoked: false };

/**
 * Attempt to revoke `token` as an access token belonging to
 * `requestingClientId`. Same `null` ("try the other kind next") vs. a
 * definite `OidcRevocationOutcome` (`{ revoked: false }` for a
 * wrong-audience token, same no-oracle reasoning as 10a's introspect) two-
 * value split `lib/oidc-token-introspection.ts`'s own
 * `introspectAsAccessToken()`/`introspectAsRefreshToken()` pair already
 * establishes for the read-only case — mirrored here for the mutating one.
 *
 * An ALREADY-EXPIRED access token (`verifyOidcAccessToken()` -> `ok:
 * false, reason: "expired"`) returns `null`, same as a token that fails
 * verification for any other reason — there is nothing useful to add to
 * the denylist for a token that will fail `verifyOidcAccessToken()`'s own
 * expiry check regardless (see migration 094's header: a denylist row is
 * provably dead weight once real time passes its own `expires_at`, and an
 * already-expired token's `exp` is, by definition, already in the past).
 * RFC 7009's own "revoking an invalid token is still a successful no-op"
 * posture (file header) covers this exact case at the `revokeOidcToken()`
 * level below, once both branches return `null`.
 */
async function revokeAsAccessToken(token: string, requestingClientId: string): Promise<OidcRevocationOutcome | null> {
  const verified = verifyOidcAccessToken(token);
  if (!verified.ok) return null;

  if (verified.token.clientId !== requestingClientId) {
    logger.warn(
      { requestingClientId, tokenClientId: verified.token.clientId },
      "[oidc-token-revocation] access token revoke requested by a client other than its own audience, ignoring (no oracle)",
    );
    return NOT_REVOKED;
  }

  const tokenHash = hashOidcAccessToken(token);
  const expiresAt = new Date(verified.token.exp * 1000);
  const persisted = await persistRevokedAccessToken(tokenHash, expiresAt, verified.token.clientId, verified.token.userId);
  return { revoked: persisted, tokenType: "access_token" };
}

/**
 * Attempt to revoke `token` as a refresh token belonging to
 * `requestingClientId`. Same `null`/definite-outcome split as
 * `revokeAsAccessToken()` above. An already-revoked stored refresh token
 * short-circuits to `{ revoked: true, ... }` without a second `UPDATE` —
 * idempotent-success, not a redundant write, same posture
 * `revokeRefreshTokenByHash()`'s own `AND revoked_at IS NULL` guard
 * already takes at the SQL level (this early return just avoids the
 * round-trip entirely when `lookupRefreshToken()` already told us the
 * answer).
 */
async function revokeAsRefreshToken(token: string, requestingClientId: string): Promise<OidcRevocationOutcome | null> {
  const stored = await lookupRefreshToken(token);
  if (!stored) return null;

  if (stored.clientId !== requestingClientId) {
    logger.warn(
      { requestingClientId, tokenClientId: stored.clientId },
      "[oidc-token-revocation] refresh token revoke requested by a client other than its own owner, ignoring (no oracle)",
    );
    return NOT_REVOKED;
  }

  if (stored.revokedAt !== null) {
    return { revoked: true, tokenType: "refresh_token" };
  }

  const ok = await revokeRefreshTokenByHash(token);
  return { revoked: ok, tokenType: "refresh_token" };
}

/**
 * 10b: `POST /oidc/revoke`'s whole answer, everything after client auth —
 * same `tokenTypeHint`-as-ordering-preference-only contract as 10a's
 * `introspectOidcToken()` (RFC 7009 §2.1 has the identical "MAY ignore
 * this parameter" language RFC 7662 §2.1 does), same two-branch try-order
 * shape. `requestingClientId` is the already-authenticated caller's
 * `client_id` (`authenticateOidcTokenClient()`'s own output, reused as-is
 * by `routes/oidc-revoke.ts`) — this function does no client
 * authentication of its own.
 *
 * A token that matches NEITHER branch (never issued by this provider,
 * already-expired access token, garbage string, ...) falls all the way
 * through to `NOT_REVOKED` — RFC 7009 §2.2's own "invalid tokens do not
 * cause an error response... the purpose... is already achieved" is
 * exactly this case, handled at `routes/oidc-revoke.ts`'s response layer
 * (still `200`, empty body) rather than here.
 */
export async function revokeOidcToken(
  token: string,
  tokenTypeHint: string | undefined,
  requestingClientId: string,
): Promise<OidcRevocationOutcome> {
  const tryRefreshFirst = tokenTypeHint === "refresh_token";

  const first = tryRefreshFirst
    ? await revokeAsRefreshToken(token, requestingClientId)
    : await revokeAsAccessToken(token, requestingClientId);
  if (first !== null) return first;

  const second = tryRefreshFirst
    ? await revokeAsAccessToken(token, requestingClientId)
    : await revokeAsRefreshToken(token, requestingClientId);
  if (second !== null) return second;

  logger.info({ requestingClientId }, "[oidc-token-revocation] token matched neither access nor refresh storage — RFC 7009 treats this as a successful no-op");
  return NOT_REVOKED;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Phase 10c — Cascade Revocation by Client
 *
 * Both functions below are thin, NAMED wrappers over
 * `revokeRefreshTokensForClient()` (`lib/oidc-refresh-tokens.ts`'s own
 * Season 5 UPDATE) — the exact two function names `lib/oidc-user-consents.ts`
 * (7d) and `lib/oidc-client-admin.ts` (9c/9d) already cite, by name, as
 * "not yet built" in their own headers. Building them here, real, is all
 * 10c does — see this file's own header for why wiring either of those
 * two documented call sites is deliberately left to a later pass (10d),
 * not done in this one.
 *
 * WHY THESE ARE REFRESH-TOKEN-ONLY, IN PRACTICE, AND WHY THAT'S ENOUGH:
 * There is no ledger of every access token this provider has ever issued
 * (see this file's own header — an access token is a stateless JWT,
 * nothing is persisted at issuance) for a cascade to walk and denylist
 * one-by-one; `persistRevokedAccessToken()` above can only ever act on a
 * SPECIFIC token string a caller hands it (10b's own single-token case).
 * What a cascade CAN, and does, guarantee: every refresh token this
 * user/client (or every user of this client) currently holds stops being
 * redeemable for a NEW access token, immediately. Any access token
 * already in hand at the moment of cascade keeps verifying — but only for
 * up to `ACCESS_TOKEN_TTL_SECONDS` (60 minutes, `lib/oidc-access-token.ts`)
 * longer, a bounded, already-documented, already-short window, not an
 * indefinite one — after which it fails `verifyOidcAccessToken()`'s own
 * expiry check regardless of anything this file does. This is the same
 * "revoke stops future renewal; already-issued short-lived tokens run out
 * their own natural clock" model most real OAuth providers use for bulk/
 * cascade revocation, and is a documented, deliberate scope boundary here
 * (not an oversight the way 9d's own pre-Phase-10 gap was) — closing that
 * last 60-minute window in real time (rather than at each access token's
 * own natural expiry) is exactly what Phase 10d's backchannel-logout hook
 * (dispatching a same-session logout to the CLIENT, not a token-level
 * fix) is for.
 */

/** 10c: revoke every still-live refresh token `userId` holds for `clientId` — the per-user-per-client shape 7d's own consent-revoke needs. Returns the number of refresh tokens revoked. */
export async function revokeAllTokensForClientAndUser(userId: number, clientId: string): Promise<number> {
  return revokeRefreshTokensForClient(clientId, userId);
}

/** 10c: revoke every still-live refresh token any user holds for `clientId` — the per-client, all-users shape 9d's own admin-suspend (and 9c's own admin-delete) needs. Returns the number of refresh tokens revoked. */
export async function revokeAllTokensForClient(clientId: string): Promise<number> {
  return revokeRefreshTokensForClient(clientId);
}
