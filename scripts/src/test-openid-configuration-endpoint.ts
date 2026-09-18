/**
 * scripts/src/test-openid-configuration-endpoint.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-e: unit tests for
 * openidConfigurationHandler() in
 * artifacts/api-server/src/routes/well-known-openid-configuration.ts.
 *
 * Exercises the exported handler function directly against a minimal
 * req/res double (not a live HTTP server — see the sandbox note in
 * CHANGES_JWT_JWKS_ENDPOINT_PHASE1E_C.md, same limitation applies here),
 * confirming the roadmap's 1E-e "Done when" criteria:
 *   - standard OIDC discovery clients can parse the response;
 *   - issuer and endpoint URLs (jwks_uri) are consistent.
 * Also re-checks 1E-d's metadata-shape guarantees end-to-end through the
 * actual HTTP handler (not just the pure builder), and the same
 * content-type/caching hygiene 1E-c established for the sibling endpoint.
 *
 * Run: npx tsx scripts/src/test-openid-configuration-endpoint.ts
 */
import assert from "node:assert/strict";
import { openidConfigurationHandler } from "../../artifacts/api-server/src/routes/well-known-openid-configuration";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

/** Minimal Express Response double: records what the handler sets/sends, nothing more. */
function makeFakeRes() {
  const state: { headers: Record<string, string>; contentType?: string; body?: unknown } = { headers: {} };
  const res = {
    set(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    type(contentType: string) {
      state.contentType = contentType;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as any, state };
}

const ORIGINAL_ISSUER_ENV = process.env.AYZEN_OIDC_ISSUER;
const ORIGINAL_APP_URL_ENV = process.env.APP_URL;

function restoreEnv(): void {
  if (ORIGINAL_ISSUER_ENV === undefined) delete process.env.AYZEN_OIDC_ISSUER;
  else process.env.AYZEN_OIDC_ISSUER = ORIGINAL_ISSUER_ENV;
  if (ORIGINAL_APP_URL_ENV === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL_ENV;
}

console.log("openidConfigurationHandler()");

test("responds with a parseable OIDC discovery document (standard field set)", () => {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  const body = state.body as Record<string, unknown>;
  assert.equal(typeof body.issuer, "string");
  assert.equal(typeof body.jwks_uri, "string");
  assert.ok(Array.isArray(body.response_types_supported));
  assert.ok(Array.isArray(body.scopes_supported));
  assert.ok(Array.isArray(body.id_token_signing_alg_values_supported));
});

test("issuer and jwks_uri are consistent (jwks_uri is issuer + the real 1E-c path)", () => {
  process.env.AYZEN_OIDC_ISSUER = "https://account.ayzen.tech";
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  restoreEnv();
  const body = state.body as { issuer: string; jwks_uri: string };
  assert.equal(body.issuer, "https://account.ayzen.tech");
  assert.equal(body.jwks_uri, "https://account.ayzen.tech/.well-known/jwks.json");
  assert.ok(body.jwks_uri.startsWith(body.issuer));
});

test("Phase 5a-e: now DOES advertise authorization/token/userinfo endpoints (they exist as of Phase 3/4)", () => {
  process.env.AYZEN_OIDC_ISSUER = "https://account.ayzen.tech";
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  restoreEnv();
  const body = state.body as Record<string, unknown>;
  assert.equal(body.authorization_endpoint, "https://account.ayzen.tech/oidc/authorize");
  assert.equal(body.token_endpoint, "https://account.ayzen.tech/oidc/token");
  assert.equal(body.userinfo_endpoint, "https://account.ayzen.tech/oidc/userinfo");
});

test("still does not advertise metadata fields nothing in this roadmap consumes yet", () => {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  const body = state.body as Record<string, unknown>;
  assert.equal("grant_types_supported" in body, false);
  assert.equal("claims_supported" in body, false);
  assert.equal("token_endpoint_auth_methods_supported" in body, false);
});

test("supported-algorithm metadata matches the active signing switch (RS256 only, no HS256)", () => {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  const body = state.body as { id_token_signing_alg_values_supported: string[] };
  assert.deepEqual(body.id_token_signing_alg_values_supported, ["RS256"]);
});

test("response_types_supported is exactly [\"code\"] and scopes_supported is exactly [\"openid\"]", () => {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  const body = state.body as { response_types_supported: string[]; scopes_supported: string[] };
  assert.deepEqual(body.response_types_supported, ["code"]);
  assert.deepEqual(body.scopes_supported, ["openid"]);
});

test("content type is set to application/json", () => {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  assert.equal(state.contentType, "application/json");
});

test("Cache-Control is set, not a caching opt-out, and longer-lived than the JWKS endpoint's", () => {
  const { res, state } = makeFakeRes();
  openidConfigurationHandler({} as any, res);
  const cacheControl = state.headers["Cache-Control"];
  assert.equal(typeof cacheControl, "string");
  assert.ok(cacheControl.includes("max-age="));
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  assert.ok(maxAgeMatch);
  const maxAgeSeconds = Number(maxAgeMatch![1]);
  assert.ok(maxAgeSeconds > 300); // longer than JWKS's 5 minutes (1E-c) — metadata changes far less often
  assert.equal(cacheControl.includes("no-store"), false);
});

test("does not throw regardless of env state", () => {
  delete process.env.AYZEN_OIDC_ISSUER;
  delete process.env.APP_URL;
  const { res } = makeFakeRes();
  assert.doesNotThrow(() => openidConfigurationHandler({} as any, res));
  restoreEnv();
});

console.log("All openidConfigurationHandler() tests passed.");
