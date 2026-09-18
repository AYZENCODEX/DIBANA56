/**
 * lib/oidc-clients.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2A-c (Client Registry, part C).
 *
 * Read-only data-access layer over the `oidc_clients` table (migration 079,
 * schema mirror in `@workspace/db`'s `oidc-clients.ts`) introduced in
 * Phase 2A-a/2A-b. Same shape as `lib/jwt-keys.ts`'s `fetchDbVerificationKeys()`
 * for `jwt_signing_keys`: raw parameterized `pool.query()` reads, a row
 * mapper that turns Postgres's snake_case/JSONB shape into a typed JS
 * object, nothing more.
 *
 * Scope discipline (this is 2A-c, not 2B/2C/2D/2E):
 *   - Lookup + existence check + row mapping ONLY, as specified by the
 *     roadmap's 2A-c task list. No insert/update/delete helpers — Phase 2B
 *     seeds Sylo/Ryft/Wisp/Verve/Zynth, and how those rows get written
 *     (direct SQL in a seed script vs. a helper here) is that phase's call.
 *     Still true after Phase 8a (migration 090, `client_name` column):
 *     `lib/oidc-client-registration.ts`'s `createOidcClient()` is its own,
 *     separate insert-only file, not a new function added here — this file
 *     stays read-only. Season 5, Phase 9a's `listAllOidcClients()` below is
 *     still read-only too — it does not break this rule, only widens the
 *     existing "lookup" scope from "by one `client_id`" to "every row."
 *   - No redirect-URI exact-matching, near-match rejection, or validation
 *     error contract — that is Phase 2C.
 *   - No scope parsing/validation — that is Phase 2D.
 *   - No unified `validateClientRequest()` — that is Phase 2E.
 *   - Nothing in this file is wired into `/oidc/authorize` or any route yet.
 *
 * SAFETY NOTE — `clientSecretHash` is real DB data returned by
 * `getOidcClientById()` (a future token-exchange step will need it to
 * verify a confidential client's secret). It must never be logged — see the
 * roadmap's global observability rule ("Do not log: ... client secrets").
 * Nothing in this file logs a fetched row's contents; only kid-free/secret-
 * free identifiers (`clientId`) appear in warn logs below.
 *
 * UPDATE — Season 4, Phase 8c (migration 091): `OidcClient` gained
 * `registrationStatus`. This file only reads/maps it — the actual
 * "reject a non-approved client" enforcement lives in
 * `lib/oidc-client-validation.ts`'s `validateOidcClientId()`, the single
 * choke point both `/oidc/authorize` and `/oidc/token` already route
 * through, so this file needed no new exported function for 8c, only a
 * new field on the type this file already returns.
 *
 * UPDATE — Season 4, Phase 8e (migration 092): `OidcClient` gained
 * `registrationAccessTokenHash`. Same "SAFETY NOTE" as
 * `clientSecretHash` above applies verbatim — this is real secret-hash
 * data, never to be logged, and this file's job is still only lookup +
 * row-mapping; the actual verification
 * (`validateOidcClientRegistrationAccessToken()`) lives in
 * `lib/oidc-client-validation.ts`, alongside 8c's analogous choice for
 * `registrationStatus`.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger";

export type OidcClientRegistrationStatus = "pending" | "approved" | "suspended";

export interface OidcClient {
  id: number;
  clientId: string;
  clientSecretHash: string | null;
  /**
   * OIDC Roadmap — Season 4, Phase 8a (migration 090). Human-readable
   * display name — `NULL` for every client seeded before this column
   * existed (see that migration's own header for why no backfill was
   * done) and for any first-party client an admin creates without one.
   * `routes/oidc-consent.ts` / `routes/oidc-connected-apps.ts` already
   * fall back to the raw `clientId` when this is `null` — that fallback
   * predates this column and needed no change once it landed.
   */
  clientName: string | null;
  /**
   * OIDC Roadmap — Season 4, Phase 8c (migration 091). One of `'pending'`,
   * `'approved'`, `'suspended'` — see that migration's own header for the
   * backfill rule that keeps every pre-existing client `'approved'`.
   * Enforced by `lib/oidc-client-validation.ts`'s `validateOidcClientId()`,
   * not by this file — this is read-only storage access, same as every
   * other field here.
   */
  registrationStatus: OidcClientRegistrationStatus;
  redirectUris: string[];
  /**
   * OIDC Roadmap — Season 3, Phase 6a-d (migration 084). RP-Initiated
   * Logout's own registered allow-list — deliberately separate from
   * `redirectUris` (the Authorization Code callback allow-list); see
   * migration 084's own header for why these are two independent lists,
   * not one reused for both purposes.
   */
  postLogoutRedirectUris: string[];
  /**
   * OIDC Roadmap — Season 3, Phase 6e-b (migration 085). This client's
   * OpenID Back-Channel Logout 1.0 receiving endpoint (§2.5's own POST
   * target), or `null` when the client hasn't registered one. `null` is
   * the fail-closed default, not "unknown" — see migration 085's own
   * header and `listBackchannelLogoutTargets()` below, the one reader
   * that filters on this being non-null. Only `sylo` is seeded with a
   * real value today (`scripts/src/seed-oidc-clients.ts`).
   */
  backchannelLogoutUri: string | null;
  allowedScopes: string[];
  isFirstParty: boolean;
  /**
   * OIDC Roadmap — Season 4, Phase 8e (migration 092). SHA-256 hash (same
   * `hashClientSecret()` used for `clientSecretHash`) of the bearer token
   * `POST /oidc/register` (8a) issues once, in-band, for later
   * `GET/PUT /oidc/register/:client_id` self-management. `NULL` for every
   * client that predates this column (every first-party client, and every
   * dynamically-registered client created before this migration ran) —
   * fail-closed, same posture `backchannelLogoutUri`'s `null` default
   * already established: `NULL` here means "this client cannot currently
   * self-manage," not "unknown," and `validateOidcClientRegistrationAccessToken()`
   * (`lib/oidc-client-validation.ts`) treats it as an automatic reject.
   */
  registrationAccessTokenHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OidcClientDbRow {
  id: number;
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  registration_status: string;
  redirect_uris: unknown;
  post_logout_redirect_uris: unknown;
  backchannel_logout_uri: string | null;
  allowed_scopes: unknown;
  is_first_party: boolean;
  registration_access_token_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Safe field mapping: turns one `oidc_clients` Postgres row into the typed
 * `OidcClient` shape. JSONB columns come back from `pg` already parsed into
 * JS values, but not narrowed to `string[]` — this is where that narrowing
 * happens, defensively (a malformed/non-array JSONB value maps to `[]`
 * rather than throwing, so one bad row can't take down every caller).
 *
 * Exported (unlike the DB-hitting functions below) so Phase 2A-d's schema
 * tests can exercise it directly without a live DATABASE_URL — same split
 * `lib/jwt-keys.ts` uses between its exported pure `mergeVerificationKeys()`
 * and its private, DB-hitting `fetchDbVerificationKeys()`.
 */
export function mapOidcClientRow(row: OidcClientDbRow): OidcClient {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    registrationStatus: toRegistrationStatus(row.registration_status),
    redirectUris: toStringArray(row.redirect_uris),
    postLogoutRedirectUris: toStringArray(row.post_logout_redirect_uris),
    backchannelLogoutUri: row.backchannel_logout_uri,
    allowedScopes: toStringArray(row.allowed_scopes),
    isFirstParty: row.is_first_party,
    registrationAccessTokenHash: row.registration_access_token_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Defensive narrowing for `registration_status`, same "a malformed value
 * degrades safely rather than throwing or silently trusting it" posture
 * `toStringArray()` already takes for the JSONB columns. An unrecognized
 * value (should never happen — the column has a CHECK constraint,
 * migration 091) maps to `'suspended'`, the most restrictive of the three
 * states — fail-closed, not fail-open, the same instinct migration 085's
 * own header already applies to `backchannel_logout_uri`'s `null` default.
 */
function toRegistrationStatus(value: string): OidcClientRegistrationStatus {
  if (value === "pending" || value === "approved" || value === "suspended") return value;
  return "suspended";
}

/**
 * Client lookup by `client_id` (the public identifier, e.g. `"sylo"` — not
 * the surrogate `id`). Returns `null` for both "row doesn't exist" and "DB
 * read failed" — callers that need to tell those apart should catch instead
 * of relying on a thrown error from here; the read failure is still logged.
 *
 * This is lookup only. It does not check redirect_uri or scope — that's
 * Phase 2C/2D, layered on top of this once it exists.
 */
export async function getOidcClientById(clientId: string): Promise<OidcClient | null> {
  try {
    const r = await pool.query(
      `SELECT id, client_id, client_secret_hash, client_name, registration_status, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, allowed_scopes, is_first_party, registration_access_token_hash, created_at, updated_at
       FROM oidc_clients
       WHERE client_id = $1`,
      [clientId],
    );
    if (r.rows.length === 0) return null;
    return mapOidcClientRow(r.rows[0] as OidcClientDbRow);
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-clients] failed to look up client_id");
    return null;
  }
}

/**
 * Existence check for a `client_id`. Deliberately a separate, narrower
 * query (`SELECT 1 ... LIMIT 1`) rather than `!!(await getOidcClientById(...))`
 * — callers that only need "does this client exist?" (e.g. an early guard
 * before doing anything else) shouldn't pay for fetching/mapping the full
 * row, including `client_secret_hash`, just to throw it away.
 */
export async function oidcClientExists(clientId: string): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT 1 FROM oidc_clients WHERE client_id = $1 LIMIT 1`, [clientId]);
    return r.rows.length > 0;
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-clients] failed to check client_id existence");
    return false;
  }
}

/**
 * OIDC Roadmap — Season 5, Phase 9a: every `oidc_clients` row, full shape,
 * for the admin client-list view (`routes/admin-oidc-clients.ts`). Unlike
 * `listBackchannelLogoutTargets()` above (a narrow projection for one
 * specific consumer), this returns the complete `OidcClient` shape via
 * the same `mapOidcClientRow()` every other reader here uses — an admin
 * list view is exactly the "need the whole row" case
 * `getOidcClientById()`'s own doc comment already contrasts against
 * `oidcClientExists()`'s narrower query.
 *
 * Ordered newest-first (`created_at DESC`) — a freshly `POST /oidc/register`-ed
 * `'pending'` client (the one an operator most needs to find, to act on
 * Phase 9d's approval workflow once it exists) surfaces at the top rather
 * than requiring the admin to page through every long-lived first-party
 * client to find it.
 *
 * Returns `[]` (never throws) on a DB read failure — same contract as
 * every other reader in this file; an admin list view degrading to
 * "no clients shown" on a transient DB error is correct, a 500 thrown
 * from a lib function up through an Express route is not this file's
 * job to produce.
 */
/**
 * OIDC Roadmap — Season 5, Phase 9b/9c: the full-detail projection an admin
 * detail/edit view (9b) or a just-created/just-deleted client response (9c)
 * needs — every field 9a's own list-view mapping already exposes
 * (`clientId`, `clientName`, `isFirstParty`, `registrationStatus`,
 * `createdAt`) PLUS the fields 9a deliberately left out because a *list*
 * row has no room for them (`redirectUris`, `postLogoutRedirectUris`,
 * `backchannelLogoutUri`, `allowedScopes`, `updatedAt`) — exactly the set
 * 9b's own roadmap text names as admin-editable
 * (`redirect_uris`/`allowed_scopes`/`backchannel_logout_uri`), plus the
 * read-only identifiers around them.
 *
 * `clientSecretHash` and `registrationAccessTokenHash` are NEVER included
 * here either — same "never expose a hash, only the plaintext-once secret
 * at issuance" discipline `routes/admin-oidc-clients.ts`'s own file header
 * already states for 9a's list view; a detail view widens which fields
 * are visible, not that discipline.
 *
 * Pure function (no DB call, no `pool` import) — same "exported so a
 * schema/route test can exercise it without a live DATABASE_URL" reasoning
 * `mapOidcClientRow()` above already documents for itself.
 */
export function serializeOidcClientForAdmin(client: OidcClient) {
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    isFirstParty: client.isFirstParty,
    registrationStatus: client.registrationStatus,
    redirectUris: client.redirectUris,
    postLogoutRedirectUris: client.postLogoutRedirectUris,
    backchannelLogoutUri: client.backchannelLogoutUri,
    allowedScopes: client.allowedScopes,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };
}

export async function listAllOidcClients(): Promise<OidcClient[]> {
  try {
    const r = await pool.query(
      `SELECT id, client_id, client_secret_hash, client_name, registration_status, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, allowed_scopes, is_first_party, registration_access_token_hash, created_at, updated_at
       FROM oidc_clients
       ORDER BY created_at DESC`,
    );
    return r.rows.map((row) => mapOidcClientRow(row as OidcClientDbRow));
  } catch (err) {
    logger.warn({ err }, "[oidc-clients] failed to list all clients");
    return [];
  }
}

/**
 * registered to RECEIVE a propagated Back-Channel Logout event — i.e.
 * every `oidc_clients` row with a non-null `backchannel_logout_uri`
 * (migration 085). The one caller is
 * `lib/oidc-logout-propagation.ts`'s `resolveBackchannelLogoutTargets()`,
 * which needs every candidate target at once, not one specific
 * `client_id` — a narrower, purpose-built query rather than looping
 * `getOidcClientById()` over every seeded client and throwing away the
 * ones with a null URI.
 *
 * Returns `[]` (never throws) on a DB read failure, same "read failure
 * looks like an empty/absent result to the caller, logged here" contract
 * `getOidcClientById()`/`oidcClientExists()` above already use — a
 * transient DB error here must degrade to "propagate to nobody this
 * time," never crash the fire-and-forget dispatch call sites
 * (`routes/auth.ts`, `routes/oidc-logout.ts`) that depend on this never
 * throwing.
 */
export async function listBackchannelLogoutTargets(): Promise<{ clientId: string; backchannelLogoutUri: string }[]> {
  try {
    const r = await pool.query(
      `SELECT client_id, backchannel_logout_uri FROM oidc_clients WHERE backchannel_logout_uri IS NOT NULL`,
    );
    return r.rows
      .filter((row) => typeof row.backchannel_logout_uri === "string" && row.backchannel_logout_uri.length > 0)
      .map((row) => ({ clientId: row.client_id as string, backchannelLogoutUri: row.backchannel_logout_uri as string }));
  } catch (err) {
    logger.warn({ err }, "[oidc-clients] failed to look up backchannel logout targets");
    return [];
  }
}
