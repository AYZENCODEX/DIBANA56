/**
 * lib/oidc-scope-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2D: Scope Validation.
 *
 * Same family as `./oidc-client-validation.ts` (Phase 2C): a pure,
 * DB-free layer above the registry data Phase 2A/2B already built,
 * this time checking the `scope` a request asks for instead of the
 * `client_id`/`redirect_uri` it names.
 *
 * Scope discipline (this is 2D, not 2E):
 *   - No unified `validateClientRequest(client_id, redirect_uri, scope)`
 *     combining this file's checks with 2C's — that is Phase 2E-a. This
 *     file provides the third piece 2E-a will compose, not the
 *     composition itself.
 *   - Nothing here is wired into `/oidc/authorize` or any route yet —
 *     that route doesn't exist until Phase 3.
 *   - Does not touch `lib/oidc-discovery.ts`'s `SCOPES_SUPPORTED`
 *     (currently `["openid"]` only, with its own comment explicitly
 *     deferring "profile"/"email" to "Phase 2's job"). That constant
 *     feeds the discovery *document* Phase 1E-e already publishes — this
 *     phase is not asked to (and does not) touch a route or a
 *     previously-shipped sub-phase's output, so `KNOWN_OIDC_SCOPES` below
 *     is deliberately its own, separate vocabulary. Reconciling the two
 *     (e.g. deriving discovery's list from this one) is future scope, not
 *     a 2D task.
 *
 * WHY THERE ARE TWO DIFFERENT "SCOPE IS BAD" REASONS
 * The roadmap's 2D task list distinguishes three things a requested scope
 * can be doing wrong: not permitted for this client ("Allowed-Scope
 * Check", 2d-b), not a scope this provider recognizes at all ("Unknown
 * Scope Handling", 2d-c), and both still need one consistent result shape
 * ("Scope Error Contract", 2d-d). The roadmap's global error model
 * (section 4) has exactly one relevant OAuth-facing code for both —
 * `invalid_scope` — so that's the only `error` value this file's result
 * carries. But "this client isn't allowed 'email'" and "'wallet' isn't a
 * scope this provider even has a definition for" are different failures
 * for logging/debugging purposes (and for 2D-e's test matrix, which asks
 * for "unknown scope" and "disallowed scope" as separate cases) — so the
 * result also carries an internal-only `reason` alongside the public
 * `invalid_scope` code, exactly the same "one public code, richer
 * internal detail" shape Phase 2C used for `invalid_client`.
 */

import type { OidcClient } from "./oidc-clients";
import { logger } from "./logger";

/**
 * The fixed vocabulary of scope values this OIDC provider defines
 * semantics for in Season 1. `"openid"` is the OIDC-mandatory scope;
 * `"profile"`/`"email"` are the two Phase 2B already seeded into every
 * first-party client's `allowed_scopes` (see
 * `scripts/src/seed-oidc-clients.ts`'s `AYZEN_FIRST_PARTY_SCOPES`). A
 * scope outside this list is "unknown" regardless of what any individual
 * client's registry row happens to say — a client's `allowedScopes`
 * narrows this list further per-client, it can't widen it.
 */
export const KNOWN_OIDC_SCOPES = ["openid", "profile", "email"] as const;
export type KnownOidcScope = (typeof KNOWN_OIDC_SCOPES)[number];

function isKnownOidcScope(scope: string): scope is KnownOidcScope {
  return (KNOWN_OIDC_SCOPES as readonly string[]).includes(scope);
}

/**
 * 2D-a: Scope Parser.
 *
 * Normalizes the raw `scope` request parameter — per OIDC Core 1.0
 * §3.1.2.1, a space-delimited, case-sensitive list of strings — into a
 * clean, ordered, de-duplicated array of individual scope tokens:
 *   - `undefined`/`null`/empty/whitespace-only input -> `[]`, never a
 *     thrown error. An absent or empty scope request is a valid (if
 *     unusual) input to THIS layer; whether Phase 3's authorization
 *     endpoint additionally requires "openid" to be present is that
 *     phase's concern (request-shape validation, not client-scope
 *     permission checking), not this one's.
 *   - runs of extra whitespace between/around tokens collapse away
 *     (`"openid   profile"` / `"  openid profile  "` -> the same
 *     `["openid", "profile"]`), so a caller downstream of this function
 *     never has to re-trim or re-split.
 *   - a repeated token appears once, in its first-seen position — a
 *     client shouldn't get more or fewer effective scopes just because
 *     it (or a buggy client SDK) repeated one in the request string.
 *
 * Pure and DB-free — exported on its own so 2D-e's tests (and later,
 * 2E-a's unified validator) can exercise normalization independently of
 * the allowed/known-scope checks below.
 */
export function parseScopeString(rawScope: string | null | undefined): string[] {
  if (!rawScope) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of rawScope.split(/\s+/)) {
    if (token.length === 0) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/** 2D-d: consistent success/failure shape for scope validation. */
export type OidcScopeValidationResult =
  | { ok: true; scopes: string[] }
  | {
      ok: false;
      error: "invalid_scope";
      /** Internal-only detail — never a second public OAuth error code, see file header. */
      reason: "unknown_scope" | "disallowed_scope";
      scope: string;
    };

/**
 * 2D-b/2D-c: Allowed-Scope Check / Unknown Scope Handling.
 *
 * Parses `rawScope` (2D-a) and validates every resulting token against,
 * in order:
 *   1. `KNOWN_OIDC_SCOPES` — is this a scope value the provider defines
 *      at all? If not: `reason: "unknown_scope"` (2D-c).
 *   2. `client.allowedScopes` — is this specific client's registry row
 *      permitted to request it? If not: `reason: "disallowed_scope"`
 *      (2D-b).
 *
 * Fails fast on the first offending token (in request order) rather than
 * collecting every bad token — matches Phase 2C's `validateOidcRedirectUri`
 * precedent of one clear failure per call rather than an aggregate error
 * list, and keeps the result shape (one `scope` field) simple.
 *
 * An empty (or fully-whitespace/absent) `rawScope` parses to `[]`, which
 * trivially satisfies both checks with nothing to iterate — see
 * `parseScopeString()`'s doc comment for why that is not itself treated
 * as an error at this layer.
 */
export function validateOidcScopes(client: OidcClient, rawScope: string | null | undefined): OidcScopeValidationResult {
  const scopes = parseScopeString(rawScope);

  for (const scope of scopes) {
    if (!isKnownOidcScope(scope)) {
      logger.warn({ clientId: client.clientId, scope }, "[oidc-scope-validation] unknown scope rejected");
      return { ok: false, error: "invalid_scope", reason: "unknown_scope", scope };
    }
    if (!client.allowedScopes.includes(scope)) {
      logger.warn({ clientId: client.clientId, scope }, "[oidc-scope-validation] scope not allowed for this client, rejected");
      return { ok: false, error: "invalid_scope", reason: "disallowed_scope", scope };
    }
  }

  return { ok: true, scopes };
}
