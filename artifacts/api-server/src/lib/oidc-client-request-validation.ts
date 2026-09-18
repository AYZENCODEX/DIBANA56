/**
 * lib/oidc-client-request-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2E: Unified Client Validation.
 *
 * Composes the three checks Phase 2C/2D already built — nothing new is
 * validated here that wasn't already validated by one of those two files:
 *   - `validateOidcClientId()`      (2C-a, ./oidc-client-validation)
 *   - `validateOidcRedirectUri()`   (2C-b/2C-c, ./oidc-client-validation)
 *   - `validateOidcScopes()`        (2D-b/2D-c, ./oidc-scope-validation)
 *
 * 2E-a: Validation Service
 * `validateOidcClientRequest(clientId, redirectUri, rawScope)` is the
 * `validateClientRequest(client_id, redirect_uri, scope)` interface the
 * roadmap's 2E-a example names — same three positional inputs, same
 * order.
 *
 * 2E-b: Result Model
 * `OidcClientRequestValidationResult`'s success case is exactly the
 * roadmap's four listed fields: `client`, the validated `redirectUri`,
 * the validated `scopes`, and (via the discriminated union) a
 * status/error on failure. It's a direct union of the three underlying
 * checks' own failure shapes — deliberately NOT a fourth, differently-
 * shaped error type. A caller that already knows how to branch on
 * `invalid_client` / `invalid_redirect_uri` / `invalid_scope` from the
 * individual 2C/2D functions needs to learn nothing new to branch on this
 * unified result too.
 *
 * ORDER OF CHECKS: client, then redirect_uri, then scope — matching the
 * order client_id/redirect_uri/scope appear in the roadmap's own 2E-a
 * example, and (more importantly) the OAuth/OIDC security rationale
 * `./oidc-client-validation.ts`'s file header already documents: the
 * server must confirm WHICH client is asking and WHERE it's allowed to
 * redirect back to before it's safe to reason about anything else in the
 * request, `scope` included. A request with both a bad redirect_uri and
 * a bad scope reports `invalid_redirect_uri`, not `invalid_scope` — see
 * 2E-d's "fail-fast ordering" tests below.
 *
 * SPLIT: DB-DEPENDENT ENTRYPOINT vs. PURE COMPOSITION
 * Same split `lib/jwt-keys.ts` uses between its pure `mergeVerificationKeys()`
 * and its DB-hitting `fetchDbVerificationKeys()`, and the same one
 * `oidc-clients.ts` documents for itself:
 *   - `validateOidcClientRequestForClient(client, redirectUri, rawScope)`
 *     is PURE — it takes an already-resolved `OidcClient`, so it never
 *     touches the database and is directly unit-testable (2E-d's full
 *     "all client + redirect + scope combinations" matrix runs entirely
 *     against this function).
 *   - `validateOidcClientRequest(clientId, redirectUri, rawScope)` is the
 *     public, DB-touching entrypoint matching the roadmap's exact
 *     signature: it resolves `clientId` via 2C-a's `validateOidcClientId()`
 *     (the one DB call in this whole composition) and, only on success,
 *     delegates everything else to the pure function above. Its own
 *     correctness therefore rests entirely on two already-verified pieces
 *     (2C-a's lookup, tested in 2C-e; this file's pure composition,
 *     tested in 2E-d below) plus four lines that thread one into the
 *     other — see CHANGES_OIDC_UNIFIED_CLIENT_VALIDATION_PHASE2E.md for
 *     why that residual isn't independently executed in this sandbox.
 *
 * 2E-c: CONSUMER CONTRACT
 * No route exists yet — `/oidc/authorize` is Phase 3's job, per every
 * earlier 2A/2C/2D file's own "nothing wired into a route yet" note. What
 * 2E-c asks for is that Phase 3 will be able to consume ONE interface
 * instead of three separate ones; this is what that call site will look
 * like once Phase 3 exists:
 *
 *   const result = await validateOidcClientRequest(
 *     req.query.client_id,
 *     req.query.redirect_uri,
 *     req.query.scope,
 *   );
 *   if (!result.ok) {
 *     switch (result.error) {
 *       case "invalid_client":
 *         // no verified redirect target — render an error page directly,
 *         // do not redirect the user-agent anywhere.
 *         break;
 *       case "invalid_redirect_uri":
 *         // same — do not redirect (see ./oidc-client-validation.ts).
 *         break;
 *       case "invalid_scope":
 *         // client + redirect_uri ARE verified here — safe to redirect
 *         // back to result's (not-yet-validated-here) redirect_uri with
 *         // `?error=invalid_scope`, per the roadmap's global error model.
 *         break;
 *     }
 *     return;
 *   }
 *   // result.client / result.redirectUri / result.scopes are all ready
 *   // to hand to whatever Phase 3 builds next (authorization code issuance).
 *
 * Nothing above is new logic — it's a worked example proving the shape
 * this file already exports is call-ready, not a route file.
 */

import { validateOidcClientId, validateOidcRedirectUri, type OidcClient } from "./oidc-client-validation";
import { validateOidcScopes } from "./oidc-scope-validation";

/**
 * 2E-b: unified result model. A direct union of the three underlying
 * checks' failure shapes (see file header) plus one success shape
 * carrying exactly the four fields the roadmap's 2E-b task names.
 */
export type OidcClientRequestValidationResult =
  | { ok: true; client: OidcClient; redirectUri: string; scopes: string[] }
  | { ok: false; error: "invalid_client" }
  | { ok: false; error: "invalid_redirect_uri" }
  | {
      ok: false;
      error: "invalid_scope";
      reason: "unknown_scope" | "disallowed_scope";
      scope: string;
    };

/**
 * Pure composition — see file header. Runs 2C's redirect-uri check, then
 * (only if that passes) 2D's scope check, against an already-resolved
 * client. No DB access, no async.
 */
export function validateOidcClientRequestForClient(
  client: OidcClient,
  redirectUri: string,
  rawScope: string | null | undefined,
): OidcClientRequestValidationResult {
  const redirectResult = validateOidcRedirectUri(client, redirectUri);
  if (!redirectResult.ok) return redirectResult;

  const scopeResult = validateOidcScopes(client, rawScope);
  if (!scopeResult.ok) return scopeResult;

  return { ok: true, client, redirectUri: redirectResult.redirectUri, scopes: scopeResult.scopes };
}

/**
 * 2E-a: the unified `validateClientRequest(client_id, redirect_uri, scope)`
 * interface — the public, DB-touching entrypoint. See file header for the
 * DB-dependent/pure split this wraps.
 */
export async function validateOidcClientRequest(
  clientId: string,
  redirectUri: string,
  rawScope: string | null | undefined,
): Promise<OidcClientRequestValidationResult> {
  const clientResult = await validateOidcClientId(clientId);
  if (!clientResult.ok) return clientResult;

  return validateOidcClientRequestForClient(clientResult.client, redirectUri, rawScope);
}
