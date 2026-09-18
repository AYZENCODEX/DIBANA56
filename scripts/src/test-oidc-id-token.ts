/**
 * scripts/src/test-oidc-id-token.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 4a-g (Claim Tests) + Phase 4b-d (Replay
 * Tests): tests for `buildIdTokenClaims()` / `issueOidcIdToken()` (4a) and
 * `resolveIdTokenNonce()` (4b) in
 * `artifacts/api-server/src/lib/oidc-id-token.ts`.
 *
 * Same "pure parts run for real" precedent `test-oidc-access-token.ts`
 * (3c-h) and `test-oidc-pkce.ts` (3d-f) already established:
 * `issueOidcIdToken()` pulls in `lib/jwt-keys.ts` (for the active keypair,
 * dev-fallback branch) and `lib/oidc-discovery.ts` (for the issuer,
 * env-var branch) — both DB-free for the single code path this test
 * exercises, so this runs for real rather than being hand-traced.
 * `jsonwebtoken` is used here only to INDEPENDENTLY verify what
 * `issueOidcIdToken()` produced, same as 3c-h's own `jwt.verify()` calls.
 *
 * 4b-d, CONCRETELY: this file does not (and cannot, from here) simulate an
 * actual code-replay against the token endpoint — that is
 * `consumeAuthorizationCode()`'s own single-use guarantee (3c-e), already
 * covered by that file's own tests, and this file has no route/DB access
 * to re-exercise it. What IS this file's job, and what "Replay Tests"
 * means for the ID-token layer specifically, is proving the ONE thing an
 * ID token issuer could get wrong in a replay-adjacent way: that the
 * `nonce` claim is always and only the exact value the authorization code
 * was persisted with — never a default, never leaked from a previous
 * call, never silently reused across two different bindings. The
 * "identical binding twice yields identical claims, distinct bindings
 * never leak into each other" tests below are that proof at this layer.
 *
 * Run: npx tsx scripts/src/test-oidc-id-token.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";
import { resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";
import {
  buildIdTokenClaims,
  issueOidcIdToken,
  resolveIdTokenNonce,
  ID_TOKEN_TTL_SECONDS,
} from "../../artifacts/api-server/src/lib/oidc-id-token";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

console.log("resolveIdTokenNonce() — 4b-c");

test("a real nonce string passes through unchanged", () => {
  assert.equal(resolveIdTokenNonce("abc123"), "abc123");
});

test("null (no nonce persisted with the code) resolves to undefined, never null", () => {
  assert.equal(resolveIdTokenNonce(null), undefined);
  assert.notEqual(resolveIdTokenNonce(null), null);
});

console.log("\nbuildIdTokenClaims() — 4a-a..4a-e, 4b-b");

test("claims: sub is the stringified userId, not the raw number", () => {
  const claims = buildIdTokenClaims({ userId: 7, clientId: "sylo", nonce: null }, FIXED_NOW);
  assert.equal(claims.sub, "7");
  assert.notEqual(claims.sub, 7);
});

test("claims: iss matches resolveIssuer() (Phase 1e-d), never a second independently-configured value", () => {
  const claims = buildIdTokenClaims({ userId: 1, clientId: "sylo", nonce: null }, FIXED_NOW);
  assert.equal(claims.iss, resolveIssuer());
});

test("claims: aud is bound to the requesting client_id", () => {
  const claims = buildIdTokenClaims({ userId: 1, clientId: "ryft", nonce: null }, FIXED_NOW);
  assert.equal(claims.aud, "ryft");
});

test("claims: exp is exactly ID_TOKEN_TTL_SECONDS after iat", () => {
  const claims = buildIdTokenClaims({ userId: 1, clientId: "sylo", nonce: null }, FIXED_NOW);
  assert.equal(claims.exp - claims.iat, ID_TOKEN_TTL_SECONDS);
});

test("claims: iat matches the injected clock, not wall-clock time", () => {
  const claims = buildIdTokenClaims({ userId: 1, clientId: "sylo", nonce: null }, FIXED_NOW);
  assert.equal(claims.iat, Math.floor(FIXED_NOW.getTime() / 1000));
});

test("claims: a binding WITH a nonce carries it through exactly (4b-b)", () => {
  const claims = buildIdTokenClaims({ userId: 1, clientId: "sylo", nonce: "state-xyz-789" }, FIXED_NOW);
  assert.equal(claims.nonce, "state-xyz-789");
});

test("claims: a binding WITHOUT a nonce has no nonce key at all — not null, not '' (4b-c)", () => {
  const claims = buildIdTokenClaims({ userId: 1, clientId: "sylo", nonce: null }, FIXED_NOW) as Record<string, unknown>;
  assert.equal("nonce" in claims, false);
});

test("two calls with distinct bindings never leak one binding's nonce into the other's claims (4b-d)", () => {
  const withNonce = buildIdTokenClaims({ userId: 1, clientId: "sylo", nonce: "code-a-nonce" }, FIXED_NOW);
  const withoutNonce = buildIdTokenClaims({ userId: 2, clientId: "ryft", nonce: null }, FIXED_NOW) as Record<string, unknown>;
  assert.equal(withNonce.nonce, "code-a-nonce");
  assert.equal("nonce" in withoutNonce, false);
});

console.log("\nissueOidcIdToken() — 4a-f, signing + round-trip");

// The tests above pin `now` to a fixed instant purely to make claim MATH
// (exp - iat, iat itself) deterministic — the tests below call
// `jwt.verify()`, which checks `exp` against the REAL wall clock, so they
// deliberately use `issueOidcIdToken()`'s own default (real `new Date()`)
// instead of `FIXED_NOW`, the same way a token minted right now would
// actually be verified right now.

test("issued token verifies with the SAME active public key (round-trip signature check)", () => {
  const { publicKey } = getActiveKeypair();
  const token = issueOidcIdToken({ userId: 42, clientId: "sylo", nonce: null });
  const decoded = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;
  assert.equal(decoded.sub, "42");
});

test("token FAILS verification under a different (attacker-controlled) key — never accepts an unsigned/forged token", () => {
  const { publicKey: forgedPublicKey } = generateIsolatedKeypair();
  const token = issueOidcIdToken({ userId: 42, clientId: "sylo", nonce: null });
  assert.throws(() => jwt.verify(token, forgedPublicKey, { algorithms: ["RS256"] }));
});

test("header: alg is RS256 and kid matches the active signing key — never HS256, never keyless", () => {
  const { kid } = getActiveKeypair();
  const token = issueOidcIdToken({ userId: 1, clientId: "sylo", nonce: null });
  const decodedHeader = jwt.decode(token, { complete: true })?.header;
  assert.equal(decodedHeader?.alg, "RS256");
  assert.equal(decodedHeader?.kid, kid);
});

test("signed token's decoded claims match buildIdTokenClaims()'s pure output exactly", () => {
  const binding = { userId: 9, clientId: "wisp", nonce: "n-1" } as const;
  const expected = buildIdTokenClaims(binding, FIXED_NOW);
  const token = issueOidcIdToken(binding, FIXED_NOW);
  const decoded = jwt.decode(token) as Record<string, unknown>;
  assert.equal(decoded.sub, expected.sub);
  assert.equal(decoded.iss, expected.iss);
  assert.equal(decoded.aud, expected.aud);
  assert.equal(decoded.iat, expected.iat);
  assert.equal(decoded.exp, expected.exp);
  assert.equal(decoded.nonce, expected.nonce);
});

test("signed token for a nonce-less binding has no nonce claim on the wire either", () => {
  const token = issueOidcIdToken({ userId: 1, clientId: "sylo", nonce: null });
  const decoded = jwt.decode(token) as Record<string, unknown>;
  assert.equal("nonce" in decoded, false);
});

// Isolated helper — generates a second, unrelated RSA keypair purely to
// prove cross-key verification fails; never touches getActiveKeypair()'s
// own module-level cache. Same purpose as `test-oidc-access-token.ts`'s
// (3c-h) own helper, duplicated here rather than imported since these
// test scripts have no shared-utilities module of their own yet — written
// with a top-level `import`, not that file's `require(...)` (which throws
// under this workspace's ESM module resolution; see this pass's own notes
// on that pre-existing, out-of-scope issue).
function generateIsolatedKeypair(): { publicKey: string } {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey };
}

console.log("\nAll assertions passed.");
