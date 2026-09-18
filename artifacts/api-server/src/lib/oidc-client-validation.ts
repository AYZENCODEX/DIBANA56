/**
 * lib/oidc-client-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2C: Client & Redirect URI Validation.
 *
 * Layers on top of Phase 2A-c's read-only registry access
 * (`getOidcClientById()` in `./oidc-clients`) the two checks the roadmap's
 * 2C task list asks for:
 *   - 2C-a: reject an unknown `client_id`.
 *   - 2C-b/2C-c: require the caller's `redirect_uri` to be an EXACT match
 *     against one of that client's registered `redirect_uris` — a
 *     path/scheme/host/query difference is a different string and must
 *     fail, not a "close enough" pass.
 *   - 2C-d: a consistent internal result shape for both checks (see
 *     `OidcClientValidationResult` / `OidcRedirectUriValidationResult`
 *     below) instead of two ad-hoc booleans or thrown exceptions.
 *
 * Scope discipline (this is 2C, not 2D/2E):
 *   - No scope parsing/allowed-scope checking — that is Phase 2D.
 *   - No unified `validateClientRequest(client_id, redirect_uri, scope)`
 *     combining this file's two checks with 2D's — that is Phase 2E-a.
 *     This file provides the two pieces 2E-a will compose, not the
 *     composition itself.
 *   - Nothing here is wired into `/oidc/authorize` or any route yet — that
 *     route doesn't exist until Phase 3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 8c: Pending/Unverified State + Abuse Prevention.
 *
 * `validateOidcClientId()` below now also rejects a client whose
 * `registrationStatus` (migration 091) isn't `'approved'` — a `'pending'`
 * (freshly dynamically-registered via Phase 8a, awaiting Phase 9d's
 * not-yet-built admin approval) or `'suspended'` client is treated
 * EXACTLY like an unknown `client_id`: same `invalid_client` result, no
 * new error code. This was a deliberate choice, not the path of least
 * resistance:
 *   - This function is the ONE place both `/oidc/authorize`
 *     (`lib/oidc-authorize-request.ts` -> `lib/oidc-client-request-validation.ts`
 *     -> here) and `/oidc/token` (`lib/oidc-token-client-auth.ts` -> here)
 *     resolve a `client_id` through. Adding the check here, once, covers
 *     both endpoints — 8c's own roadmap text names both explicitly
 *     ("`/oidc/authorize`/`/oidc/token` এই status-এ থাকা client-কে
 *     reject করে") — with no changes needed to either route or to
 *     `oidc-token-client-auth.ts`/`oidc-client-request-validation.ts`'s
 *     own composition logic.
 *   - Reusing `invalid_client` rather than inventing a distinct
 *     `unauthorized_client` result was the safety-driven choice: this
 *     function only knows the `client_id`, not yet whether the caller's
 *     `redirect_uri` is one this client actually registered. A NEW
 *     error code here would tempt a caller (`/oidc/authorize`'s route) to
 *     redirect the user-agent back to that client's `redirect_uri` with
 *     `?error=unauthorized_client` — exactly the "redirect to an
 *     unverified target" hazard this same file's header already warns
 *     against for `invalid_client` generally. Collapsing "pending"/
 *     "suspended" into the SAME `invalid_client` result this function
 *     already returns for "unknown client_id" means every existing
 *     caller's existing "don't redirect on invalid_client" handling
 *     already does the right thing here too, with zero new branches to
 *     get wrong.
 *
 * WHY REDIRECT URI VALIDATION IS ITS OWN ERROR, NOT `invalid_request`
 * The roadmap's global error model (section 4) lists standard OAuth/OIDC
 * error codes — `invalid_client`, `invalid_request`, etc. — that Phase 3's
 * `/oidc/authorize` will eventually send back to the CLIENT by redirecting
 * the user-agent to its `redirect_uri` with `?error=...` appended. That
 * mechanism is unsafe for exactly one failure: an unrecognized or
 * mismatched `redirect_uri`. If the server can't first confirm the
 * supplied `redirect_uri` is one the client actually registered, it must
 * not redirect the user-agent there at all — doing so would let anyone
 * redirect a victim to an arbitrary attacker-controlled URL just by
 * appending `&error=invalid_request`. RFC 6749 section 4.1.2.1 calls this
 * out explicitly for the same reason.
 *
 * So `"invalid_redirect_uri"` is kept as its own distinct internal error
 * value here, separate from `"invalid_client"` (which IS one of the
 * global error model's codes, since an unknown client is safe to reject
 * with a directly-rendered response — there's no verified redirect target
 * to redirect back to either way). How Phase 3's authorization endpoint
 * ultimately renders each of these two (redirect vs. a directly-rendered
 * error page) is that phase's call — this file only needs to make the two
 * failure cases distinguishable to whatever calls it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 4, Phase 8e: Client configuration management token
 * (RFC 7592-স্কোপড-ডাউন).
 *
 * New `validateOidcClientRegistrationAccessToken()` below — a THIRD,
 * independent validator alongside this file's existing client-id and
 * redirect-uri checks, for a route (`GET/PUT /oidc/register/:client_id`)
 * that never redirects a user-agent anywhere at all. See that function's
 * own doc comment for why it uses a distinct `invalid_token` error rather
 * than reusing `invalid_client`.
 */

import { getOidcClientById, type OidcClient } from "./oidc-clients";
import { logger } from "./logger";
import { hashClientSecret } from "./oidc-token-client-auth";
import { safeCompareHash } from "./api-key-crypto";

/** 2C-d: consistent success/failure shape for client-id lookup validation. */
export type OidcClientValidationResult =
  | { ok: true; client: OidcClient }
  | { ok: false; error: "invalid_client" };

/** 2C-d: consistent success/failure shape for redirect-uri validation. */
export type OidcRedirectUriValidationResult =
  | { ok: true; redirectUri: string }
  | { ok: false; error: "invalid_redirect_uri" };

/**
 * OIDC Roadmap — Season 3, Phase 6a-d: consistent success/failure shape for
 * `post_logout_redirect_uri` validation. Kept as its own result type (not
 * reusing `OidcRedirectUriValidationResult`) so a caller can never
 * accidentally treat "passed the Authorization Code callback check" as
 * "passed the RP-Initiated Logout check" or vice versa — see migration
 * 084's header for why these are two independent registered lists.
 */
export type OidcPostLogoutRedirectUriValidationResult =
  | { ok: true; postLogoutRedirectUri: string }
  | { ok: false; error: "invalid_post_logout_redirect_uri" };

/**
 * 2C-a: Client Lookup Validation.
 *
 * Rejects an unknown `client_id` with a structured `invalid_client`
 * result instead of a bare `null`/boolean — this is the layer above
 * `getOidcClientById()` that gives callers (Phase 2E's unified validator,
 * and eventually Phase 3's `/oidc/authorize`) one consistent result shape
 * to branch on, rather than re-deriving "not found" -> "invalid_client"
 * translation themselves at every call site.
 *
 * `getOidcClientById()` already returns `null` for both "no such row" and
 * "the DB read itself failed" (logging the failure case itself). Both are
 * "cannot proceed with this client_id" from a caller's point of view, so
 * both map to the same `invalid_client` result here — a transient DB
 * failure must never be treated as an authorization grant by falling
 * through as if the client were valid.
 */
export async function validateOidcClientId(clientId: string): Promise<OidcClientValidationResult> {
  const client = await getOidcClientById(clientId);
  if (!client) {
    logger.warn({ clientId }, "[oidc-client-validation] unknown (or unresolvable) client_id rejected");
    return { ok: false, error: "invalid_client" };
  }
  // 8c — see file header's "UPDATE" note for why this reuses the same
  // `invalid_client` result rather than a new error code.
  if (client.registrationStatus !== "approved") {
    logger.warn(
      { clientId, registrationStatus: client.registrationStatus },
      "[oidc-client-validation] client is not approved (pending or suspended), rejected",
    );
    return { ok: false, error: "invalid_client" };
  }
  return { ok: true, client };
}

/**
 * 2C-b/2C-c: Redirect URI Exact Matching / Reject Near-Matches.
 *
 * Pure function — takes an already-validated `client` (e.g. from
 * `validateOidcClientId()`) rather than a `clientId`, so it never makes
 * its own DB call and is trivially unit-testable without a database.
 *
 * Exact string equality against `client.redirectUris` is deliberate and
 * sufficient to satisfy 2C-c's "reject near-matches" requirement for
 * every listed case:
 *   - path difference   ("/callback" vs "/callback/extra")   -> different string, no match.
 *   - scheme difference ("https://" vs "http://")            -> different string, no match.
 *   - host difference   ("sylo.ayzen.tech" vs "evil.tech",
 *                         or "sylo.ayzen.tech" vs
 *                         "sylo.ayzen.tech.evil.com")        -> different string, no match.
 *   - query difference  ("?x=1" vs no query, or "?x=2")      -> different string, no match.
 * No normalization is performed on either side (no trailing-slash
 * trimming, no case-folding, no query-param re-ordering, no percent-
 * decoding) — normalizing before comparison is exactly how open-redirect
 * bugs get introduced (RFC 6749's rationale for requiring exact matching).
 * A registered redirect URI that needs a variant (trailing slash, a dev
 * origin, etc.) must be registered as its own explicit array entry — that
 * is the registry's (Phase 2A/2B's) job, not this function's.
 */
export function validateOidcRedirectUri(
  client: OidcClient,
  redirectUri: string,
): OidcRedirectUriValidationResult {
  if (typeof redirectUri === "string" && redirectUri.length > 0 && client.redirectUris.includes(redirectUri)) {
    return { ok: true, redirectUri };
  }
  logger.warn(
    { clientId: client.clientId },
    "[oidc-client-validation] redirect_uri is not an exact registered match, rejected",
  );
  return { ok: false, error: "invalid_redirect_uri" };
}

/**
 * OIDC Roadmap — Season 3, Phase 6a-d: RP-Initiated Logout's own
 * `post_logout_redirect_uri` check.
 *
 * Identical exact-match discipline to `validateOidcRedirectUri()` above —
 * same rationale (RFC 6749 §4.1.2.1's open-redirect concern applies just
 * as much to where a logout response sends the user-agent next), same "no
 * normalization on either side" rule — just checked against
 * `client.postLogoutRedirectUris` (migration 084) instead of
 * `client.redirectUris`. Pure function, same reasoning as its sibling: no
 * DB call of its own, takes an already-resolved `client`.
 */
export function validateOidcPostLogoutRedirectUri(
  client: OidcClient,
  postLogoutRedirectUri: string,
): OidcPostLogoutRedirectUriValidationResult {
  if (
    typeof postLogoutRedirectUri === "string" &&
    postLogoutRedirectUri.length > 0 &&
    client.postLogoutRedirectUris.includes(postLogoutRedirectUri)
  ) {
    return { ok: true, postLogoutRedirectUri };
  }
  logger.warn(
    { clientId: client.clientId },
    "[oidc-client-validation] post_logout_redirect_uri is not an exact registered match, rejected",
  );
  return { ok: false, error: "invalid_post_logout_redirect_uri" };
}

/**
 * OIDC Roadmap — Season 4, Phase 8e: consistent success/failure shape for
 * `GET/PUT /oidc/register/:client_id`'s own bearer-token check. Deliberately
 * its own error code (`invalid_token`, not `invalid_client`) — unlike
 * `validateOidcClientId()` above, a caller here NEVER redirects a
 * user-agent anywhere (this is a direct-response JSON API, no
 * `redirect_uri` in sight), so the open-redirect reasoning that forces
 * `invalid_client`/`invalid_redirect_uri` to stay collapsed/distinct in
 * THAT part of this file simply doesn't apply here. `invalid_token` also
 * matches the vocabulary RFC 7592/RFC 6750 callers already expect from a
 * bearer-auth failure on a management endpoint.
 */
export type OidcClientRegistrationAccessTokenValidationResult =
  | { ok: true }
  | { ok: false; error: "invalid_token" };

/**
 * 8e: verify a caller-presented bearer token against `client`'s own
 * `registrationAccessTokenHash` (migration 092). Pure with respect to the
 * DATABASE — takes an already-fetched `client` rather than a `clientId`,
 * same "no DB call of its own" shape as `validateOidcRedirectUri()` above —
 * but not a pure FUNCTION in the strict sense, since `hashClientSecret()`
 * does real (fast, deterministic) computation; still trivially testable
 * without a live DB.
 *
 * A `null` `registrationAccessTokenHash` (every first-party client, and
 * every dynamically-registered client created before migration 092
 * existed — see that migration's own header) is an automatic reject, same
 * fail-closed instinct `toRegistrationStatus()`'s own comment
 * (`lib/oidc-clients.ts`) already applies to a malformed enum value: no
 * hash on file means no possible presented token can ever verify, by
 * construction, not by accident.
 *
 * Reuses `hashClientSecret()` (`lib/oidc-token-client-auth.ts`) — the SAME
 * function `lib/oidc-client-registration.ts`'s `createOidcClient()` hashed
 * this token with at issuance time — and `safeCompareHash()`
 * (`lib/api-key-crypto.ts`) for the constant-time comparison, exactly
 * mirroring `authenticateOidcTokenClient()`'s own
 * `client_secret`/`clientSecretHash` check just below in spirit (fetch by
 * a non-secret identifier first, THEN timing-safe-compare a hash against
 * the already-fetched row) rather than a raw `===` on hex strings.
 */
export function validateOidcClientRegistrationAccessToken(
  client: OidcClient,
  presentedToken: string,
): OidcClientRegistrationAccessTokenValidationResult {
  if (
    !client.registrationAccessTokenHash ||
    typeof presentedToken !== "string" ||
    presentedToken.length === 0 ||
    !safeCompareHash(hashClientSecret(presentedToken), client.registrationAccessTokenHash)
  ) {
    logger.warn(
      { clientId: client.clientId },
      "[oidc-client-validation] registration access token missing or mismatched, rejected",
    );
    return { ok: false, error: "invalid_token" };
  }
  return { ok: true };
}
