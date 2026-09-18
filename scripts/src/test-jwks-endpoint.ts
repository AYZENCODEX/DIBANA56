/**
 * scripts/src/test-jwks-endpoint.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-c: unit tests for jwksHandler() in
 * artifacts/api-server/src/routes/well-known-jwks.ts.
 *
 * Exercises the exported handler function directly against a minimal
 * req/res double (not a live HTTP server — see the sandbox note below),
 * confirming the roadmap's 1E-c "Done when" criteria:
 *   - endpoint returns a valid JWKS;
 *   - every published key has the expected `kid`;
 *   - correct content type;
 *   - no private key material is ever exposed;
 *   - cache behavior doesn't fight rotation (short, not `no-store`/infinite).
 *
 * Run: npx tsx scripts/src/test-jwks-endpoint.ts
 */
import assert from "node:assert/strict";
import { jwksHandler } from "../../artifacts/api-server/src/routes/well-known-jwks";
import { __resetVerificationKeyCacheForTests } from "../../artifacts/api-server/src/lib/jwt-keys";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

/** Minimal Express Response double: records what jwksHandler() sets/sends, nothing more. */
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

console.log("jwksHandler()");

test("responds with a valid JWKS shape ({ keys: [...] })", () => {
  __resetVerificationKeyCacheForTests(); // pre-cache-load window → falls back to the env-resolved active keypair (1D-b)
  const { res, state } = makeFakeRes();
  jwksHandler({} as any, res);
  const body = state.body as { keys: unknown[] };
  assert.ok(Array.isArray(body.keys));
  assert.ok(body.keys.length >= 1); // at minimum, the env-resolved dev keypair
});

test("every published key has a `kid` and the expected RS256 JWK fields", () => {
  __resetVerificationKeyCacheForTests();
  const { res, state } = makeFakeRes();
  jwksHandler({} as any, res);
  const body = state.body as { keys: Record<string, unknown>[] };
  for (const key of body.keys) {
    assert.equal(typeof key.kid, "string");
    assert.ok((key.kid as string).length > 0);
    assert.equal(key.kty, "RSA");
    assert.equal(key.alg, "RS256");
    assert.equal(key.use, "sig");
    assert.equal(typeof key.n, "string");
    assert.equal(typeof key.e, "string");
  }
});

test("no private key material anywhere in the response", () => {
  __resetVerificationKeyCacheForTests();
  const { res, state } = makeFakeRes();
  jwksHandler({} as any, res);
  const body = state.body as { keys: Record<string, unknown>[] };
  for (const key of body.keys) {
    assert.equal("d" in key, false);
    assert.equal("p" in key, false);
    assert.equal("q" in key, false);
    assert.equal(Object.keys(key).sort().join(","), "alg,e,kid,kty,n,use");
  }
});

test("content type is set to application/json", () => {
  __resetVerificationKeyCacheForTests();
  const { res, state } = makeFakeRes();
  jwksHandler({} as any, res);
  assert.equal(state.contentType, "application/json");
});

test("Cache-Control is set, short-lived (rotation-compatible), and not a caching opt-out", () => {
  __resetVerificationKeyCacheForTests();
  const { res, state } = makeFakeRes();
  jwksHandler({} as any, res);
  const cacheControl = state.headers["Cache-Control"];
  assert.equal(typeof cacheControl, "string");
  assert.ok(cacheControl.includes("max-age="));
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  assert.ok(maxAgeMatch);
  const maxAgeSeconds = Number(maxAgeMatch![1]);
  assert.ok(maxAgeSeconds > 0); // not "0" (that's effectively no-store)
  // MAX_TOKEN_LIFETIME_MS from jwt-keys.ts (1D-e) is 7 days — the cache
  // window must stay far below that so a rotation is visible to HTTP
  // caches long before an old token could still be in flight.
  assert.ok(maxAgeSeconds < 24 * 60 * 60); // under a day
  assert.equal(cacheControl.includes("no-store"), false);
});

test("does not throw even before the verification-key cache has loaded (pre-cache-load fallback, 1D-b)", () => {
  __resetVerificationKeyCacheForTests();
  const { res } = makeFakeRes();
  assert.doesNotThrow(() => jwksHandler({} as any, res));
});

console.log("All jwksHandler() tests passed.");
