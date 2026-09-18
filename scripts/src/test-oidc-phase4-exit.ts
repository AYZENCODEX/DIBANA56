/**
 * scripts/src/test-oidc-phase4-exit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4e-e: Phase 4 Final Verification.
 *
 * Same shape as `test-oidc-phase2-exit.ts` (2E-e): the one integration
 * test in Phase 4 that wires every already-tested piece from 4a/4b/4c/4d/4e
 * together into the actual Season-2-exit-criteria flow, rather than
 * exercising each piece in isolation the way every other `test-oidc-*.ts`
 * file in this phase does.
 *
 * The roadmap's Season 2 exit criteria (after `/oidc/authorize` ->
 * `/oidc/token`, both already covered by Phase 3's own tests) is:
 *
 *   Access Token + ID Token -> /oidc/userinfo -> Scope-Enforced Resource
 *
 * This file proves that chain, end to end, against this provider's real
 * issuance/verification/enforcement functions (no live DB or network in
 * this sandbox — see below for exactly what that leaves unverified):
 *
 *   1. issue an access token + ID token for one simulated login
 *      (issueOidcAccessToken / issueOidcIdToken, 3c-f / 4a-f)
 *   2. decode the ID token and confirm every 4a/4b claim is correct
 *      (sub/iss/aud/exp/iat, nonce carried through when present/absent)
 *   3. verify the access token the way /oidc/userinfo does
 *      (verifyOidcAccessToken, 4c-a/4c-b/4c-c) and shape UserInfo claims
 *      from it by granted scope (buildUserinfoClaims, 4c-d/4c-e)
 *   4. run the SAME access token through requireOidcScope() (4d) chained
 *      into the real /oidc/resource/* handler shape (4e-a/4e-b) and
 *      confirm scope-gated resource access succeeds/fails exactly as
 *      UserInfo's own scope-shaped claims say it should for that token
 *
 * NOT covered here (needs a live DB / live HTTP server — same limitation
 * flagged in this phase's own CHANGES doc for 4a/4b/4c/4d):
 *   - fetchOidcUserinfoRecord()'s actual `users` table lookup
 *   - the full userinfoHandler()/routes/oidc-resource.ts Express dispatch
 *     (path routing, globalLimiter) as opposed to the handler functions
 *     these routes are built from
 *   - routes/oidc-token.ts's own end-to-end `openid`-scope gating of
 *     WHETHER an id_token is returned at all (already reasoned through in
 *     that route's own header; this file starts from "an id_token was
 *     issued", not from a raw /oidc/token HTTP call)
 *
 * Run: npx tsx scripts/src/test-oidc-phase4-exit.ts
 */
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { issueOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token";
import { issueOidcIdToken, buildIdTokenClaims } from "../../artifacts/api-server/src/lib/oidc-id-token";
import { verifyOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token-verification";
import { buildUserinfoClaims, type OidcUserinfoRecord } from "../../artifacts/api-server/src/lib/oidc-userinfo";
import { requireOidcScope, type RequestWithOidcToken } from "../../artifacts/api-server/src/lib/oidc-scope-enforcement";
import { resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function makeFakeReq(authorization?: string): RequestWithOidcToken {
  return { headers: authorization ? { authorization } : {} } as unknown as RequestWithOidcToken;
}

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

/** The exact chain routes/oidc-resource.ts mounts — see test-oidc-middleware-rollout.ts for why it's reimplemented rather than imported. */
function callResourceRoute(scope: string, req: RequestWithOidcToken, res: ReturnType<typeof makeFakeRes>["res"]) {
  let handlerRan = false;
  requireOidcScope(scope)(req, res, () => {
    handlerRan = true;
    const token = req.oidcToken!;
    res.status(200).json({ sub: String(token.userId), client_id: token.clientId, scopes: token.scopes });
  });
  return handlerRan;
}

console.log("Phase 4 exit — a full simulated login: Access Token + ID Token -> UserInfo -> Scope-Enforced Resource\n");

const USER: OidcUserinfoRecord = {
  id: 101,
  username: "sylo-pilot-user",
  email: "pilot@example.com",
  emailVerified: true,
  avatarUrl: "https://cdn.ayzen.tech/avatars/101.png",
};
const GRANTED_SCOPES = ["openid", "profile", "email"];
const CLIENT_ID = "sylo";
const NONCE = "n-abc123";

// ── 1/2. Issue + verify the ID token (4a/4b) ────────────────────────────────
console.log("Step 1-2: ID token issuance and claims (4a/4b)");

test("issued ID token decodes with correct sub/iss/aud and carries the bound nonce", () => {
  const idToken = issueOidcIdToken({ userId: USER.id, clientId: CLIENT_ID, nonce: NONCE });
  const decoded = jwt.decode(idToken) as Record<string, unknown>;
  assert.equal(decoded.sub, String(USER.id));
  assert.equal(decoded.iss, resolveIssuer());
  assert.equal(decoded.aud, CLIENT_ID);
  assert.equal(decoded.nonce, NONCE);
  assert.equal(typeof decoded.iat, "number");
  assert.equal(typeof decoded.exp, "number");
  assert.ok((decoded.exp as number) > (decoded.iat as number));
});

test("a login with no nonce bound produces claims with no 'nonce' key at all (4b-b/4b-c)", () => {
  const claims = buildIdTokenClaims({ userId: USER.id, clientId: CLIENT_ID, nonce: null });
  assert.equal("nonce" in claims, false);
});

// ── 3. Access token -> UserInfo (4c) ────────────────────────────────────────
console.log("\nStep 3: Access token verification and UserInfo claim shaping (4c)");

const issued = issueOidcAccessToken({ userId: USER.id, clientId: CLIENT_ID, scopes: GRANTED_SCOPES });

test("the access token issued for this same login verifies and carries the same subject", () => {
  const result = verifyOidcAccessToken(issued.accessToken);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.token.userId, USER.id);
    assert.equal(result.token.clientId, CLIENT_ID);
    assert.deepEqual(result.token.scopes, GRANTED_SCOPES);
  }
});

test("UserInfo claims for this token include profile + email claims (both scopes were granted)", () => {
  const verified = verifyOidcAccessToken(issued.accessToken);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  const claims = buildUserinfoClaims(USER, verified.token.scopes);
  assert.equal(claims.sub, String(USER.id));
  assert.equal(claims.preferred_username, USER.username);
  assert.equal(claims.email, USER.email);
  assert.equal(claims.email_verified, true);
});

// ── 4. Scope-enforced resource (4d/4e) ──────────────────────────────────────
console.log("\nStep 4: Scope-enforced resource access (4d/4e) — the Season 2 exit criteria's last step");

test("this login's token (openid+profile+email) is accepted by BOTH /oidc/resource/* routes", () => {
  const req1 = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res: res1, state: state1 } = makeFakeRes();
  assert.equal(callResourceRoute("profile", req1, res1), true);
  assert.equal(state1.statusCode, 200);

  const req2 = makeFakeReq(`Bearer ${issued.accessToken}`);
  const { res: res2, state: state2 } = makeFakeRes();
  assert.equal(callResourceRoute("email", req2, res2), true);
  assert.equal(state2.statusCode, 200);
});

test("a narrower-scoped login (openid only) is rejected by both scope-gated resource routes", () => {
  const narrow = issueOidcAccessToken({ userId: USER.id, clientId: CLIENT_ID, scopes: ["openid"] });

  const req1 = makeFakeReq(`Bearer ${narrow.accessToken}`);
  const { res: res1, state: state1 } = makeFakeRes();
  assert.equal(callResourceRoute("profile", req1, res1), false);
  assert.equal(state1.statusCode, 403);

  const req2 = makeFakeReq(`Bearer ${narrow.accessToken}`);
  const { res: res2, state: state2 } = makeFakeRes();
  assert.equal(callResourceRoute("email", req2, res2), false);
  assert.equal(state2.statusCode, 403);
});

console.log("\nPhase 4 (4a ID Token, 4b Nonce Binding, 4c UserInfo, 4d Scope Enforcement, 4e Middleware Rollout):");
console.log("all in-sandbox assertions passed. See this file's own header, and");
console.log("CHANGES_OIDC_MIDDLEWARE_ROLLOUT_PHASE4E.md, for what still needs a live DB/HTTP run.");
console.log("\nAll assertions passed.");
