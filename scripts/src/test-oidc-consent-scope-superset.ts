/**
 * scripts/src/test-oidc-consent-scope-superset.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7e: Consent Re-Prompt Policy — tests for
 * `artifacts/api-server/src/lib/oidc-consent-scope-superset.ts`'s
 * `evaluateScopeCreep()`.
 *
 * Same shape as scripts/src/test-oidc-scope-validation.ts (2D-e): DB-free,
 * runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-consent-scope-superset.ts`.
 * `evaluateScopeCreep()` is pure (no `@workspace/db` import anywhere in
 * `oidc-consent-scope-superset.ts`, plain `string[]` params), so — same as
 * that file's own note — there is no DB-dependent gap to leave uncovered
 * here; every behavior the function has gets exercised directly.
 *
 * Run: npx tsx scripts/src/test-oidc-consent-scope-superset.ts
 */
import assert from "node:assert/strict";
import { evaluateScopeCreep } from "../../artifacts/api-server/src/lib/oidc-consent-scope-superset";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("evaluateScopeCreep() — no scope creep (existing grant already covers the request)");

test("identical scope sets — a superset, nothing new", () => {
  const result = evaluateScopeCreep(["openid", "profile"], ["openid", "profile"]);
  assert.equal(result.isSuperset, true);
  assert.deepEqual(result.newScopes, []);
});

test("requesting a NARROWER set than what's granted is still a superset match", () => {
  // 7e's own asymmetry: shrinking what's requested never forces a re-prompt.
  const result = evaluateScopeCreep(["openid", "profile", "email"], ["openid"]);
  assert.equal(result.isSuperset, true);
  assert.deepEqual(result.newScopes, []);
});

test("requesting the exact same single scope already granted", () => {
  const result = evaluateScopeCreep(["openid"], ["openid"]);
  assert.equal(result.isSuperset, true);
  assert.deepEqual(result.newScopes, []);
});

test("requesting an empty scope set is always a superset match, regardless of what was granted", () => {
  assert.equal(evaluateScopeCreep(["openid", "profile"], []).isSuperset, true);
  assert.equal(evaluateScopeCreep([], []).isSuperset, true);
});

console.log("evaluateScopeCreep() — scope creep (re-prompt required)");

test("classic case from the roadmap text — granted 'profile', now also wants 'email'", () => {
  const result = evaluateScopeCreep(["openid", "profile"], ["openid", "profile", "email"]);
  assert.equal(result.isSuperset, false);
  assert.deepEqual(result.newScopes, ["email"]);
});

test("everything requested is new — the 'never granted anything before' shape", () => {
  const result = evaluateScopeCreep([], ["openid", "profile"]);
  assert.equal(result.isSuperset, false);
  assert.deepEqual(result.newScopes, ["openid", "profile"]);
});

test("multiple new scopes are all reported, in REQUEST order (not granted order, not alphabetical)", () => {
  const result = evaluateScopeCreep(["profile"], ["email", "profile", "openid"]);
  assert.equal(result.isSuperset, false);
  assert.deepEqual(result.newScopes, ["email", "openid"]);
});

test("partial overlap — some requested scopes already granted, one is not", () => {
  const result = evaluateScopeCreep(["openid", "email"], ["openid", "profile", "email"]);
  assert.equal(result.isSuperset, false);
  assert.deepEqual(result.newScopes, ["profile"]);
});

console.log("evaluateScopeCreep() — 'never asked' collapses to the same shape as an empty grant");

test("null-consent case (caller passes [] for 'no active consent') behaves exactly like an empty grant", () => {
  // routes/oidc-authorize.ts and routes/oidc-consent.ts both do
  // `consent?.grantedScopes ?? []` — this proves that coalescing is safe.
  const noConsent = evaluateScopeCreep([], ["openid", "profile"]);
  const emptyGrant = evaluateScopeCreep([], ["openid", "profile"]);
  assert.deepEqual(noConsent, emptyGrant);
});

console.log("All oidc-consent-scope-superset tests passed.");
