/**
 * lib/oidc-refresh-tokens.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3e-a (Refresh Token Model), 3e-b (Expiry
 * Policy), and the storage half of 3e-d (Refresh Storage Tests: persistence
 * and lookup).
 *
 * Scope discipline (this is 3e-a/3e-b/3e-d, not 3e-c and not "future
 * scope"):
 *   - No response shaping — `routes/oidc-token.ts` (3e-c) decides WHEN a
 *     refresh token is returned and under what response field name; this
 *     file only generates/persists/looks one up, same "lib generates and
 *     stores, route decides when to call it" split every earlier phase's
 *     pair (`oidc-authorization-codes.ts` / `oidc-authorize.ts`,
 *     `oidc-access-token.ts` / `oidc-token.ts`) already used.
 *   - No refresh GRANT handling (`grant_type=refresh_token` redeeming a
 *     refresh token for a new access token) — the roadmap's own 3e section
 *     note ("Full refresh-token rotation/introspection/revocation remains
 *     future scope") and `routes/oidc-token.ts`'s own header ("`grant_type`
 *     is checked against exactly `"authorization_code"`, nothing else is
 *     accepted yet") both already say that grant type doesn't exist yet.
 *     `lookupRefreshToken()` below exists for 3e-d's storage/lookup tests
 *     and for a future redemption sub-phase to build on, not because
 *     anything in 3e itself calls it to redeem a token.
 *   - No rotation-on-use, no revocation — see migration 082's header for
 *     why `revoked_at` exists on the table but nothing in this file writes
 *     to it.
 *
 * STORAGE PATTERN: same as `lib/oidc-authorization-codes.ts`
 * `generateRefreshToken()` / `hashRefreshToken()` / `persistRefreshToken()`
 * mirror that file's `generateAuthorizationCode()` /
 * `hashAuthorizationCode()` / `persistAuthorizationCode()` almost exactly —
 * 32 random bytes (256 bits), base64url-encoded, SHA-256 hex hash stored
 * (never the raw value), same rationale (`api-key-crypto.ts`'s
 * `generateApiKey()` precedent) both files already cite. Copied rather than
 * shared because the two secrets bind to structurally different tables
 * (`oidc_authorization_codes` vs. `oidc_refresh_tokens`) with different
 * lifetimes — not because the generation logic itself needed to differ.
 *
 * EXPIRY: 30 DAYS
 * Not specified by the roadmap's 3e-b task text itself (just "define
 * lifetime"), so this follows the same "what do real providers actually
 * converge on" reasoning `AUTHORIZATION_CODE_TTL_MS` (3b-g) and
 * `ACCESS_TOKEN_TTL_SECONDS` (3c-f) already used for their own TTLs:
 * Google/Okta/Auth0 refresh tokens commonly live on the order of weeks to a
 * couple of months for first-party clients before requiring re-consent;
 * 30 days is a conservative middle of that range, long enough that a
 * client legitimately used every few days never has to force a full
 * re-login, short enough to bound how long a leaked refresh token (this
 * codebase's longest-lived OIDC bearer secret) stays redeemable — and
 * rotation-on-use (which would let a provider safely go longer) is exactly
 * the "future scope" this sub-phase explicitly does not implement yet.
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { toStringArray } from "./oidc-clients";

/**
 * 3e-a: Refresh Token Model — generation.
 * Same entropy/format as `generateAuthorizationCode()` — see file header.
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * SHA-256 hex hash of a raw refresh token — identical pattern to
 * `hashAuthorizationCode()` / `hashClientSecret()`: the raw token is
 * handed to the client exactly once (in the 3e-c token response) and is
 * never itself persisted.
 */
export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** 3e-b: 30 days, in milliseconds — same `Date`-arithmetic-constant shape as `AUTHORIZATION_CODE_TTL_MS`, not `ACCESS_TOKEN_TTL_SECONDS`'s seconds (this file computes an `expires_at` `Date` directly, it never passes a TTL to `jsonwebtoken`). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Pure: the `expires_at` value to persist for a refresh token issued right now (or at an injected `now`, for deterministic tests). No DB access — same precedent as `computeAuthorizationCodeExpiry()`. */
export function computeRefreshTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
}

/** 3e-b: pure expiry check, same "policy/predicate, not a database operation" shape as `isAuthorizationCodeExpired()` — exported so a future redemption sub-phase can reuse it instead of re-deriving the comparison. */
export function isRefreshTokenExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** 3e-a: everything a persisted refresh token is bound to — client; user; scope. No redirect_uri/code_challenge/nonce (see file header: those were authorize-transaction-specific and have no equivalent here). */
export interface RefreshTokenBinding {
  clientId: string;
  userId: number;
  scopes: string[];
}

/**
 * 3e-a persisted: everything the storage/lookup half (3e-d) can read back
 * for a refresh token row — same `map*Row()` precedent as
 * `mapAuthorizationCodeRow()`.
 */
export interface StoredRefreshToken {
  id: number;
  clientId: string;
  userId: number;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

interface StoredRefreshTokenDbRow {
  id: number;
  client_id: string;
  user_id: number;
  scopes: unknown;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function mapRefreshTokenRow(row: StoredRefreshTokenDbRow): StoredRefreshToken {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    scopes: toStringArray(row.scopes),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

const RETURNING_COLUMNS = `id, client_id, user_id, scopes, expires_at, revoked_at, created_at`;

/**
 * 3e-a/3e-b: persist a refresh token — same signature/return shape and
 * same "false on failure, caller must not proceed" contract as
 * `persistAuthorizationCode()`. A caller (`routes/oidc-token.ts`, 3e-c)
 * that gets `false` back must not include a `refresh_token` field in the
 * response it sends the client, for the identical reason: a token that
 * was never durably stored has nothing for a future redemption path to
 * ever find.
 */
export async function persistRefreshToken(
  rawToken: string,
  binding: RefreshTokenBinding,
  now: Date = new Date(),
): Promise<boolean> {
  const tokenHash = hashRefreshToken(rawToken);
  const expiresAt = computeRefreshTokenExpiry(now);
  try {
    await pool.query(
      `INSERT INTO oidc_refresh_tokens (token_hash, client_id, user_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [tokenHash, binding.clientId, binding.userId, JSON.stringify(binding.scopes), expiresAt],
    );
    return true;
  } catch (err) {
    // Section 5's "do not log ... access tokens" rule extends here: neither
    // rawToken nor tokenHash is logged, same discipline
    // `persistAuthorizationCode()` already follows for its own secret.
    logger.warn(
      { err, clientId: binding.clientId, userId: binding.userId },
      "[oidc-refresh-tokens] failed to persist refresh token",
    );
    return false;
  }
}

/**
 * 3e-d: Refresh Storage Tests' "lookup" half — a read-only, non-consuming
 * lookup by hash. Deliberately NOT the atomic claim-and-consume pattern
 * `consumeAuthorizationCode()` uses (3c-e): a refresh token is not
 * single-use by this sub-phase's own design (see file header), so there is
 * nothing to atomically claim yet — reading it back is enough to prove
 * 3e-a's persistence actually round-trips. A future redemption sub-phase
 * building the refresh grant can call this (or something like it) as its
 * own first step; this function does not itself decide expiry/revocation,
 * same "return the row, let the caller apply policy" split
 * `checkAuthorizationCodeBinding()` uses on top of `consumeAuthorizationCode()`.
 */
export async function lookupRefreshToken(rawToken: string): Promise<StoredRefreshToken | null> {
  const tokenHash = hashRefreshToken(rawToken);
  try {
    const result = await pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM oidc_refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    if (result.rows.length === 0) return null;
    return mapRefreshTokenRow(result.rows[0] as StoredRefreshTokenDbRow);
  } catch (err) {
    logger.warn({ err }, "[oidc-refresh-tokens] failed to look up refresh token");
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 5, Phase 10b: Revocation Endpoint (RFC 7009-scoped-down) —
 * refresh-token half.
 *
 * `revokeRefreshTokenByHash()` below is the write `lib/oidc-token-revocation.ts`'s
 * own header already named as this Season's job for this file — "just
 * needed to finally WRITE the `revoked_at` column that table has carried,
 * unused, since migration 082." Same naming/shape precedent as
 * `lookupRefreshToken()` above: takes the RAW token (never a caller-supplied
 * hash), hashes it internally, and is the one function in this file that
 * ever writes `revoked_at`.
 *
 * Idempotent by construction — `AND revoked_at IS NULL` in the WHERE clause
 * means revoking an already-revoked (or nonexistent) token affects zero
 * rows, not a distinguishable error. In practice `revokeOidcToken()`
 * (`lib/oidc-token-revocation.ts`) never even reaches this function for an
 * already-revoked row — its own `revokeAsRefreshToken()` short-circuits on
 * `stored.revokedAt !== null` first — but the guard is kept here anyway so
 * a second, more direct caller can't race past it into a clobbered
 * `revoked_at` timestamp.
 */
export async function revokeRefreshTokenByHash(rawToken: string): Promise<boolean> {
  const tokenHash = hashRefreshToken(rawToken);
  try {
    const result = await pool.query(
      `UPDATE oidc_refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err }, "[oidc-refresh-tokens] failed to revoke refresh token by hash");
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 5, Phase 10c: Cascade Revocation by Client.
 *
 * `revokeRefreshTokensForClient()` is the ONE bulk write both of
 * `lib/oidc-token-revocation.ts`'s own cascade wrappers
 * (`revokeAllTokensForClientAndUser()` / `revokeAllTokensForClient()`)
 * compose — see that file's own header for why a cascade is, in practice,
 * refresh-token-only (an access token is a stateless JWT with no ledger to
 * walk; only a REFRESH token's future redemption can be cut off in bulk).
 *
 * `userId` is optional: omitted, this revokes every still-live refresh
 * token for `clientId` across every user (9d's admin-suspend / 9c's
 * admin-delete shape, both per-client/all-users); supplied, it narrows to
 * one user's own tokens for that client (7d's consent-revoke shape,
 * per-user/per-client). Same `client_id [AND user_id] AND revoked_at IS
 * NULL` WHERE shape migration 095's own partial index
 * (`oidc_refresh_tokens_client_id_user_id_idx`) was added specifically to
 * cover — see that migration's own header for why `client_id` leads the
 * column order (it serves both callers' shape; a `user_id`-leading index
 * would only serve the narrower one).
 *
 * Returns the number of rows actually transitioned from active to revoked
 * (`rowCount`), never throws — a bulk cascade that revokes zero rows
 * (nothing was active to begin with, e.g. a client nobody has ever
 * authorized) is a normal, successful outcome, not a distinguishable
 * error, same "0 is a valid, non-error answer" posture
 * `deleteOidcClientAdmin()`'s own idempotent postures already take
 * elsewhere in this roadmap.
 */
export async function revokeRefreshTokensForClient(clientId: string, userId?: number): Promise<number> {
  try {
    const result =
      userId === undefined
        ? await pool.query(
            `UPDATE oidc_refresh_tokens SET revoked_at = NOW() WHERE client_id = $1 AND revoked_at IS NULL`,
            [clientId],
          )
        : await pool.query(
            `UPDATE oidc_refresh_tokens SET revoked_at = NOW() WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [clientId, userId],
          );
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn(
      { err, clientId, userId },
      "[oidc-refresh-tokens] failed to cascade-revoke refresh tokens for client",
    );
    return 0;
  }
}

/**
 * UPDATE — Season 5, Phase 10d: Cascade Call-Site Wiring.
 *
 * Read-only support for 10d's two CLIENT-WIDE cascade call sites
 * (`routes/admin-oidc-clients.ts`'s suspend and delete handlers), which
 * need to know WHICH users are affected by a client-wide cascade BEFORE
 * calling `revokeRefreshTokensForClient(clientId)` above, so a per-user
 * backchannel logout event
 * (`dispatchBackchannelLogoutForUserAndClient()`, `lib/oidc-logout-propagation.ts`)
 * can be dispatched to every affected session — not just have their
 * refresh tokens silently stop working with no signal sent anywhere.
 * Deliberately a SEPARATE read rather than an `UPDATE ... RETURNING
 * user_id` folded into the cascade write itself: the affected-user list is
 * a concern only these two client-wide call sites have (7d's own
 * per-user cascade already knows its one `userId` going in, it has no use
 * for this).
 *
 * A small window exists between this read and the cascade write actually
 * running (a refresh token could be minted or revoked in between) — the
 * same "lost a race" tolerance this admin surface already accepts
 * elsewhere (`deleteOidcClientAdmin()`'s own comment) for a client-wide
 * admin action that isn't expected to run concurrently with normal client
 * traffic at meaningful volume.
 */
export async function listActiveUserIdsForClient(clientId: string): Promise<number[]> {
  try {
    const result = await pool.query(
      `SELECT DISTINCT user_id FROM oidc_refresh_tokens WHERE client_id = $1 AND revoked_at IS NULL`,
      [clientId],
    );
    return (result.rows as { user_id: number }[]).map((row) => row.user_id);
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-refresh-tokens] failed to list active users for client");
    return [];
  }
}
