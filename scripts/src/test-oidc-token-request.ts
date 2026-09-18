/**
 * scripts/src/test-oidc-token-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c-h (partial): unit tests for
 * `parseOidcTokenRequest()` (3c-a) in
 * `artifacts/api-server/src/lib/oidc-token-request.ts`.
 *
 * Pure, dependency-free — runs anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-token-request.ts`.
 *
 * Run: npx tsx scripts/src/test-oidc-token-request.ts
 */
import assert from "node:assert/strict";
import { parseOidcTokenRequest } from "../../artifacts/api-server/src/lib/oidc-token-request";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("parseOidcTokenRequest()");

test("a well-formed authorization_code body parses every field", () => {
  const result = parseOidcTokenRequest({
    grant_type: "authorization_code",
    code: "abc123",
    redirect_uri: "https://sylo.ayzen.tech/oidc/callback",
    client_id: "sylo",
    client_secret: "s3cr3t",
    code_verifier: "verifier-value",
  });
  assert.deepEqual(result, {
    grantType: "authorization_code",
    code: "abc123",
    redirectUri: "https://sylo.ayzen.tech/oidc/callback",
    clientId: "sylo",
    clientSecret: "s3cr3t",
    codeVerifier: "verifier-value",
  });
});

test("a public client's body (no client_secret) parses clientSecret as undefined, not an empty string", () => {
  const result = parseOidcTokenRequest({
    grant_type: "authorization_code",
    code: "abc123",
    redirect_uri: "https://sylo.ayzen.tech/oidc/callback",
    client_id: "sylo",
    code_verifier: "verifier-value",
  });
  assert.equal(result.clientSecret, undefined);
});

test("an empty body parses every field to undefined, never throws", () => {
  const result = parseOidcTokenRequest({});
  assert.deepEqual(result, {
    grantType: undefined,
    code: undefined,
    redirectUri: undefined,
    clientId: undefined,
    clientSecret: undefined,
    codeVerifier: undefined,
  });
});

test("empty-string field values normalize to undefined (same as missing)", () => {
  const result = parseOidcTokenRequest({ grant_type: "", code: "", client_id: "" });
  assert.equal(result.grantType, undefined);
  assert.equal(result.code, undefined);
  assert.equal(result.clientId, undefined);
});

test("a repeated (array-shaped) urlencoded field takes the first value, same defense parseOidcAuthorizeRequest (3a-a) uses", () => {
  const result = parseOidcTokenRequest({ grant_type: ["authorization_code", "refresh_token"] });
  assert.equal(result.grantType, "authorization_code");
});

test("a nested-object field value (never a valid urlencoded scalar) parses to undefined, not '[object Object]'", () => {
  const result = parseOidcTokenRequest({ code: { nested: true } as unknown });
  assert.equal(result.code, undefined);
});

test("an empty array field value parses to undefined", () => {
  const result = parseOidcTokenRequest({ code_verifier: [] as unknown });
  assert.equal(result.codeVerifier, undefined);
});

console.log("\nAll assertions passed.");
