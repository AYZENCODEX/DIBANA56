/**
 * scripts/src/test-oidc-authorize-request-validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3a-h: Request Validation Tests for
 * `artifacts/api-server/src/lib/oidc-authorize-request.ts` (3a-a..3a-g).
 *
 * Same shape as every prior OIDC test file in this roadmap (2C-e/2D-e/
 * 2E-d): DB-free, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-authorize-request-validation.ts`.
 *
 * Exercises `parseOidcAuthorizeRequest()` (3a-a) and
 * `validateOidcAuthorizeRequestForClient()` (the pure half of 3a-b..3a-f)
 * directly. `validateOidcAuthorizeRequest()` (the public, DB-touching
 * entrypoint) is NOT executed here for the same reason
 * `validateOidcClientRequest()` wasn't in 2E-d: it is a thin
 * presence-check + delegate wrapper around already-tested pieces
 * (`validateOidcClientRequest()` itself tested via 2E-d/2E-e,
 * `validateOidcAuthorizeRequestForClient()` tested exhaustively below) —
 * hand-traced instead of executed, same as 2E-d's wrapper note.
 *
 * Covers section 6's "GLOBAL TESTING MATRIX -> Authorization" list:
 *   - missing parameters       -> missing state / missing code_challenge /
 *                                  missing code_challenge_method
 *   - invalid state            -> (state is opaque — "invalid" at this
 *                                  layer means "absent"; see below)
 *   - invalid nonce            -> nonce has no format to be "invalid" (see
 *                                  below) — its accept/omit behavior is
 *                                  covered instead
 *   - invalid PKCE challenge   -> malformed code_challenge, unsupported
 *                                  code_challenge_method
 *   - unsupported response type -> wrong value AND missing value
 * plus 3a-g's `redirectable` distinction and 3a-a's parser edge cases.
 *
 * Run: npx tsx scripts/src/test-oidc-authorize-request-validation.ts
 */
import assert from "node:assert/strict";
import {
  parseOidcAuthorizeRequest,
  validateOidcAuthorizeRequestForClient,
  type OidcAuthorizeRequestValidationResult,
  type RawOidcAuthorizeRequest,
} from "../../artifacts/api-server/src/lib/oidc-authorize-request";
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

const REGISTERED_REDIRECT = "https://sylo.ayzen.tech/oidc/callback";
const VALID_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // 43 chars, RFC 7636 §4.2's own worked example

function fakeClient(opts: { redirectUris?: string[]; allowedScopes?: string[] } = {}): OidcClient {
  return {
    id: 1,
    clientId: "sylo",
    clientSecretHash: null,
    // Phase 8a/8c: not exercised by anything this test calls
    // (`validateOidcClientId()`, the only reader of `registrationStatus`,
    // is DB-touching and out of scope here) — filled in only so this
    // fixture still satisfies `OidcClient`'s full shape.
    clientName: null,
    registrationStatus: "approved",
    redirectUris: opts.redirectUris ?? [REGISTERED_REDIRECT],
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    allowedScopes: opts.allowedScopes ?? ["openid", "profile", "email"],
    isFirstParty: true,
    // Phase 8e (migration 092): not exercised by anything this test calls — filled in only so this fixture still satisfies OidcClient's full shape.
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function baseRaw(overrides: Partial<RawOidcAuthorizeRequest> = {}): RawOidcAuthorizeRequest {
  return {
    clientId: "sylo",
    redirectUri: REGISTERED_REDIRECT,
    responseType: "code",
    scope: "openid profile",
    state: "abc123",
    nonce: "nonce-xyz",
    codeChallenge: VALID_CHALLENGE,
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

function clientRequest(overrides: { redirectUri?: string; scopes?: string[] } = {}) {
  return {
    client: fakeClient(),
    redirectUri: overrides.redirectUri ?? REGISTERED_REDIRECT,
    scopes: overrides.scopes ?? ["openid", "profile"],
  };
}

function assertOk(result: OidcAuthorizeRequestValidationResult): asserts result is Extract<OidcAuthorizeRequestValidationResult, { ok: true }> {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
}

function assertRedirectableError(
  result: OidcAuthorizeRequestValidationResult,
  expectedError: string,
  expectedRedirectUri: string = REGISTERED_REDIRECT,
): Extract<OidcAuthorizeRequestValidationResult, { ok: false; redirectable: true }> {
  assert.equal(result.ok, false, `expected failure, got ${JSON.stringify(result)}`);
  const failure = result as Extract<OidcAuthorizeRequestValidationResult, { ok: false }>;
  assert.equal(failure.redirectable, true);
  assert.equal(failure.error, expectedError);
  assert.equal((failure as { redirectUri: string }).redirectUri, expectedRedirectUri);
  return failure as Extract<OidcAuthorizeRequestValidationResult, { ok: false; redirectable: true }>;
}

// ── 3a-a — Request Parser ───────────────────────────────────────────────────
console.log("parseOidcAuthorizeRequest() — 3a-a");

test("parses every field from a well-formed query object", () => {
  const raw = parseOidcAuthorizeRequest({
    client_id: "sylo",
    redirect_uri: REGISTERED_REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "s1",
    nonce: "n1",
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: "S256",
  });
  assert.deepEqual(raw, {
    clientId: "sylo",
    redirectUri: REGISTERED_REDIRECT,
    responseType: "code",
    scope: "openid",
    state: "s1",
    nonce: "n1",
    codeChallenge: VALID_CHALLENGE,
    codeChallengeMethod: "S256",
  });
});

test("missing query object -> every field undefined, does not throw", () => {
  const raw = parseOidcAuthorizeRequest(undefined);
  assert.deepEqual(raw, {
    clientId: undefined,
    redirectUri: undefined,
    responseType: undefined,
    scope: undefined,
    state: undefined,
    nonce: undefined,
    codeChallenge: undefined,
    codeChallengeMethod: undefined,
  });
});

test("empty-string query values parse to undefined, not ''", () => {
  const raw = parseOidcAuthorizeRequest({ client_id: "", state: "" });
  assert.equal(raw.clientId, undefined);
  assert.equal(raw.state, undefined);
});

test("array query values (parameter pollution) pick the first string entry", () => {
  const raw = parseOidcAuthorizeRequest({ client_id: ["sylo", "ryft"], state: ["s1", "s2"] });
  assert.equal(raw.clientId, "sylo");
  assert.equal(raw.state, "s1");
});

test("a non-string, non-array query value (nested object) is treated as absent", () => {
  const raw = parseOidcAuthorizeRequest({ client_id: { nested: true } as unknown as string });
  assert.equal(raw.clientId, undefined);
});

// ── 3a-c — Response-Type Validation ─────────────────────────────────────────
console.log("validateOidcAuthorizeRequestForClient() — 3a-c response_type");

test("response_type=code -> passes this check (continues to state/PKCE)", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw());
  assertOk(result);
  assert.equal(result.responseType, "code");
});

test("missing response_type -> unsupported_response_type", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ responseType: undefined }));
  assertRedirectableError(result, "unsupported_response_type");
});

test("response_type=token (implicit) -> unsupported_response_type, not silently accepted", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ responseType: "token" }));
  assertRedirectableError(result, "unsupported_response_type");
});

test("response_type=id_token (implicit) -> unsupported_response_type", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ responseType: "id_token" }));
  assertRedirectableError(result, "unsupported_response_type");
});

// ── 3a-d — State Validation ─────────────────────────────────────────────────
console.log("validateOidcAuthorizeRequestForClient() — 3a-d state");

test("missing state -> invalid_request / missing_state", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ state: undefined }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "missing_state");
});

test("state is preserved verbatim into the success result, unmodified", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ state: "opaque-value-123!@#" }));
  assertOk(result);
  assert.equal(result.state, "opaque-value-123!@#");
});

test("response_type is checked before state — a request missing BOTH reports unsupported_response_type", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ responseType: undefined, state: undefined }));
  assertRedirectableError(result, "unsupported_response_type");
});

// ── 3a-e — Nonce Validation ──────────────────────────────────────────────────
console.log("validateOidcAuthorizeRequestForClient() — 3a-e nonce");

test("nonce present -> carried through into the success result unmodified", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ nonce: "n-abc" }));
  assertOk(result);
  assert.equal(result.nonce, "n-abc");
});

test("nonce absent -> success result's nonce is null, request is NOT rejected (nonce is optional for the code flow)", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ nonce: undefined }));
  assertOk(result);
  assert.equal(result.nonce, null);
});

// ── 3a-f — PKCE Parameter Validation ─────────────────────────────────────────
console.log("validateOidcAuthorizeRequestForClient() — 3a-f PKCE");

test("missing code_challenge -> invalid_request / missing_code_challenge", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallenge: undefined }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "missing_code_challenge");
});

test("code_challenge too short -> invalid_request / malformed_code_challenge", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallenge: "tooshort" }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "malformed_code_challenge");
});

test("code_challenge with invalid characters (e.g. '+', '/', '=' — standard, not base64url) -> malformed_code_challenge", () => {
  const badChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+/=";
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallenge: badChallenge }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "malformed_code_challenge");
});

test("code_challenge at the 128-char upper bound -> accepted", () => {
  const longChallenge = "A".repeat(128);
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallenge: longChallenge }));
  assertOk(result);
  assert.equal(result.codeChallenge, longChallenge);
});

test("code_challenge at 129 chars (over the bound) -> malformed_code_challenge", () => {
  const tooLong = "A".repeat(129);
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallenge: tooLong }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "malformed_code_challenge");
});

test("missing code_challenge_method -> invalid_request / missing_code_challenge_method (NOT defaulted to plain)", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallengeMethod: undefined }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "missing_code_challenge_method");
});

test("code_challenge_method=plain -> invalid_request / unsupported_code_challenge_method, never accepted", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallengeMethod: "plain" }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "unsupported_code_challenge_method");
});

test("code_challenge_method=S256 (correct case) -> accepted", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallengeMethod: "S256" }));
  assertOk(result);
  assert.equal(result.codeChallengeMethod, "S256");
});

test("code_challenge_method='s256' (wrong case) -> rejected, not case-insensitively accepted", () => {
  const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw({ codeChallengeMethod: "s256" }));
  const failure = assertRedirectableError(result, "invalid_request");
  assert.equal((failure as { reason: string }).reason, "unsupported_code_challenge_method");
});

// ── 3a-g — Authorization Error Contract / redirectable ──────────────────────
console.log("OidcAuthorizeRequestValidationResult — 3a-g redirectable contract");

test("every post-client-validation failure carries the verified redirectUri and redirectable: true", () => {
  const cases: Array<Partial<RawOidcAuthorizeRequest>> = [
    { responseType: undefined },
    { state: undefined },
    { codeChallenge: undefined },
    { codeChallengeMethod: "plain" },
  ];
  for (const overrides of cases) {
    const result = validateOidcAuthorizeRequestForClient(clientRequest(), baseRaw(overrides));
    assert.equal(result.ok, false);
    const failure = result as Extract<OidcAuthorizeRequestValidationResult, { ok: false }>;
    assert.equal(failure.redirectable, true);
    assert.equal((failure as { redirectUri: string }).redirectUri, REGISTERED_REDIRECT);
  }
});

// ── Full success shape ───────────────────────────────────────────────────────
console.log("validateOidcAuthorizeRequestForClient() — full success shape");

test("a fully valid request returns every validated field, unchanged from the input client/redirect/scopes", () => {
  const cr = clientRequest({ scopes: ["openid", "profile"] });
  const result = validateOidcAuthorizeRequestForClient(cr, baseRaw());
  assertOk(result);
  assert.equal(result.client, cr.client);
  assert.equal(result.redirectUri, REGISTERED_REDIRECT);
  assert.deepEqual(result.scopes, ["openid", "profile"]);
  assert.equal(result.responseType, "code");
  assert.equal(result.state, "abc123");
  assert.equal(result.nonce, "nonce-xyz");
  assert.equal(result.codeChallenge, VALID_CHALLENGE);
  assert.equal(result.codeChallengeMethod, "S256");
});

console.log("All oidc-authorize-request tests passed.");
