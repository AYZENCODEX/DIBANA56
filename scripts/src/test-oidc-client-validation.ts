/**
 * scripts/src/test-oidc-client-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 2C-e: Validation Tests for
 * `artifacts/api-server/src/lib/oidc-client-validation.ts` (2C-a..2C-d).
 *
 * Same shape as scripts/src/test-oidc-clients.ts (2A-d): DB-free, runnable
 * anywhere with nothing but `npx tsx scripts/src/test-oidc-client-validation.ts`.
 *
 * Covers the roadmap's 2C-e "complete negative and positive test matrix":
 *   - 2C-b/2C-c (`validateOidcRedirectUri`, pure function, directly tested):
 *       positive — exact match against a single or multi-entry registry.
 *       negative — path / scheme / host / subdomain-confusable host /
 *                  query / trailing-slash / empty / non-registered-at-all
 *                  differences, each rejected as `invalid_redirect_uri`.
 *   - 2C-a (`validateOidcClientId`) is NOT executed here — same limitation
 *     already noted in Phase 2A-d ("duplicate client_id" untestable
 *     DB-side) and Phase 2B-f (no DATABASE_URL/node_modules in this
 *     environment): `validateOidcClientId()` calls `getOidcClientById()`,
 *     which needs a live `@workspace/db` pool. Its "unknown client_id"
 *     branch is instead hand-verified below by re-reading its 5-line
 *     implementation rather than executed:
 *       if (!client) { ...; return { ok: false, error: "invalid_client" }; }
 *       return { ok: true, client };
 *     `getOidcClientById()` (2A-c) already returns `null` for both "no
 *     such row" and "DB read failed" (its own file's doc comment confirms
 *     this) — so both collapse to `invalid_client` here by construction,
 *     with no additional branch that could diverge from that guarantee.
 *
 * Run: npx tsx scripts/src/test-oidc-client-validation.ts
 */
import assert from "node:assert/strict";
import {
  validateOidcRedirectUri,
  validateOidcClientRegistrationAccessToken,
  type OidcRedirectUriValidationResult,
  type OidcClientRegistrationAccessTokenValidationResult,
} from "../../artifacts/api-server/src/lib/oidc-client-validation";
import { hashClientSecret } from "../../artifacts/api-server/src/lib/oidc-token-client-auth";
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

function fakeClient(redirectUris: string[], overrides: Partial<OidcClient> = {}): OidcClient {
  return {
    id: 1,
    clientId: "sylo",
    clientSecretHash: null,
    // Phase 8a/8c: not exercised by anything this test calls — filled in
    // only so this fixture still satisfies `OidcClient`'s full shape.
    clientName: null,
    registrationStatus: "approved",
    redirectUris,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    allowedScopes: ["openid", "profile", "email"],
    isFirstParty: true,
    // Phase 8e (migration 092): null by default — overridden per-test below
    // for the new validateOidcClientRegistrationAccessToken() coverage.
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function assertOk(result: OidcRedirectUriValidationResult, expectedRedirectUri: string): void {
  assert.equal(result.ok, true);
  assert.equal((result as { ok: true; redirectUri: string }).redirectUri, expectedRedirectUri);
}

function assertRejected(result: OidcRedirectUriValidationResult): void {
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; error: "invalid_redirect_uri" }).error, "invalid_redirect_uri");
}

console.log("validateOidcRedirectUri() — positive matches (2C-b)");

test("valid client — exact match against the single registered redirect_uri", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  const result = validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc/callback");
  assertOk(result, "https://sylo.ayzen.tech/oidc/callback");
});

test("valid client — exact match picked out of multiple registered redirect_uris", () => {
  const client = fakeClient([
    "https://sylo.ayzen.tech/oidc/callback",
    "https://sylo.ayzen.tech/oidc/callback/alt",
    "http://localhost:5173/oidc/callback",
  ]);
  const result = validateOidcRedirectUri(client, "http://localhost:5173/oidc/callback");
  assertOk(result, "http://localhost:5173/oidc/callback");
});

console.log("validateOidcRedirectUri() — near-match / mismatch rejection (2C-c)");

test("invalid redirect — path difference (extra path segment) is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc/callback/extra"));
});

test("invalid redirect — path difference (missing trailing segment) is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc"));
});

test("invalid redirect — trailing slash difference is rejected (no normalization)", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc/callback/"));
});

test("invalid redirect — scheme difference (http vs https) is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "http://sylo.ayzen.tech/oidc/callback"));
});

test("invalid redirect — host difference (unrelated host) is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://evil.example.com/oidc/callback"));
});

test("invalid redirect — host difference (subdomain-confusable superstring host) is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech.evil.com/oidc/callback"));
});

test("invalid redirect — host difference (sibling first-party client) is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://ryft.ayzen.tech/oidc/callback"));
});

test("invalid redirect — query string added where none is registered is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc/callback?x=1"));
});

test("invalid redirect — query string value difference is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback?env=prod"]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc/callback?env=staging"));
});

test("invalid redirect — empty string is rejected", () => {
  const client = fakeClient(["https://sylo.ayzen.tech/oidc/callback"]);
  assertRejected(validateOidcRedirectUri(client, ""));
});

test("invalid redirect — client with no registered redirect_uris rejects everything", () => {
  const client = fakeClient([]);
  assertRejected(validateOidcRedirectUri(client, "https://sylo.ayzen.tech/oidc/callback"));
});

console.log("All oidc-client-validation tests passed.");

// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 4, Phase 8e: tests for
// validateOidcClientRegistrationAccessToken().
//
// hashClientSecret() is imported directly (it's a pure SHA-256 hex hash,
// no DB) purely to construct fixtures — these tests never call it as
// "the thing under test," only to produce a realistic
// registrationAccessTokenHash the way lib/oidc-client-registration.ts's
// createOidcClient() would have at issuance time.

function assertTokenOk(result: OidcClientRegistrationAccessTokenValidationResult): void {
  assert.equal(result.ok, true);
}

function assertTokenRejected(result: OidcClientRegistrationAccessTokenValidationResult): void {
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; error: "invalid_token" }).error, "invalid_token");
}

console.log("validateOidcClientRegistrationAccessToken() — positive");

test("the correct plaintext token, hashed the same way as at issuance, verifies", () => {
  const plaintext = "test-registration-access-token-value";
  const client = fakeClient(["https://a.example/cb"], { registrationAccessTokenHash: hashClientSecret(plaintext) });
  assertTokenOk(validateOidcClientRegistrationAccessToken(client, plaintext));
});

console.log("validateOidcClientRegistrationAccessToken() — negative");

test("a wrong token is rejected", () => {
  const client = fakeClient(["https://a.example/cb"], {
    registrationAccessTokenHash: hashClientSecret("the-real-token"),
  });
  assertTokenRejected(validateOidcClientRegistrationAccessToken(client, "a-guessed-token"));
});

test("a client with no registrationAccessTokenHash on file rejects every token — fail closed", () => {
  const client = fakeClient(["https://a.example/cb"], { registrationAccessTokenHash: null });
  assertTokenRejected(validateOidcClientRegistrationAccessToken(client, "any-token-at-all"));
});

test("an empty presented token is rejected even against a real hash", () => {
  const client = fakeClient(["https://a.example/cb"], {
    registrationAccessTokenHash: hashClientSecret("the-real-token"),
  });
  assertTokenRejected(validateOidcClientRegistrationAccessToken(client, ""));
});

test("the client_secret is never accepted in place of the registration_access_token", () => {
  // Two independent secrets (see lib/oidc-client-registration.ts's own
  // header) — a client_secret, even the real one, must never verify here.
  const clientSecret = "the-actual-client-secret";
  const client = fakeClient(["https://a.example/cb"], {
    clientSecretHash: hashClientSecret(clientSecret),
    registrationAccessTokenHash: hashClientSecret("a-totally-different-registration-access-token"),
  });
  assertTokenRejected(validateOidcClientRegistrationAccessToken(client, clientSecret));
});

console.log("All oidc-client-registration-access-token tests passed.");
