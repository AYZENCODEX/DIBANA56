/**
 * lib/oidc-consent-scope-superset.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7e: Consent Re-Prompt Policy (scope creep
 * detection).
 *
 * `ayzen-oidc-roadmap-season4-5-v1.md`'s own 7e text, verbatim: "একটা
 * client যদি আগে `profile` scope-এর জন্য consent পেয়ে থাকে, পরে `email`
 * scope-ও চায় — existing granted_scopes-এর superset না হলে আবার consent
 * screen দেখানো (শুধু নতুন scope-গুলো হাইলাইট করে) ... Granted scope-এর
 * তুলনা pure function হিসেবে লেখা (7a-এর ডেটার উপর), যাতে টেস্ট করা যায়
 * লাইভ DB ছাড়াই — এই roadmap-এর নিজের established 'pure calculation vs
 * effectful wrapper' discipline."
 *
 * This file IS that pure function — plain `string[]` in, a plain result
 * object out, no DB access, no `OidcClient`/`StoredOidcUserConsent` types
 * imported. Same split `oidc-consent-scope-copy.ts`'s `describeConsentScopes()`
 * already keeps for the identical reason: unit-testable
 * (`scripts/src/test-oidc-consent-scope-superset.ts`) and reusable by
 * both the backend (7e's own two call sites below) and, if ever needed, a
 * client-side preview, without either depending on a live DB.
 *
 * Scope discipline (this is 7e, not 7a/7b/7c/7d):
 *   - Comparison ONLY — this file does not decide who gets called with
 *     what, does not read `oidc_user_consents`, and does not touch
 *     `oidc-authorize.ts` or `oidc-consent.ts` directly. Those two files'
 *     own updates (this same pass) are what CALL this function; see each
 *     one's own comment for exactly where.
 *   - `isSuperset` answers exactly one question — "does the existing
 *     grant already cover every scope THIS request is asking for" — not
 *     "are the two scope sets equal." A client that previously got
 *     `profile` and now asks for just `openid` is still a superset match
 *     (nothing NEW is being asked for); a client asking for `profile` AND
 *     `email` when only `profile` was granted is not (`email` is new).
 *     This asymmetry is deliberate: shrinking what's requested should
 *     never force a re-prompt, only growing it should.
 *   - `newScopes` preserves the REQUESTED order (not the granted order,
 *     not alphabetical) — the consent screen (7b/7e's own UI update)
 *     renders scopes in the order the client asked for them, same as
 *     `describeConsentScopes()` already does for a first-time grant; a
 *     re-prompt's highlighting should not reorder that.
 */

/** Result of comparing an existing grant against a fresh request's scopes. */
export interface ScopeCreepResult {
  /**
   * `true` when every scope in `requestedScopes` is already present in
   * `grantedScopes` — the existing consent is sufficient, no re-prompt
   * needed (7c's consent gate skips straight to code issuance). `false`
   * means at least one requested scope is new — a consent screen must be
   * shown, with `newScopes` telling it what to highlight.
   */
  isSuperset: boolean;
  /**
   * Scopes present in `requestedScopes` but not in `grantedScopes`, in
   * `requestedScopes`' own order. Always `[]` when `isSuperset` is `true`
   * — never a partial/stale list callers need to re-derive themselves.
   */
  newScopes: string[];
}

/**
 * 7e's own pure comparison. `grantedScopes` is normally an existing
 * `StoredOidcUserConsent.grantedScopes` (or `[]` when there is no active
 * consent at all — the "never asked" case collapses to exactly the same
 * result a real empty grant would, every requested scope reads as new,
 * which is correct: with nothing granted yet, everything IS new).
 * `requestedScopes` is normally the current `/oidc/authorize` request's
 * already-validated `OidcAuthorizeRequestValidationResult.scopes`.
 *
 * Order of the two parameters matters and is NOT symmetric — this is
 * "does GRANTED cover REQUESTED," not a generic set-difference utility.
 */
export function evaluateScopeCreep(grantedScopes: string[], requestedScopes: string[]): ScopeCreepResult {
  const grantedSet = new Set(grantedScopes);
  const newScopes = requestedScopes.filter((scope) => !grantedSet.has(scope));
  return { isSuperset: newScopes.length === 0, newScopes };
}
