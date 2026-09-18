/**
 * lib/oidc-token-client-auth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c-b: Token Endpoint Client Validation.
 *
 * `lib/oidc-clients.ts`'s own header flagged exactly this file's reason to
 * exist: "`clientSecretHash` is real DB data returned by
 * `getOidcClientById()` (a future token-exchange step will need it to
 * verify a confidential client's secret)." This is that step.
 *
 * Scope discipline (this is 3c-b, not 2C/3c-c..3c-g):
 *   - Client_id LOOKUP is not reimplemented here — `validateOidcClientId()`
 *     (Phase 2C-a) is reused as-is, same function `/oidc/authorize` (3a-b)
 *     already calls. This file adds exactly one thing 2C-a never needed:
 *     client_secret verification, because `/oidc/authorize` never receives
 *     a client_secret (it's a browser-facing GET) but `/oidc/token` does
 *     (server-to-server POST, RFC 6749 §3.2.1).
 *   - No code lookup/binding/consumption (3c-c/3c-d/3c-e) and no access
 *     token issuance (3c-f) — this file answers exactly one question, "is
 *     the caller who it claims to be", nothing about the authorization code
 *     it's about to try to redeem.
 *
 * PUBLIC VS. CONFIDENTIAL CLIENTS
 * Every first-party client seeded so far (`scripts/src/seed-oidc-clients.ts`,
 * Phase 2B) is public — `client_secret_hash IS NULL`, PKCE-only, per the
 * roadmap's global security section 3.2 ("require PKCE for first-party
 * authorization-code clients"). A public client is not expected to send a
 * `client_secret` at all (RFC 6749 §2.1: public clients "are incapable of
 * maintaining the confidentiality of their credentials"); PKCE (Phase 3d) is
 * that kind of client's proof of possession instead. This file's branch for
 * `clientSecretHash === null` reflects that: no secret is required, and one
 * sent anyway is simply not checked against anything (there is nothing
 * stored to check it against) rather than treated as an error — RFC 6749
 * doesn't require rejecting extra parameters a public client's SDK might
 * still send out of habit.
 * A future confidential client (`client_secret_hash` set) is who the other
 * branch below exists for — nothing in this codebase seeds one yet, but
 * schema (migration 079) and this check are ready the moment one is.
 *
 * WHY `invalid_client` FOR BOTH "unknown client" AND "wrong secret"
 * Same principle 2C-a already established for `getOidcClientById()`
 * returning `null` for both "no such row" and "DB read failed": a caller
 * probing for which failure mode occurred (does this client_id exist at
 * all? is my guessed secret merely wrong?) learns nothing more from one
 * `invalid_client` response than the other. RFC 6749 §5.2 itself only
 * defines the one `invalid_client` code for "client authentication failed"
 * as a whole — it does not ask for a client-existence oracle.
 */
import { validateOidcClientId, type OidcClient } from "./oidc-client-validation";
import { logger } from "./logger";
import crypto from "node:crypto";

/** 3c-b's result shape — deliberately the same two-field union `validateOidcClientId()` (2C-a) already returns, so `routes/oidc-token.ts` (3c) doesn't need a second error-branching pattern to learn beyond the one Phase 3a's authorize route already uses. */
export type OidcTokenClientAuthResult =
  | { ok: true; client: OidcClient }
  | { ok: false; error: "invalid_client" };

/**
 * SHA-256 hex hash of a raw client secret — identical pattern (and
 * rationale) to `hashApiKey()`/`hashAuthorizationCode()`: a client secret is
 * a bearer credential, stored only as a one-way hash (migration 079's
 * `client_secret_hash` column), never in plaintext.
 */
function hashClientSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time hex-hash comparison — same precedent as `api-key-crypto.ts`'s `safeCompareHash()`. */
function safeCompareHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 3c-b: authenticate the `/oidc/token` caller.
 *
 * `clientId`/`clientSecret` are the already-parsed (3c-a) request fields —
 * this function does no parsing of its own. Missing `clientId` is reported
 * as `invalid_client` immediately (there is nothing to look up), same as an
 * unknown one.
 */
export async function authenticateOidcTokenClient(
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OidcTokenClientAuthResult> {
  if (!clientId) {
    logger.warn("[oidc-token-client-auth] token request missing client_id, rejected");
    return { ok: false, error: "invalid_client" };
  }

  const result = await validateOidcClientId(clientId);
  if (!result.ok) return result;

  const { client } = result;
  if (client.clientSecretHash !== null) {
    if (!clientSecret || !safeCompareHash(hashClientSecret(clientSecret), client.clientSecretHash)) {
      logger.warn({ clientId }, "[oidc-token-client-auth] confidential client secret missing or mismatched, rejected");
      return { ok: false, error: "invalid_client" };
    }
  }

  return { ok: true, client };
}
