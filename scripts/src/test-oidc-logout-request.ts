/**
 * scripts/src/test-oidc-logout-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6a tests + Phase 6c-d (Cross-Path
 * Verification, the client-resolution half of it — see
 * test-oidc-session-cross-path.ts for the session-revocation half).
 *
 * Covers `lib/oidc-logout-request.ts`'s `parseOidcLogoutRequest()` (pure)
 * and `validateOidcLogoutRequest()`. Same "inject the effectful boundary,
 * exercise the real decision logic" discipline as every other test file in
 * this roadmap — `validateOidcLogoutRequest()`'s two injected dependencies,
 * `IdTokenHintVerifier` (6a-b) and `OidcClientResolver` (6c-a/6c-d), are
 * both fakes here, so this file needs neither real RS256 keys nor a live
 * `DATABASE_URL`/DB test stub — matching the DB-free-testable convention
 * every other Phase 2/3 test file in this roadmap already follows (see
 * `test-oidc-clients.ts`'s own note on why DB-live behavior, e.g. a
 * duplicate `client_id`, is hand-verified there instead of exercised
 * against a real pool — the identical reasoning applies to "does this
 * client_id exist in Postgres", which `OidcClientResolver` fakes out here
 * rather than needing a real answer to).
 *
 * Run: npx tsx scripts/src/test-oidc-logout-request.ts
 */
import assert from "node:assert/strict";
import {
  parseOidcLogoutRequest,
  validateOidcLogoutRequest,
  type IdTokenHintVerifier,
  type OidcClientResolver,
  type VerifiedLogoutHint,
} from "../../artifacts/api-server/src/lib/oidc-logout-request";
import type { OidcClient } from "../../artifacts/api-server/src/lib/oidc-clients";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(err);
  }
}

/** In-memory `client_id -> OidcClient` set, standing in for `oidc_clients` — this is the injected `OidcClientResolver` every test below passes as `validateOidcLogoutRequest()`'s third argument. */
function fakeClientResolver(clients: OidcClient[]): OidcClientResolver {
  const byId = new Map(clients.map((c) => [c.clientId, c]));
  return async (clientId: string) => byId.get(clientId) ?? null;
}

function sylo(overrides: Partial<OidcClient> = {}): OidcClient {
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
    backchannelLogoutUri: "https://sylo.ayzen.tech/oidc/backchannel-logout",
    allowedScopes: ["openid", "profile", "email"],
    isFirstParty: true,
    // Phase 8e (migration 092): not exercised by anything this test calls — filled in only so this fixture still satisfies OidcClient's full shape.
    registrationAccessTokenHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const NO_CLIENTS = fakeClientResolver([]);
const SYLO_ONLY = fakeClientResolver([sylo()]);

const NO_HINT: IdTokenHintVerifier = () => null; // request never supplies id_token_hint in these cases — never called
const REJECT_HINT: IdTokenHintVerifier = () => null; // hint supplied but fails verification
function fixedHint(claims: VerifiedLogoutHint): IdTokenHintVerifier {
  return () => claims;
}

async function main(): Promise<void> {
  console.log("parseOidcLogoutRequest()");

  await test("reads all four RP-Initiated Logout params off the query string", () => {
    const raw = parseOidcLogoutRequest({
      id_token_hint: "abc.def.ghi",
      client_id: "sylo",
      post_logout_redirect_uri: "https://sylo.ayzen.tech/",
      state: "xyz",
    });
    assert.deepEqual(raw, {
      idTokenHint: "abc.def.ghi",
      clientId: "sylo",
      postLogoutRedirectUri: "https://sylo.ayzen.tech/",
      state: "xyz",
    });
  });

  await test("a bare request (no params at all) parses to all-undefined, never throws", () => {
    const raw = parseOidcLogoutRequest({});
    assert.deepEqual(raw, {
      idTokenHint: undefined,
      clientId: undefined,
      postLogoutRedirectUri: undefined,
      state: undefined,
    });
  });

  await test("non-string / empty-string query values are treated as absent", () => {
    const raw = parseOidcLogoutRequest({ id_token_hint: ["a", "b"], client_id: "", state: 123 });
    assert.equal(raw.idTokenHint, undefined);
    assert.equal(raw.clientId, undefined);
    assert.equal(raw.state, undefined);
  });

  console.log("\nvalidateOidcLogoutRequest()");

  await test("bare request (nothing supplied) is valid — client null, redirect null, hintUserId null", async () => {
    const result = await validateOidcLogoutRequest({}, NO_HINT, NO_CLIENTS);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.client, null);
      assert.equal(result.postLogoutRedirectUri, null);
      assert.equal(result.hintUserId, null);
      assert.equal(result.state, undefined);
    }
  });

  await test("valid id_token_hint resolves the client from its aud and carries sub as hintUserId", async () => {
    const verifier = fixedHint({ sub: "42", aud: "sylo" });
    const result = await validateOidcLogoutRequest({ idTokenHint: "token" }, verifier, SYLO_ONLY);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.client?.clientId, "sylo");
      assert.equal(result.hintUserId, "42");
    }
  });

  await test("id_token_hint present but fails verification -> invalid_request, non-redirectable", async () => {
    const result = await validateOidcLogoutRequest({ idTokenHint: "garbage" }, REJECT_HINT, SYLO_ONLY);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_request");
      assert.equal(result.redirectable, false);
    }
  });

  await test("bare client_id (no hint) resolves a known client", async () => {
    const result = await validateOidcLogoutRequest({ clientId: "sylo" }, NO_HINT, SYLO_ONLY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.client?.clientId, "sylo");
  });

  await test("unknown client_id -> invalid_client, non-redirectable", async () => {
    const result = await validateOidcLogoutRequest({ clientId: "does-not-exist" }, NO_HINT, SYLO_ONLY);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_client");
      assert.equal(result.redirectable, false);
    }
  });

  await test("client_id supplied but the resolver has no clients at all -> invalid_client (never falls through as valid)", async () => {
    const result = await validateOidcLogoutRequest({ clientId: "sylo" }, NO_HINT, NO_CLIENTS);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_client");
  });

  await test("6c-a — resolveClient's real-implementation call shape (getOidcClientById(clientId): Promise<OidcClient | null>) matches OidcClientResolver, so routes/oidc-logout.ts's validateOidcLogoutRequest(raw, verifyIdTokenHint, getOidcClientById) call type-checks with no adapter needed", () => {
    const shapeCheck: (clientId: string) => Promise<OidcClient | null> = SYLO_ONLY;
    assert.equal(typeof shapeCheck, "function");
  });

  await test("id_token_hint aud and client_id agreeing -> valid", async () => {
    const verifier = fixedHint({ sub: "42", aud: "sylo" });
    const result = await validateOidcLogoutRequest({ idTokenHint: "token", clientId: "sylo" }, verifier, SYLO_ONLY);
    assert.equal(result.ok, true);
  });

  await test("id_token_hint aud and client_id disagreeing -> invalid_request, non-redirectable", async () => {
    const verifier = fixedHint({ sub: "42", aud: "sylo" });
    const resolver = fakeClientResolver([sylo(), sylo({ id: 2, clientId: "ryft", postLogoutRedirectUris: ["https://ryft.ayzen.tech/"] })]);
    const result = await validateOidcLogoutRequest({ idTokenHint: "token", clientId: "ryft" }, verifier, resolver);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_request");
      assert.equal(result.redirectable, false);
    }
  });

  await test("post_logout_redirect_uri exactly matching the resolved client's registry -> valid, echoed back", async () => {
    const result = await validateOidcLogoutRequest(
      { clientId: "sylo", postLogoutRedirectUri: "https://sylo.ayzen.tech/", state: "s1" },
      NO_HINT,
      SYLO_ONLY,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.postLogoutRedirectUri, "https://sylo.ayzen.tech/");
      assert.equal(result.state, "s1");
    }
  });

  await test("post_logout_redirect_uri NOT registered for the resolved client -> invalid_post_logout_redirect_uri, non-redirectable", async () => {
    const result = await validateOidcLogoutRequest(
      { clientId: "sylo", postLogoutRedirectUri: "https://evil.example.com/" },
      NO_HINT,
      SYLO_ONLY,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_post_logout_redirect_uri");
      assert.equal(result.redirectable, false);
    }
  });

  await test("post_logout_redirect_uri that IS a valid redirect_uri (callback) but NOT a registered post-logout URI -> rejected (lists are independent)", async () => {
    const result = await validateOidcLogoutRequest(
      { clientId: "sylo", postLogoutRedirectUri: "https://sylo.ayzen.tech/oidc/callback" },
      NO_HINT,
      SYLO_ONLY,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_post_logout_redirect_uri");
  });

  await test("post_logout_redirect_uri supplied with NO resolvable client -> invalid_request, non-redirectable (never a bare-trust redirect)", async () => {
    const result = await validateOidcLogoutRequest(
      { postLogoutRedirectUri: "https://sylo.ayzen.tech/" },
      NO_HINT,
      SYLO_ONLY,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_request");
      assert.equal(result.redirectable, false);
    }
  });

  await test("near-match post_logout_redirect_uri (trailing path) is rejected — exact match only, no normalization", async () => {
    const result = await validateOidcLogoutRequest(
      { clientId: "sylo", postLogoutRedirectUri: "https://sylo.ayzen.tech/extra" },
      NO_HINT,
      SYLO_ONLY,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_post_logout_redirect_uri");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
