/**
 * lib/oidc-client-registration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 8a: Dynamic Client Registration
 * (RFC 7591-স্কোপড-ডাউন) — persistence half.
 *
 * Takes an already-validated `lib/oidc-client-registration-request.ts`
 * result and turns it into a real `oidc_clients` row: generates a random
 * `client_id` and `client_secret`, hashes the secret, and inserts.
 * `routes/oidc-register.ts` is the one caller; this file does no request
 * parsing of its own (that's the sibling file above), same "lib persists,
 * route/sibling-lib validates" split this roadmap uses everywhere else.
 *
 * Scope discipline (this is 8a, not 8b/8c/8d/8e):
 *   - `is_first_party = false` is HARDCODED below, never read from the
 *     request body — 8b's own roadmap text names this exact rule ("একটা
 *     bare-origin endpoint দিয়ে কেউ নিজেকে first-party ঘোষণা করতে পারবে
 *     না"). This is not deferred to 8b as a separate piece of code to add
 *     later — a working registration endpoint that could be tricked into
 *     minting a first-party client would be a real security hole from the
 *     moment it shipped, so 8a's own INSERT already enforces it. What 8b's
 *     text is actually describing is the DECISION ("reuse the existing
 *     `client_secret_hash` column, don't add a new one, hardcode
 *     `is_first_party`") that this file's own INSERT already follows —
 *     see 8b's own roadmap text, which literally narrates what "8a-এর
 *     endpoint" (THIS file, functionally) does with that column. There is
 *     no second migration or second code path 8b needs to add on top of
 *     this.
 *   - `registration_status` (migration 091, Phase 8c, this same pass) is
 *     now set explicitly to `'pending'` in the INSERT below — matching
 *     the column's own DEFAULT, but written out explicitly for the same
 *     reason `is_first_party = FALSE` is spelled out rather than relying
 *     on ITS default: a security-relevant column's value should be
 *     visible in the INSERT statement itself, not implied by a schema
 *     detail a reader of this file would have to go look up. Enforcement
 *     of what `'pending'` actually means (rejecting non-`'approved'`
 *     clients) is NOT this file's job — that's
 *     `lib/oidc-client-validation.ts`'s `validateOidcClientId()`, see
 *     that file's own 8c update note. Before this pass, a client created
 *     here was immediately usable with no gate at all; that gap is what
 *     8c (this pass) closes.
 *   - Baseline `https://`-only / no-wildcard / no-fragment redirect_uri
 *     policy (8d) is enforced upstream, in
 *     `lib/oidc-client-registration-request.ts`'s `validateRedirectUris()`
 *     — by the time `createOidcClient()` below sees `redirectUris`, 8d's
 *     policy has already run. This file does no policy checking of its
 *     own, same "validate once, at the boundary" split as always.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 8e: Client configuration management token
 * (RFC 7592-স্কোপড-ডাউন).
 *
 * `createOidcClient()` now ALSO generates a `registration_access_token`
 * (same entropy/format as `client_secret` — see `generateClientSecret()`'s
 * own comment) alongside the client secret, and stores its hash in the new
 * `registration_access_token_hash` column (migration 092). It is returned
 * in `OidcClientRegistrationResult` exactly like `clientSecret` — plaintext,
 * this once, never retrievable again, never logged. This is a SEPARATE
 * secret from `client_secret`: `client_secret` authenticates the client at
 * `/oidc/token` (proves "I am this OAuth client, issue me tokens");
 * `registration_access_token` authenticates a caller at
 * `GET/PUT /oidc/register/:client_id` (proves "I am the party that
 * registered this client, let me manage its metadata"). Reusing
 * `client_secret` for both would mean any code path that ever needs to
 * LOG or DISPLAY a token-endpoint failure (rate-limit messages, admin
 * debugging) risks also exposing the self-management credential — two
 * independent secrets means a leak or rotation of one never implicates the
 * other.
 *
 * New `updateOidcClientRegistration()` — the persistence half of
 * `PUT /oidc/register/:client_id`. Takes only the two fields 8e's own
 * roadmap text allows a self-managed update to touch
 * (`client_name`/`redirect_uris` — see
 * `lib/oidc-client-registration-request.ts`'s own `validateOidcClientRegistrationUpdateRequest()`
 * for why `scope`/`allowed_scopes` is never even a parameter this function
 * could accept). Partial: only the fields actually present in `updates`
 * are written, matching RFC 7592's own allowance for a partial
 * configuration update.
 *
 * WHY client_secret_hash REUSES `hashClientSecret()` FROM
 * `oidc-token-client-auth.ts` RATHER THAN A LOCAL COPY: that file's own
 * `authenticateOidcTokenClient()` is what will later verify whatever
 * secret this file issues. Hashing with a DIFFERENT function here — even
 * one that "looks equivalent" (e.g. a different hash algorithm, a
 * different encoding) — would silently make every dynamically-registered
 * confidential client's secret unverifiable forever, a bug that would
 * only surface the first time a real client tried to redeem a code. One
 * shared function makes that class of bug structurally impossible instead
 * of relying on the two implementations staying in sync by discipline.
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { hashClientSecret } from "./oidc-token-client-auth";
import { getOidcClientById, type OidcClient } from "./oidc-clients";

/** Generated `client_id` length in random bytes before hex-encoding — a public identifier, not a secret, but still unguessable enough that two independent registrations can never collide in practice. Hex (not base64url) so it reads unambiguously in a URL, a log line, or a `client_id` form field without any encoding questions. */
const CLIENT_ID_RANDOM_BYTES = 16;

/**
 * Raw client secret generation — the SAME entropy/format decision
 * `generateAuthorizationCode()` (`oidc-authorization-codes.ts`) already
 * uses for this codebase's other shown-once bearer secret: 32 random
 * bytes (256 bits), base64url-encoded. Reusing an already-reviewed
 * decision rather than inventing a second "how random is random enough"
 * judgment call for client secrets specifically.
 */
function generateClientSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateClientId(): string {
  return crypto.randomBytes(CLIENT_ID_RANDOM_BYTES).toString("hex");
}

/**
 * OIDC Roadmap — Season 4, Phase 8e: raw registration_access_token
 * generation — same entropy/format decision as `generateClientSecret()`
 * above (32 random bytes, base64url), a DIFFERENT random value each call
 * (never derived from or equal to the client secret generated alongside
 * it — see this file's own header for why these must be two independent
 * secrets).
 */
function generateRegistrationAccessToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** What `createOidcClient()` hands back to `routes/oidc-register.ts` — the RFC 7591 §3.2.1 response fields 8a's own roadmap text names, plus (Phase 8e) `registrationAccessToken` — nothing else (no full `OidcClient` row, no `client_secret_hash`/`registration_access_token_hash` — see the file-wide "never expose a hash, only ever the plaintext-once-and-only-once secret this same call just generated" discipline every OIDC secret-issuing code path in this codebase already follows). */
export interface OidcClientRegistrationResult {
  clientId: string;
  clientSecret: string;
  /** Phase 8e — bearer credential for `GET/PUT /oidc/register/:client_id`. Plaintext, this once, never retrievable again. */
  registrationAccessToken: string;
  clientIdIssuedAt: Date;
}

/**
 * 8a: create a new dynamically-registered client. `clientName`,
 * `redirectUris`, `scopes` are exactly the already-validated fields
 * `validateOidcClientRegistrationRequest()` produces — this function does
 * no re-validation of its own, same "validate once, at the boundary"
 * discipline every other OIDC write in this roadmap follows.
 *
 * Retries once on a `client_id` collision (Postgres unique-violation,
 * SQLSTATE `23505`, on `oidc_clients_client_id_idx` — migration 079) —
 * astronomically unlikely at 128 bits of randomness, but "assume the
 * random generator can theoretically collide and handle it gracefully"
 * is cheap insurance, not paranoia this codebase is inventing new for
 * this file (compare `lib/oidc-authorization-codes.ts`'s own comment on
 * why it hashes before persisting even though a raw-code collision is
 * similarly implausible). A second collision inside the same request is
 * treated as `server_error` rather than retried indefinitely — an
 * infinite retry loop on a persistently-failing insert is its own
 * availability risk.
 *
 * Returns `null` (never throws) on any persistence failure, same
 * "failure must not look like anything other than what it is, logged
 * here, caller decides the HTTP response" contract every other write in
 * this file's sibling libs (`lib/oidc-user-consents.ts`'s
 * `grantConsent()`) already uses.
 */
export async function createOidcClient(
  clientName: string,
  redirectUris: string[],
  scopes: string[],
): Promise<OidcClientRegistrationResult | null> {
  const clientSecret = generateClientSecret();
  const clientSecretHash = hashClientSecret(clientSecret);
  // Phase 8e — see file header for why this is a second, independent secret.
  const registrationAccessToken = generateRegistrationAccessToken();
  const registrationAccessTokenHash = hashClientSecret(registrationAccessToken);

  for (let attempt = 0; attempt < 2; attempt++) {
    const clientId = generateClientId();
    try {
      const result = await pool.query(
        `INSERT INTO oidc_clients (client_id, client_secret_hash, client_name, registration_status, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, allowed_scopes, is_first_party, registration_access_token_hash)
         VALUES ($1, $2, $3, 'pending', $4::jsonb, '[]'::jsonb, NULL, $5::jsonb, FALSE, $6)
         RETURNING created_at`,
        [clientId, clientSecretHash, clientName, JSON.stringify(redirectUris), JSON.stringify(scopes), registrationAccessTokenHash],
      );
      const clientIdIssuedAt = result.rows[0]?.created_at instanceof Date ? result.rows[0].created_at : new Date();
      logger.info({ clientId }, "oidc.client.registered");
      return { clientId, clientSecret, registrationAccessToken, clientIdIssuedAt };
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === "23505" && attempt === 0) {
        logger.warn({ clientId }, "[oidc-client-registration] client_id collision, retrying once");
        continue;
      }
      logger.warn({ err }, "[oidc-client-registration] failed to persist dynamically-registered client");
      return null;
    }
  }
  return null;
}

/**
 * 8e: persistence half of `PUT /oidc/register/:client_id`. `updates` is
 * exactly the already-validated, already-8d-policy-checked fields
 * `validateOidcClientRegistrationUpdateRequest()` produces — this function
 * does no re-validation of its own, same discipline as `createOidcClient()`
 * above.
 *
 * Partial by construction: only the keys actually PRESENT in `updates` are
 * written (checked via `!== undefined`, not truthiness — an empty-array
 * `redirectUris` can never reach here anyway, since `validateRedirectUris()`
 * already rejects an empty array, but this function itself imposes no
 * such constraint of its own; it writes whatever it's handed). Calling this
 * with an empty `updates` object is a caller bug, not something this
 * function guards against — `lib/oidc-client-registration-request.ts`'s own
 * "at least one field required" check is what prevents that from ever
 * happening in practice, same "validate once, upstream" split as always.
 *
 * Returns the freshly-read `OidcClient` (via `getOidcClientById()`, not a
 * hand-assembled object) on success — so a caller always gets back exactly
 * what is now truly in the database, not what it optimistically thinks it
 * wrote. Returns `null` (never throws) on any persistence failure or if
 * `clientId` doesn't exist, same contract as every other write in this
 * file.
 */
export async function updateOidcClientRegistration(
  clientId: string,
  updates: { clientName?: string; redirectUris?: string[] },
): Promise<OidcClient | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.clientName !== undefined) {
    sets.push(`client_name = $${paramIndex++}`);
    values.push(updates.clientName);
  }
  if (updates.redirectUris !== undefined) {
    sets.push(`redirect_uris = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.redirectUris));
  }
  if (sets.length === 0) {
    logger.warn({ clientId }, "[oidc-client-registration] updateOidcClientRegistration called with no fields to update");
    return getOidcClientById(clientId);
  }
  sets.push(`updated_at = now()`);
  values.push(clientId);

  try {
    const result = await pool.query(
      `UPDATE oidc_clients SET ${sets.join(", ")} WHERE client_id = $${paramIndex} RETURNING id`,
      values,
    );
    if (result.rows.length === 0) {
      logger.warn({ clientId }, "[oidc-client-registration] update targeted an unknown client_id");
      return null;
    }
    logger.info({ clientId }, "oidc.client.self_updated");
    return getOidcClientById(clientId);
  } catch (err) {
    logger.warn({ err, clientId }, "[oidc-client-registration] failed to update dynamically-registered client");
    return null;
  }
}
