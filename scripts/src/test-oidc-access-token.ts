/**
 * scripts/src/test-oidc-access-token.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3c-h (partial): tests for
 * `issueOidcAccessToken()` (3c-f) in
 * `artifacts/api-server/src/lib/oidc-access-token.ts`.
 *
 * `issueOidcAccessToken()` pulls in `lib/jwt-keys.ts` (for the active
 * keypair) and `lib/oidc-discovery.ts` (for the issuer) via real imports —
 * both of those are themselves DB-free for the single code path this test
 * exercises (`getActiveKeypair()`'s dev-fallback branch, `resolveIssuer()`'s
 * env-var branch), so this test runs for real rather than being hand-traced,
 * same as 2E-d's own "pure parts run for real" precedent. `jsonwebtoken`
 * itself is used here only to INDEPENDENTLY verify what
 * `issueOidcAccessToken()` produced — same idea as "don't just assert the
 * function ran, assert what a real RS256 verifier would see."
 *
 * No 4c-a verifier exists in the deliverable yet (deliberately — see
 * `oidc-access-token.ts`'s own header) — this test's `jwt.verify()` calls
 * exist ONLY to check 3c-f's output, they are not a stand-in for that future
 * sub-phase's own verification function or tests.
 *
 * Run: npx tsx scripts/src/test-oidc-access-token.ts
 */
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";
import { resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";
import { issueOidcAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "../../artifacts/api-server/src/lib/oidc-access-token";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("issueOidcAccessToken()");

test("response shape matches RFC 6749 §5.1 (access_token/token_type/expires_in/scope)", () => {
  const issued = issueOidcAccessToken({ userId: 42, clientId: "sylo", scopes: ["openid", "profile"] });
  assert.equal(typeof issued.accessToken, "string");
  assert.equal(issued.tokenType, "Bearer");
  assert.equal(issued.expiresIn, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(issued.scope, "openid profile");
});

test("issued token verifies with the SAME active public key (round-trip signature check)", () => {
  const { publicKey } = getActiveKeypair();
  const issued = issueOidcAccessToken({ userId: 42, clientId: "sylo", scopes: ["openid"] });
  const decoded = jwt.verify(issued.accessToken, publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;
  assert.equal(decoded.sub, "42");
});

test("token FAILS verification under a different (attacker-controlled) key — never accepts an unsigned/forged token", () => {
  const forgedKeypair = getActiveKeypairIsolated();
  const issued = issueOidcAccessToken({ userId: 42, clientId: "sylo", scopes: ["openid"] });
  assert.throws(() => jwt.verify(issued.accessToken, forgedKeypair.publicKey, { algorithms: ["RS256"] }));
});

test("claims: sub is the stringified userId, not the raw number", () => {
  const { publicKey } = getActiveKeypair();
  const issued = issueOidcAccessToken({ userId: 7, clientId: "sylo", scopes: [] });
  const decoded = jwt.decode(issued.accessToken) as Record<string, unknown>;
  assert.equal(decoded.sub, "7");
  assert.notEqual(decoded.sub, 7);
});

test("claims: aud is bound to the requesting client_id", () => {
  const decoded = jwt.decode(issueOidcAccessToken({ userId: 1, clientId: "ryft", scopes: [] }).accessToken) as Record<string, unknown>;
  assert.equal(decoded.aud, "ryft");
});

test("claims: iss matches resolveIssuer() (Phase 1e-d), never a second independently-configured value", () => {
  const decoded = jwt.decode(issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: [] }).accessToken) as Record<string, unknown>;
  assert.equal(decoded.iss, resolveIssuer());
});

test("claims: scope is space-delimited (OAuth convention), not a JSON array", () => {
  const decoded = jwt.decode(issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: ["openid", "email"] }).accessToken) as Record<string, unknown>;
  assert.equal(decoded.scope, "openid email");
  assert.equal(Array.isArray(decoded.scope), false);
});

test("claims: an empty scopes array yields scope: '' (not undefined, not omitted)", () => {
  const decoded = jwt.decode(issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: [] }).accessToken) as Record<string, unknown>;
  assert.equal(decoded.scope, "");
});

test("claims: exp is exactly ACCESS_TOKEN_TTL_SECONDS after iat", () => {
  const decoded = jwt.decode(issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: [] }).accessToken) as { exp: number; iat: number };
  assert.equal(decoded.exp - decoded.iat, ACCESS_TOKEN_TTL_SECONDS);
});

test("header: alg is RS256 and kid matches the active signing key — never HS256, never keyless", () => {
  const { kid } = getActiveKeypair();
  const decodedHeader = jwt.decode(issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: [] }).accessToken, { complete: true })?.header;
  assert.equal(decodedHeader?.alg, "RS256");
  assert.equal(decodedHeader?.kid, kid);
});

test("no id_token field is ever present on the issued object — that is Phase 4a's job, not 3c-f's", () => {
  const issued = issueOidcAccessToken({ userId: 1, clientId: "sylo", scopes: [] }) as Record<string, unknown>;
  assert.equal("idToken" in issued, false);
  assert.equal("id_token" in issued, false);
});

// Isolated helper — generates a second, unrelated RSA keypair purely to
// prove cross-key verification fails; never touches getActiveKeypair()'s
// own module-level cache.
function getActiveKeypairIsolated(): { publicKey: string } {
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey };
}

console.log("\nAll assertions passed.");
