/**
 * scripts/src/test-oidc-client-request-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2E-d: Integration Tests for
 * `artifacts/api-server/src/lib/oidc-client-request-validation.ts` (2E-a..2E-c).
 *
 * Same shape as scripts/src/test-oidc-client-validation.ts (2C-e) and
 * scripts/src/test-oidc-scope-validation.ts (2D-e): DB-free, runnable
 * anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-client-request-validation.ts`.
 *
 * Exercises `validateOidcClientRequestForClient()` (the pure composition
 * half of 2E-a) directly, NOT `validateOidcClientRequest()` (the public,
 * DB-touching entrypoint) — see that file's header for why the wrapper
 * itself is hand-verified instead (it is four lines: resolve the client
 * via 2C-a's already-tested `validateOidcClientId()`, then delegate
 * everything tested here to the pure function). Every combination this
 * roadmap's 2E-d asks for ("all client + redirect + scope combinations")
 * is reachable through the pure function, since the only thing the DB
 * step contributes is *which* `OidcClient` object gets passed in.
 *
 * Matrix covered:
 *   - all three checks pass                              -> ok
 *   - redirect fails, scope would also have failed        -> invalid_redirect_uri (fail-fast ordering)
 *   - redirect fails, scope would have passed              -> invalid_redirect_uri
 *   - redirect passes, scope unknown                       -> invalid_scope / unknown_scope
 *   - redirect passes, scope disallowed for this client     -> invalid_scope / disallowed_scope
 *   - redirect passes, empty/no scope requested             -> ok, scopes: []
 *   - multiple registered redirect_uris, correct one chosen  -> ok
 *
 * Run: npx tsx scripts/src/test-oidc-client-request-validation.ts
 */
import assert from "node:assert/strict";
import {
  validateOidcClientRequestForClient,
  type OidcClientRequestValidationResult,
} from "../../artifacts/api-server/src/lib/oidc-client-request-validation";
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

function fakeClient(opts: { redirectUris: string[]; allowedScopes: string[] }): OidcClient {
  return {
    id: 1,
    clientId: "sylo",
    clientSecretHash: null,
    // Phase 8a/8c: not exercised by anything this test calls — filled in
    // only so this fixture still satisfies `OidcClient`'s full shape.
    clientName: null,
    registrationStatus: "approved",
    redirectUris: opts.redirectUris,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    allowedScopes: opts.allowedScopes,
    isFirstParty: true,
    // Phase 8e (migration 092): not exercised by anything this test calls — filled in only so this fixture still satisfies OidcClient's full shape.
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function assertOk(
  result: OidcClientRequestValidationResult,
  expectedRedirectUri: string,
  expectedScopes: string[],
): void {
  assert.equal(result.ok, true);
  const ok = result as { ok: true; client: OidcClient; redirectUri: string; scopes: string[] };
  assert.equal(ok.redirectUri, expectedRedirectUri);
  assert.deepEqual(ok.scopes, expectedScopes);
}

function assertInvalidRedirectUri(result: OidcClientRequestValidationResult): void {
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; error: string }).error, "invalid_redirect_uri");
}

function assertInvalidScope(
  result: OidcClientRequestValidationResult,
  expectedReason: "unknown_scope" | "disallowed_scope",
  expectedScope: string,
): void {
  assert.equal(result.ok, false);
  const failure = result as { ok: false; error: string; reason: string; scope: string };
  assert.equal(failure.error, "invalid_scope");
  assert.equal(failure.reason, expectedReason);
  assert.equal(failure.scope, expectedScope);
}

const REGISTERED_REDIRECT = "https://sylo.ayzen.tech/oidc/callback";

console.log("validateOidcClientRequestForClient() — all checks pass");

test("valid redirect + valid scope subset -> ok with both validated fields populated", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid", "profile", "email"] });
  const result = validateOidcClientRequestForClient(client, REGISTERED_REDIRECT, "openid profile");
  assertOk(result, REGISTERED_REDIRECT, ["openid", "profile"]);
});

test("valid redirect + no scope requested -> ok with an empty scopes array", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid"] });
  const result = validateOidcClientRequestForClient(client, REGISTERED_REDIRECT, undefined);
  assertOk(result, REGISTERED_REDIRECT, []);
});

test("multiple registered redirect_uris — the matching one is validated and returned", () => {
  const altRedirect = "http://localhost:5173/oidc/callback";
  const client = fakeClient({
    redirectUris: [REGISTERED_REDIRECT, altRedirect],
    allowedScopes: ["openid"],
  });
  const result = validateOidcClientRequestForClient(client, altRedirect, "openid");
  assertOk(result, altRedirect, ["openid"]);
});

console.log("validateOidcClientRequestForClient() — redirect_uri fails first (fail-fast ordering)");

test("bad redirect_uri + a scope that would ALSO have failed -> reports invalid_redirect_uri, not invalid_scope", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid"] });
  const result = validateOidcClientRequestForClient(client, "https://evil.example.com/callback", "not_a_real_scope");
  assertInvalidRedirectUri(result);
});

test("bad redirect_uri + a scope that WOULD have passed -> still invalid_redirect_uri", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid"] });
  const result = validateOidcClientRequestForClient(client, "https://evil.example.com/callback", "openid");
  assertInvalidRedirectUri(result);
});

test("near-match redirect_uri (path difference) still fails, scope is never reached", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid"] });
  const result = validateOidcClientRequestForClient(client, `${REGISTERED_REDIRECT}/extra`, "openid");
  assertInvalidRedirectUri(result);
});

console.log("validateOidcClientRequestForClient() — redirect_uri passes, scope fails");

test("valid redirect + unknown scope -> invalid_scope / unknown_scope", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid"] });
  const result = validateOidcClientRequestForClient(client, REGISTERED_REDIRECT, "openid super_admin");
  assertInvalidScope(result, "unknown_scope", "super_admin");
});

test("valid redirect + known but disallowed scope -> invalid_scope / disallowed_scope", () => {
  const client = fakeClient({ redirectUris: [REGISTERED_REDIRECT], allowedScopes: ["openid"] });
  const result = validateOidcClientRequestForClient(client, REGISTERED_REDIRECT, "openid email");
  assertInvalidScope(result, "disallowed_scope", "email");
});

console.log("All oidc-client-request-validation tests passed.");
