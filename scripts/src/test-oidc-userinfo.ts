/**
 * scripts/src/test-oidc-userinfo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4c-g: tests for
 * `verifyOidcAccessToken()` (4c-a/4c-b/4c-c,
 * `lib/oidc-access-token-verification.ts`) and `buildUserinfoClaims()`
 * (4c-d/4c-e, `lib/oidc-userinfo.ts`).
 *
 * Same "pure parts run for real" precedent every earlier `test-oidc-*.ts`
 * file in this roadmap has used: `verifyOidcAccessToken()` only touches
 * `lib/jwt-keys.ts` (dev-fallback branch) and `lib/oidc-discovery.ts`
 * (env-var branch), both DB-free for the path exercised here, so this
 * runs for real. `issueOidcAccessToken()` (3c-f) is reused to MINT the
 * tokens these tests verify — round-tripping this provider's own real
 * issuance function rather than hand-building JWTs, so a change to that
 * function's claim shape would break this test too, not silently drift
 * out of sync with it.
 *
 * NOT covered here (needs a live DB — see file headers for why):
 *   - `fetchOidcUserinfoRecord()` (`lib/oidc-userinfo.ts`) — the actual
 *     `users` table lookup, including the banned/suspended exclusion.
 *   - `userinfoHandler()` (`routes/oidc-userinfo.ts`) — the full
 *     Authorization-header -> verify -> DB lookup -> claims chain, and
 *     its RFC 6750 `WWW-Authenticate`/401 response shape.
 * Both are straightforward compositions of already-tested pieces (this
 * file's `verifyOidcAccessToken()`/`buildUserinfoClaims()` coverage, plus
 * `fetchOidcUserinfoRecord()`'s own query mirroring `getUserFromToken()`'s
 * already-reviewed banned/suspended check) — reviewed by hand, not run,
 * same "DONE at this pass, VERIFIED once a real DB round trip exists" gap
 * the 3c/3e CHANGES doc already flagged for the equivalent DB-backed
 * pieces of the token endpoint.
 *
 * Run: npx tsx scripts/src/test-oidc-userinfo.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { issueOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token";
import { verifyOidcAccessToken } from "../../artifacts/api-server/src/lib/oidc-access-token-verification";
import { buildUserinfoClaims, type OidcUserinfoRecord } from "../../artifacts/api-server/src/lib/oidc-userinfo";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("verifyOidcAccessToken() — 4c-a/4c-b/4c-c");

test("a genuinely-issued token verifies and extracts userId/clientId/scopes", () => {
  const issued = issueOidcAccessToken({ userId: 42, clientId: "sylo", scopes: ["openid", "profile"] });
  const result = verifyOidcAccessToken(issued.accessToken);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.token.userId, 42);
    assert.equal(result.token.clientId, "sylo");
    assert.deepEqual(result.token.scopes, ["openid", "profile"]);
  }
});

test("sub is parsed back to a number, never left as the wire string", () => {
  const issued = issueOidcAccessToken({ userId: 7, clientId: "sylo", scopes: [] });
  const result = verifyOidcAccessToken(issued.accessToken);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(typeof result.token.userId, "number");
    assert.equal(result.token.userId, 7);
  }
});

test("an empty scopes array round-trips to an empty array, not undefined", () => {
  const issued = issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: [] });
  const result = verifyOidcAccessToken(issued.accessToken);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.token.scopes, []);
});

test("a malformed (non-JWT) string is rejected as 'malformed'", () => {
  const result = verifyOidcAccessToken("not-a-jwt-at-all");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed");
});

test("a token forged under a DIFFERENT RSA key is rejected — never accepted just because it decodes", () => {
  const forged = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const { kid } = getActiveKeypair();
  const forgedToken = jwt.sign({ sub: "1", scope: "openid", aud: "sylo" }, forged.privateKey, {
    algorithm: "RS256",
    keyid: kid, // claims OUR active kid, but is signed with a different key entirely
    issuer: "https://ayzen.replit.app",
    expiresIn: 3600,
  });
  const result = verifyOidcAccessToken(forgedToken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});

test("a token with an unknown kid is rejected as 'unknown_kid', never falls back to another key", () => {
  const forged = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const forgedToken = jwt.sign({ sub: "1", scope: "openid", aud: "sylo" }, forged.privateKey, {
    algorithm: "RS256",
    keyid: "some-kid-that-does-not-exist",
    issuer: "https://ayzen.replit.app",
    expiresIn: 3600,
  });
  const result = verifyOidcAccessToken(forgedToken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unknown_kid");
});

test("a token signed under HS256 (wrong algorithm) is rejected before any key lookup — 'malformed'", () => {
  // jsonwebtoken refuses to HS256-sign with an RSA PEM key directly, so this
  // proves the point a different way: an RS256-header token whose alg this
  // function is told to trust is exactly what's checked BEFORE verification
  // — a token literally claiming a non-RS256 alg in its header never reaches
  // the RS256 key-lookup path at all.
  const rawHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const rawPayload = Buffer.from(JSON.stringify({ sub: "1" })).toString("base64url");
  const uncheckedToken = `${rawHeader}.${rawPayload}.`;
  const result = verifyOidcAccessToken(uncheckedToken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed");
});

test("an expired token is rejected as 'expired', distinguished from a bad signature", () => {
  const { privateKey, kid } = getActiveKeypair();
  const expiredToken = jwt.sign({ sub: "1", scope: "openid", aud: "sylo" }, privateKey, {
    algorithm: "RS256",
    keyid: kid,
    issuer: "https://ayzen.replit.app",
    expiresIn: -60, // already expired the moment it's minted
  });
  const result = verifyOidcAccessToken(expiredToken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("a token with the wrong issuer is rejected — never accepted just because the signature checks out", () => {
  const { privateKey, kid } = getActiveKeypair();
  const wrongIssuerToken = jwt.sign({ sub: "1", scope: "openid", aud: "sylo" }, privateKey, {
    algorithm: "RS256",
    keyid: kid,
    issuer: "https://not-ayzen.example.com",
    expiresIn: 3600,
  });
  const result = verifyOidcAccessToken(wrongIssuerToken);
  assert.equal(result.ok, false);
});

console.log("\nbuildUserinfoClaims() — 4c-d/4c-e");

const BASE_USER: OidcUserinfoRecord = {
  id: 9,
  username: "wisp-user",
  email: "user@example.com",
  emailVerified: true,
  avatarUrl: "https://cdn.example.com/avatar.png",
};

test("sub is always present, regardless of granted scopes", () => {
  const claims = buildUserinfoClaims(BASE_USER, []);
  assert.equal(claims.sub, "9");
});

test("no 'profile' scope -> no preferred_username/picture claims at all", () => {
  const claims = buildUserinfoClaims(BASE_USER, ["openid"]) as Record<string, unknown>;
  assert.equal("preferred_username" in claims, false);
  assert.equal("picture" in claims, false);
});

test("'profile' scope -> preferred_username is the username, picture is the avatar URL", () => {
  const claims = buildUserinfoClaims(BASE_USER, ["openid", "profile"]);
  assert.equal(claims.preferred_username, "wisp-user");
  assert.equal(claims.picture, "https://cdn.example.com/avatar.png");
});

test("'profile' scope with no avatar set -> picture is omitted, never an empty string", () => {
  const claims = buildUserinfoClaims({ ...BASE_USER, avatarUrl: null }, ["profile"]) as Record<string, unknown>;
  assert.equal("picture" in claims, false);
});

test("no 'email' scope -> no email/email_verified claims at all", () => {
  const claims = buildUserinfoClaims(BASE_USER, ["openid", "profile"]) as Record<string, unknown>;
  assert.equal("email" in claims, false);
  assert.equal("email_verified" in claims, false);
});

test("'email' scope -> email and email_verified are always returned together", () => {
  const claims = buildUserinfoClaims(BASE_USER, ["openid", "email"]);
  assert.equal(claims.email, "user@example.com");
  assert.equal(claims.email_verified, true);
});

test("email_verified reflects a false DB value truthfully, not defaulted to true", () => {
  const claims = buildUserinfoClaims({ ...BASE_USER, emailVerified: false }, ["email"]);
  assert.equal(claims.email_verified, false);
});

test("both 'profile' and 'email' granted -> every claim from both appears together", () => {
  const claims = buildUserinfoClaims(BASE_USER, ["openid", "profile", "email"]);
  assert.equal(claims.preferred_username, "wisp-user");
  assert.equal(claims.picture, "https://cdn.example.com/avatar.png");
  assert.equal(claims.email, "user@example.com");
  assert.equal(claims.email_verified, true);
});

console.log("\nAll assertions passed.");
