/**
 * scripts/src/test-oidc-scope-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2D-e: Scope Tests for
 * `artifacts/api-server/src/lib/oidc-scope-validation.ts` (2D-a..2D-d).
 *
 * Same shape as scripts/src/test-oidc-client-validation.ts (2C-e): DB-free,
 * runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-scope-validation.ts`. Both functions under
 * test here are pure (no `@workspace/db` import anywhere in
 * `oidc-scope-validation.ts`), unlike 2C-a's `validateOidcClientId`, so
 * there is no DB-dependent gap to note this time — every function this
 * file exports gets exercised directly.
 *
 * Covers the roadmap's 2D-e list exactly:
 *   - "valid subset"          -> requested scopes all known + all allowed.
 *   - "unknown scope"         -> a requested scope outside KNOWN_OIDC_SCOPES.
 *   - "disallowed scope"      -> a requested scope that IS known but not
 *                                in this particular client's allowedScopes.
 *   - "empty/default behavior"-> no scope requested at all (undefined,
 *                                null, empty string, whitespace-only).
 * Plus `parseScopeString()`'s own normalization behavior (2D-a), since
 * `validateOidcScopes()`'s correctness depends on it.
 *
 * Run: npx tsx scripts/src/test-oidc-scope-validation.ts
 */
import assert from "node:assert/strict";
import {
  parseScopeString,
  validateOidcScopes,
  KNOWN_OIDC_SCOPES,
  type OidcScopeValidationResult,
} from "../../artifacts/api-server/src/lib/oidc-scope-validation";
import type { OidcClient } from "../../artifacts/api-server/src/lib/oidc-clients";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function fakeClient(allowedScopes: string[]): OidcClient {
  return {
    id: 1,
    clientId: "sylo",
    clientSecretHash: null,
    // Phase 8a/8c: not exercised by anything this test calls — filled in
    // only so this fixture still satisfies `OidcClient`'s full shape.
    clientName: null,
    registrationStatus: "approved",
    redirectUris: ["https://sylo.ayzen.tech/oidc/callback"],
    postLogoutRedirectUris: ["https://sylo.ayzen.tech/"],
    backchannelLogoutUri: null,
    allowedScopes,
    isFirstParty: true,
    // Phase 8e (migration 092): not exercised by anything this test calls — filled in only so this fixture still satisfies OidcClient's full shape.
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function assertOk(result: OidcScopeValidationResult, expectedScopes: string[]): void {
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; scopes: string[] }).scopes, expectedScopes);
}

function assertRejected(
  result: OidcScopeValidationResult,
  expectedReason: "unknown_scope" | "disallowed_scope",
  expectedScope: string,
): void {
  assert.equal(result.ok, false);
  const failure = result as { ok: false; error: "invalid_scope"; reason: string; scope: string };
  assert.equal(failure.error, "invalid_scope");
  assert.equal(failure.reason, expectedReason);
  assert.equal(failure.scope, expectedScope);
}

console.log("parseScopeString() — normalization (2D-a)");

test("splits a normal space-delimited scope string", () => {
  assert.deepEqual(parseScopeString("openid profile email"), ["openid", "profile", "email"]);
});

test("collapses runs of extra whitespace between tokens", () => {
  assert.deepEqual(parseScopeString("openid    profile"), ["openid", "profile"]);
});

test("trims leading/trailing whitespace around the whole string", () => {
  assert.deepEqual(parseScopeString("  openid profile  "), ["openid", "profile"]);
});

test("de-duplicates a repeated token, keeping its first-seen position", () => {
  assert.deepEqual(parseScopeString("openid profile openid email profile"), ["openid", "profile", "email"]);
});

test("undefined/null/empty/whitespace-only input all parse to []", () => {
  assert.deepEqual(parseScopeString(undefined), []);
  assert.deepEqual(parseScopeString(null), []);
  assert.deepEqual(parseScopeString(""), []);
  assert.deepEqual(parseScopeString("   "), []);
});

console.log("validateOidcScopes() — valid subset (2D-b)");

test("valid subset — every requested scope is known and allowed for this client", () => {
  const client = fakeClient(["openid", "profile", "email"]);
  assertOk(validateOidcScopes(client, "openid profile"), ["openid", "profile"]);
});

test("valid subset — a client allowed only 'openid' requesting exactly 'openid'", () => {
  const client = fakeClient(["openid"]);
  assertOk(validateOidcScopes(client, "openid"), ["openid"]);
});

test("valid subset — single-scope request out of a wider allowed set", () => {
  const client = fakeClient(["openid", "profile", "email"]);
  assertOk(validateOidcScopes(client, "email"), ["email"]);
});

console.log("validateOidcScopes() — unknown scope (2D-c)");

test("unknown scope — a scope outside KNOWN_OIDC_SCOPES is rejected even if the client's registry row lists it", () => {
  // A client's allowedScopes should never be able to widen the known-scope
  // vocabulary — this simulates a bad/legacy registry row to prove that.
  const client = fakeClient(["openid", "wallet"]);
  assertRejected(validateOidcScopes(client, "openid wallet"), "unknown_scope", "wallet");
});

test("unknown scope — a made-up scope with no registry involvement at all", () => {
  const client = fakeClient(["openid"]);
  assertRejected(validateOidcScopes(client, "super_admin"), "unknown_scope", "super_admin");
});

console.log("validateOidcScopes() — disallowed scope (2D-b)");

test("disallowed scope — known scope, but not in this client's allowedScopes", () => {
  const client = fakeClient(["openid"]);
  assertRejected(validateOidcScopes(client, "openid email"), "disallowed_scope", "email");
});

test("disallowed scope — client with an empty allowedScopes rejects everything", () => {
  const client = fakeClient([]);
  assertRejected(validateOidcScopes(client, "openid"), "disallowed_scope", "openid");
});

test("fails fast on the first offending token in request order, not necessarily the only bad one", () => {
  const client = fakeClient(["openid"]);
  // "wallet" (unknown) comes before "email" (disallowed) in the request —
  // the unknown one should surface first.
  assertRejected(validateOidcScopes(client, "wallet email"), "unknown_scope", "wallet");
});

console.log("validateOidcScopes() — empty/default behavior (2D-e)");

test("empty/default — no scope requested at all (undefined) is a valid empty request", () => {
  const client = fakeClient(["openid", "profile", "email"]);
  assertOk(validateOidcScopes(client, undefined), []);
});

test("empty/default — empty string scope is a valid empty request", () => {
  const client = fakeClient(["openid"]);
  assertOk(validateOidcScopes(client, ""), []);
});

test("empty/default — whitespace-only scope is a valid empty request", () => {
  const client = fakeClient(["openid"]);
  assertOk(validateOidcScopes(client, "   "), []);
});

test("empty/default — a client with no allowedScopes at all still accepts an empty request", () => {
  const client = fakeClient([]);
  assertOk(validateOidcScopes(client, undefined), []);
});

console.log(`KNOWN_OIDC_SCOPES sanity — currently: ${KNOWN_OIDC_SCOPES.join(", ")}`);
assert.deepEqual([...KNOWN_OIDC_SCOPES], ["openid", "profile", "email"]);

console.log("All oidc-scope-validation tests passed.");
