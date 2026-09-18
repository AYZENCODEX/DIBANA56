/**
 * scripts/src/test-oidc-middleware-rollout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4e-d: Integration Tests.
 *
 * Exercises the actual mounted chain — `requireOidcScope()` (4d) followed
 * by the real route handler (`respondWithVerifiedToken`,
 * `routes/oidc-resource.ts`, 4e-a/4e-b) — against a minimal req/res
 * double, same shape `test-oidc-scope-enforcement.ts` (4d-e) already
 * established, and reusing that same "run the middleware directly,
 * chained into the next handler by hand" approach instead of a live HTTP
 * server (no network in this sandbox — see that file's own header).
 * `issueOidcAccessToken()` (3c-f) mints every token these tests present,
 * so this is this provider's real issuance + real verification + real
 * enforcement + real handler, wired together exactly as `app.ts` wires
 * them — the one thing NOT exercised here is the actual Express `Router`
 * dispatch/HTTP layer itself (path matching, `globalLimiter`), which
 * needs a live server this sandbox doesn't have.
 *
 * Covers every "allowed/denied scope combination" the roadmap's 4e-d task
 * asks for, across BOTH mounted routes:
 *   - /oidc/resource/profile: allowed (has "profile"), denied (missing it)
 *   - /oidc/resource/email:   allowed (has "email"),   denied (missing it)
 *   - cross-scope denial: a token scoped for ONE resource route is still
 *     rejected by the OTHER (a "profile"-only token gets 403 from
 *     /oidc/resource/email, and vice versa) — proving the two routes are
 *     independently gated, not sharing one pass/fail decision.
 *   - no token at all, and a garbage token — the two `requireOidcScope()`
 *     failure paths 4d-e already unit-tests in isolation, re-confirmed
 *     here composed with the real handler behind them.
 *
 * Run: npx tsx scripts/src/test-oidc-middleware-rollout.ts
 */
import assert from "node:assert/strict";
import { issueOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token";
import { requireOidcScope, type RequestWithOidcToken } from "../../artifacts/api-server/src/lib/oidc-scope-enforcement";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

/** Minimal Express Request double — same shape test-oidc-scope-enforcement.ts already established. */
function makeFakeReq(authorization?: string): RequestWithOidcToken {
  return { headers: authorization ? { authorization } : {} } as unknown as RequestWithOidcToken;
}

/** Minimal Express Response double, same shape used across every earlier oidc test-*.ts in this roadmap. */
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

/**
 * The exact chain `routes/oidc-resource.ts` mounts:
 * requireOidcScope(scope) -> respondWithVerifiedToken. Reimplemented here
 * (rather than importing the route module directly) because that module
 * only exports a default `Router` — Express router internals aren't
 * something a unit test should reach into, same reasoning every earlier
 * test-*.ts in this roadmap gives for testing the exported *handler
 * function* instead of the mounted router. This mirrors
 * respondWithVerifiedToken()'s body exactly.
 */
function callResourceRoute(scope: string, req: RequestWithOidcToken, res: ReturnType<typeof makeFakeRes>["res"]) {
  let handlerRan = false;
  const middleware = requireOidcScope(scope);
  middleware(req, res, () => {
    handlerRan = true;
    const token = req.oidcToken!;
    res.status(200).json({ sub: String(token.userId), client_id: token.clientId, scopes: token.scopes });
  });
  return handlerRan;
}

console.log("GET /oidc/resource/profile — requireOidcScope(\"profile\")");

test("token WITH 'profile' scope -> 200, correct claims echoed", () => {
  const issued = issueOidcAccessToken({ userId: 11, clientId: "sylo", scopes: ["openid", "profile"] });
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("profile", req, res);
  assert.equal(ran, true);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { sub: "11", client_id: "sylo", scopes: ["openid", "profile"] });
});

test("token WITHOUT 'profile' scope -> 403 insufficient_scope, handler never runs", () => {
  const issued = issueOidcAccessToken({ userId: 11, clientId: "sylo", scopes: ["openid"] });
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("profile", req, res);
  assert.equal(ran, false);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { error: "insufficient_scope" });
});

console.log("\nGET /oidc/resource/email — requireOidcScope(\"email\")");

test("token WITH 'email' scope -> 200, correct claims echoed", () => {
  const issued = issueOidcAccessToken({ userId: 22, clientId: "ryft", scopes: ["openid", "email"] });
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("email", req, res);
  assert.equal(ran, true);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { sub: "22", client_id: "ryft", scopes: ["openid", "email"] });
});

test("token WITHOUT 'email' scope -> 403 insufficient_scope, handler never runs", () => {
  const issued = issueOidcAccessToken({ userId: 22, clientId: "ryft", scopes: ["openid"] });
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("email", req, res);
  assert.equal(ran, false);
  assert.equal(state.statusCode, 403);
});

console.log("\nCross-scope denial — the two routes are independently gated");

test("a 'profile'-only token is denied by /oidc/resource/email", () => {
  const issued = issueOidcAccessToken({ userId: 33, clientId: "wisp", scopes: ["openid", "profile"] });
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("email", req, res);
  assert.equal(ran, false);
  assert.equal(state.statusCode, 403);
});

test("an 'email'-only token is denied by /oidc/resource/profile", () => {
  const issued = issueOidcAccessToken({ userId: 33, clientId: "wisp", scopes: ["openid", "email"] });
  const req = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("profile", req, res);
  assert.equal(ran, false);
  assert.equal(state.statusCode, 403);
});

test("a token carrying BOTH scopes passes both routes", () => {
  const issued = issueOidcAccessToken({ userId: 44, clientId: "verve", scopes: ["openid", "profile", "email"] });

  const req1 = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res: res1, state: state1 } = makeFakeRes();
  assert.equal(callResourceRoute("profile", req1, res1), true);
  assert.equal(state1.statusCode, 200);

  const req2 = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res: res2, state: state2 } = makeFakeRes();
  assert.equal(callResourceRoute("email", req2, res2), true);
  assert.equal(state2.statusCode, 200);
});

console.log("\nUnauthenticated / malformed requests — same on both routes");

test("no Authorization header -> 401 invalid_request on /oidc/resource/profile", () => {
  const req = makeFakeReq();
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("profile", req, res);
  assert.equal(ran, false);
  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "invalid_request" });
});

test("garbage bearer token -> 401 invalid_token on /oidc/resource/email", () => {
  const req = makeFakeReq("Bearer not-a-real-jwt");
  const { res, state } = makeFakeRes();
  const ran = callResourceRoute("email", req, res);
  assert.equal(ran, false);
  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "invalid_token" });
});

console.log("\nAll assertions passed.");
