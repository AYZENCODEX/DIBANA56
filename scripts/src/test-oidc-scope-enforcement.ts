/**
 * scripts/src/test-oidc-scope-enforcement.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4d-e: tests for `hasRequiredScope()` (4d-c)
 * and `requireOidcScope()` (4d-b/4d-c/4d-d) in
 * `artifacts/api-server/src/lib/oidc-scope-enforcement.ts`.
 *
 * Same "pure parts run for real" precedent every earlier `test-oidc-*.ts`
 * file in this roadmap has used: `requireOidcScope()`'s only dependency is
 * `verifyOidcAccessToken()` (4c-a/4c-b/4c-c), which is itself DB-free for
 * the path exercised here (`lib/jwt-keys.ts`'s dev-fallback branch,
 * `lib/oidc-discovery.ts`'s env-var branch) — so the middleware runs for
 * real against a minimal req/res double (same shape
 * `test-jwks-endpoint.ts` already established for `jwksHandler()`), not a
 * live HTTP server. `issueOidcAccessToken()` (3c-f) mints the tokens these
 * tests present, round-tripping this provider's own real issuance function
 * rather than hand-building JWTs.
 *
 * Run: npx tsx scripts/src/test-oidc-scope-enforcement.ts
 */
import assert from "node:assert/strict";
import { issueOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token";
import {
  hasRequiredScope,
  requireOidcScope,
  type RequestWithOidcToken,
} from "../../artifacts/api-server/src/lib/oidc-scope-enforcement";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

/** Minimal Express Request double — just enough for extractBearerToken(). */
function makeFakeReq(authorization?: string): RequestWithOidcToken {
  return { headers: authorization ? { authorization } : {} } as unknown as RequestWithOidcToken;
}

/** Minimal Express Response double: records what requireOidcScope()'s middleware sets/sends, same shape test-jwks-endpoint.ts's makeFakeRes() already established. */
function makeFakeRes() {
  const state: { headers: Record<string, string>; statusCode?: number; body?: unknown } = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as any, state };
}

console.log("hasRequiredScope() — 4d-c");

test("granted scopes include the required scope -> true", () => {
  assert.equal(hasRequiredScope(["openid", "profile"], "profile"), true);
});

test("granted scopes do NOT include the required scope -> false", () => {
  assert.equal(hasRequiredScope(["openid"], "profile"), false);
});

test("empty granted scopes -> false, never vacuously true", () => {
  assert.equal(hasRequiredScope([], "profile"), false);
});

console.log("\nrequireOidcScope() — 4d-b/4d-c/4d-d");

test("no Authorization header at all -> 401 invalid_request, next() never called", () => {
  const middleware = requireOidcScope("profile");
  const req = makeFakeReq();
  const { res, state } = makeFakeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "invalid_request" });
  assert.equal(state.headers["WWW-Authenticate"], 'Bearer error="invalid_request"');
});

test("malformed bearer token -> 401 invalid_token, next() never called", () => {
  const middleware = requireOidcScope("profile");
  const req = makeFakeReq("Bearer not-a-real-jwt");
  const { res, state } = makeFakeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "invalid_token" });
});

test("valid token missing the required scope -> 403 insufficient_scope, next() never called", () => {
  const issued = issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: ["openid"] });
  const middleware = requireOidcScope("profile");
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { error: "insufficient_scope" });
  assert.equal(state.headers["WWW-Authenticate"], 'Bearer error="insufficient_scope", scope="profile"');
});

test("valid token carrying the required scope -> next() called, no response written", () => {
  const issued = issueOidcAccessToken({ userId: 7, clientId: "ryft", scopes: ["openid", "profile"] });
  const middleware = requireOidcScope("profile");
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(state.statusCode, undefined);
  assert.equal(state.body, undefined);
});

test("the verified token is attached to req.oidcToken for downstream handlers", () => {
  const issued = issueOidcAccessToken({ userId: 9, clientId: "wisp", scopes: ["openid", "email"] });
  const middleware = requireOidcScope("email");
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res } = makeFakeRes();
  middleware(req, res, () => {});
  assert.ok(req.oidcToken);
  assert.equal(req.oidcToken?.userId, 9);
  assert.equal(req.oidcToken?.clientId, "wisp");
  assert.deepEqual(req.oidcToken?.scopes, ["openid", "email"]);
});

console.log("\nAll assertions passed.");
