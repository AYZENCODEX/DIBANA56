/**
 * lib/oidc-user-consents.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7a: Consent Data Model (data-access half).
 *
 * Read/write layer over `oidc_user_consents` (migration 088), same raw
 * `pool.query()` + row-mapper shape `lib/oidc-refresh-tokens.ts` and
 * `lib/oidc-authorization-codes.ts` already use for the other short-lived,
 * per-request OIDC tables in this codebase — not a Drizzle schema (see
 * migration 088's own header: no FK into `oidc_clients`, same reasoning
 * those two files' tables already establish for why this family of table
 * doesn't get a `@workspace/db` schema mirror the way `oidc_clients` does).
 *
 * Scope discipline (this is 7a, not 7b/7c/7d/7e):
 *   - `getActiveConsent()` — a read, needed by 7b/7c to decide "does a
 *     valid consent already exist for this user/client." No caller in
 *     THIS pass invokes it from a route yet (7c is what will); it exists
 *     now because a "data model" phase that ships a table with no read
 *     path is not a usable deliverable — the same reasoning
 *     `lib/oidc-refresh-tokens.ts`'s `lookupRefreshToken()` gives for
 *     existing ahead of the redemption phase that will actually call it.
 *   - `grantConsent()` — the one write path this table's own unique-
 *     constraint design requires (7a's own text: "নতুন/বড় scope চাইলে এটা
 *     UPDATE হয়, নতুন row না") — an `INSERT ... ON CONFLICT (user_id,
 *     client_id) DO UPDATE`, same natural-key-upsert idiom
 *     `scripts/src/seed-oidc-clients.ts` already uses. This is the
 *     function `routes/oidc-consent.ts`'s Allow handler (7b) calls; it
 *     does NOT itself decide when the caller is allowed to call it (no
 *     session check, no client/scope validation) — that composition is
 *     the route's job, same "lib persists, route decides when" split
 *     `persistAuthorizationCode()`/`persistRefreshToken()` already use.
 *   - No scope-superset comparison (`hasScopeSuperset()` or similar) —
 *     7e's own text calls this out by name as its job, deliberately as a
 *     pure, DB-free function written against this file's data shape, not
 *     folded into the data-access layer itself. Nothing here is that
 *     function or a stand-in for it.
 *   - No "list all of a user's active consents" — that's 7d's own read
 *     (the Connected Apps section), a different query shape (all clients
 *     for one user, not one user/client pair) that 7d gets to add when
 *     it exists to actually render something with it. Building it now
 *     would be speculative implementation of a future phase's read path
 *     (roadmap's own "no speculative implementation of future phases"
 *     rule, cited throughout this codebase's earlier OIDC lib files).
 *   - No revoke — 7d's own job ("consent row soft-revoke (`revoked_at`
 *     সেট) + token revocation endpoint কল + backchannel logout"). This
 *     file does not set `revoked_at` anywhere.
 *
 * SAFETY NOTE: `grantConsent()` deliberately clears `revoked_at` back to
 * NULL on every upsert (whether this is a first-time grant or a 7e
 * re-prompt widening an existing row) — a client the user had previously
 * revoked, then chooses to re-authorize from a fresh `/oidc/authorize`
 * round-trip, is an active consent again, not still-revoked-but-updated.
 * There is no code path in THIS phase that reaches `grantConsent()` for
 * an already-revoked row without the user having just clicked "Allow" on
 * a real consent screen, so this is not a silent un-revoke — it is the
 * direct result of the same action Phase 7d's revoke button undoes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 7d: Consent Revocation (data-access half).
 *
 * Added below, appended after 7a's own content (left otherwise unchanged —
 * every function above this note is exactly what 7a shipped):
 *   - `listActiveConsentsForUser()` — the "list this user's active
 *     consents" read 7a's own header named and deliberately did not build
 *     yet ("Building it now would be speculative implementation of a
 *     future phase's read path"). This is that future phase; `routes/
 *     oidc-connected-apps.ts`'s `GET /oidc/connected-apps` is its one
 *     caller, backing the Security page's Connected Apps section.
 *   - `revokeConsent()` — the write 7a's own header reserved for 7d ("7d's
 *     own job... This file does not set `revoked_at` anywhere" — until
 *     now). A soft-revoke (`revoked_at = NOW()`), never a DELETE — see
 *     migration 088's own header for why this table keeps a row on revoke
 *     rather than removing it (audit trail).
 *
 * Still NOT this file's scope after 7d:
 *   - No token invalidation, no backchannel logout dispatch — those are
 *     separate concerns 7d's own route (`routes/oidc-connected-apps.ts`)
 *     documents in full, including why token invalidation itself is a
 *     documented Phase 10 dependency, not something either this file or
 *     that route builds yet. `lib/oidc-logout-propagation.ts`'s
 *     `dispatchBackchannelLogoutForUserAndClient()` is the one real effect
 *     7d composes alongside this file's own `revokeConsent()` — same "lib
 *     persists one thing, route composes several" split this file's own
 *     header already documents for `grantConsent()`.
 *   - No scope-superset comparison — still 7e's own job, untouched here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 7e: Consent Re-Prompt Policy.
 *
 * This file gained NO new functions for 7e — 7e's own text is explicit
 * that the granted-vs-requested scope comparison is "pure function হিসেবে
 * লেখা (7a-এর ডেটার উপর)," i.e. a pure function written AGAINST this
 * file's data shape, not added TO this file. That function
 * (`evaluateScopeCreep()`) lives in its own file,
 * `lib/oidc-consent-scope-superset.ts`, and takes plain `string[]`
 * in/out — it does not import `StoredOidcUserConsent` or anything else
 * from here, so this file has nothing to change to support it. Both of
 * 7e's real call sites (`routes/oidc-authorize.ts`'s consent gate,
 * `routes/oidc-consent.ts`'s `GET /oidc/consent/info`) already had a
 * `getActiveConsent()` call in place from 7c/7b respectively; 7e widens
 * what each of them DOES with that same result, not what this file
 * returns.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { toStringArray } from "./oidc-clients";

/** 7a: everything a stored consent row carries. */
export interface StoredOidcUserConsent {
  id: number;
  userId: number;
  clientId: string;
  grantedScopes: string[];
  grantedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

interface StoredOidcUserConsentDbRow {
  id: number;
  user_id: number;
  client_id: string;
  granted_scopes: unknown;
  granted_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function mapConsentRow(row: StoredOidcUserConsentDbRow): StoredOidcUserConsent {
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    grantedScopes: toStringArray(row.granted_scopes),
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

const RETURNING_COLUMNS = `id, user_id, client_id, granted_scopes, granted_at, revoked_at, created_at`;

/**
 * 7a read path: the current ACTIVE consent (`revoked_at IS NULL`) for one
 * (user, client) pair, or `null` when there isn't one — either because the
 * user has never consented to this client, or because a prior consent was
 * revoked (7d) and never re-granted. Both "never asked" and "asked and
 * revoked" collapse to the identical `null` result here on purpose: every
 * caller this phase anticipates (7b's screen deciding whether to show
 * itself, 7c's authorize-flow deciding whether to skip it) treats both
 * cases the same way — "no active grant exists, a consent screen is
 * needed" — so there is no reason to make a caller branch on which one it
 * was. A caller that specifically needs to distinguish "never asked" from
 * "revoked" (there is no such caller in this roadmap yet) would need its
 * own query, not a new return shape bolted onto this one.
 *
 * Returns `null` (never throws) on a DB read failure too, same "a
 * transient failure must never look like a valid grant" contract every
 * other lookup in this OIDC roadmap uses (`getOidcClientById()`,
 * `lookupRefreshToken()`) — the failure is logged here, not silently
 * swallowed.
 */
export async function getActiveConsent(userId: number, clientId: string): Promise<StoredOidcUserConsent | null> {
  try {
    const result = await pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM oidc_user_consents WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [userId, clientId],
    );
    if (result.rows.length === 0) return null;
    return mapConsentRow(result.rows[0] as StoredOidcUserConsentDbRow);
  } catch (err) {
    logger.warn({ err, userId, clientId }, "[oidc-user-consents] failed to look up active consent");
    return null;
  }
}

/**
 * 7a write path: record that `userId` has granted `grantedScopes` to
 * `clientId` — a first-time grant if no row exists yet, or a widen/
 * re-grant of the existing one otherwise (this table's own unique-
 * constraint design, see migration 088's header). `granted_at` is reset
 * to now and `revoked_at` is cleared to NULL on every call — see this
 * file's header for why that's correct rather than a silent un-revoke.
 *
 * Returns the resulting row, or `null` if the write itself failed — same
 * "false/null on failure, caller must not proceed as if consent was
 * recorded" contract `persistAuthorizationCode()`/`persistRefreshToken()`
 * already use for their own writes. Callers of this function are
 * responsible for having already validated `clientId` and `grantedScopes`
 * (e.g. via `validateOidcAuthorizeRequest()`) before calling it — this
 * function trusts its inputs the same way `persistAuthorizationCode()`
 * trusts an already-validated binding.
 */
export async function grantConsent(
  userId: number,
  clientId: string,
  grantedScopes: string[],
): Promise<StoredOidcUserConsent | null> {
  try {
    const result = await pool.query(
      `INSERT INTO oidc_user_consents (user_id, client_id, granted_scopes, granted_at, revoked_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NULL)
       ON CONFLICT (user_id, client_id)
       DO UPDATE SET granted_scopes = EXCLUDED.granted_scopes, granted_at = NOW(), revoked_at = NULL
       RETURNING ${RETURNING_COLUMNS}`,
      [userId, clientId, JSON.stringify(grantedScopes)],
    );
    if (result.rows.length === 0) return null;
    return mapConsentRow(result.rows[0] as StoredOidcUserConsentDbRow);
  } catch (err) {
    logger.warn({ err, userId, clientId }, "[oidc-user-consents] failed to record consent grant");
    return null;
  }
}

/**
 * 7d read path: every currently-ACTIVE consent (`revoked_at IS NULL`) for
 * one user, newest grant first — the Connected Apps section's own list.
 * Uses the same `WHERE user_id = $1 AND revoked_at IS NULL` shape migration
 * 088's own `oidc_user_consents_user_id_active_idx` was added ahead of time
 * to cover (see that index's own comment: "Not read by any code shipped in
 * 7a itself" — this is the code).
 *
 * Returns `[]` (never throws) on a DB read failure, same "a transient
 * failure must never look like an empty-but-successful result to the
 * caller, logged here" contract `getActiveConsent()` above already uses —
 * a Connected Apps panel that briefly shows "no connected apps" on a DB
 * hiccup is a much smaller problem than one that throws and breaks the
 * whole Security page.
 */
export async function listActiveConsentsForUser(userId: number): Promise<StoredOidcUserConsent[]> {
  try {
    const result = await pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM oidc_user_consents WHERE user_id = $1 AND revoked_at IS NULL ORDER BY granted_at DESC`,
      [userId],
    );
    return (result.rows as StoredOidcUserConsentDbRow[]).map(mapConsentRow);
  } catch (err) {
    logger.warn({ err, userId }, "[oidc-user-consents] failed to list active consents");
    return [];
  }
}

/**
 * 7d write path: soft-revoke the active consent for one (user, client)
 * pair — `revoked_at = NOW()`, row kept (never deleted, see migration 088's
 * own header on why). Scoped to `revoked_at IS NULL` in the WHERE clause so
 * this is idempotent: revoking an already-revoked (or never-granted)
 * consent is a no-op that returns `false`, not an error and not a second
 * `revoked_at` write clobbering the first one's timestamp.
 *
 * Returns `true` only when a row was actually transitioned from active to
 * revoked — `routes/oidc-connected-apps.ts`'s revoke handler uses this to
 * decide whether there is anything for it to also do (revoke refresh
 * tokens, dispatch backchannel logout): those follow-on effects only make
 * sense once there was a real, active consent to revoke in the first
 * place. Returns `false` (never throws) on a DB write failure too, same
 * "false/null on failure, caller must not proceed as if the write
 * happened" contract `grantConsent()` above already uses.
 */
export async function revokeConsent(userId: number, clientId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `UPDATE oidc_user_consents SET revoked_at = NOW()
       WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [userId, clientId],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err, userId, clientId }, "[oidc-user-consents] failed to revoke consent");
    return false;
  }
}
