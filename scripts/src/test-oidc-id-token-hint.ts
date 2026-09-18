/**
 * scripts/src/test-oidc-id-token-hint.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6a-b tests.
 *
 * Covers `lib/oidc-id-token.ts`'s `verifyIdTokenHint()` against REAL RS256
 * cryptography — `jsonwebtoken` + `lib/jwt-keys.ts`'s dev-ephemeral RSA
 * keypair fallback (no `AYZEN_JWT_PRIVATE_KEY`/`AYZEN_JWT_PUBLIC_KEY`/
 * `AYZEN_JWT_KID` set, `NODE_ENV !== "production"` — see that file's own
 * header). `issueOidcIdToken()` (Phase 4a-f, already shipped) signs with
 * the exact same active keypair `verifyIdTokenHint()` verifies against, so
 * round-tripping a real token through both is a genuine, non-mocked
 * signature check — the same "real crypto, no dependency stub" discipline
 * `test-rotation-lifecycle.ts` (1D-f) already established for this
 * codebase's Phase 1 tests, just exercised via the real `jsonwebtoken`
 * package (installed for this test run) instead of reimplementing RS256
 * by hand.
 *
 * NOTE: this file sets `NODE_ENV` to a non-"production" value ITSELF
 * (before importing anything) so the dev-ephemeral keypair path is taken
 * deterministically regardless of how the test runner was invoked —
 * unlike the DB-touching tests in this same pass, this one specifically
 * needs `NODE_ENV !== "production"` to get a real keypair without live
 * `AYZEN_JWT_*` secrets.
 *
 * Run: npx tsx scripts/src/test-oidc-id-token-hint.ts
 */
process.env.NODE_ENV = "test";
delete process.env.AYZEN_JWT_PRIVATE_KEY;
delete process.env.AYZEN_JWT_PUBLIC_KEY;
delete process.env.AYZEN_JWT_KID;
process.env.AYZEN_OIDC_ISSUER = "https://ayzen.tech";

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "node:crypto";
import { issueOidcIdToken, verifyIdTokenHint } from "../../artifacts/api-server/src/lib/oidc-id-token";
import { getActiveKeypair } from "../../artifacts/api-server/src/lib/jwt-keys";
import { resolveIssuer } from "../../artifacts/api-server/src/lib/oidc-discovery";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(err);
  }
}

async function main(): Promise<void> {
  console.log("verifyIdTokenHint()");
  console.log(`  (dev-ephemeral active kid: ${getActiveKeypair().kid}, issuer: ${resolveIssuer()})`);

  await test("a real ID token this provider issued verifies and returns its sub/aud", () => {
    const token = issueOidcIdToken({ userId: 42, clientId: "sylo", nonce: null });
    const hint = verifyIdTokenHint(token);
    assert.notEqual(hint, null);
    assert.equal(hint?.sub, "42");
    assert.equal(hint?.aud, "sylo");
  });

  await test("an EXPIRED-but-genuinely-signed token still verifies (id_token_hint is a hint, not a live credential)", () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago -> exp is well in the past
    const token = issueOidcIdToken({ userId: 7, clientId: "ryft", nonce: null }, past);
    const hint = verifyIdTokenHint(token);
    assert.notEqual(hint, null);
    assert.equal(hint?.sub, "7");
    assert.equal(hint?.aud, "ryft");
  });

  await test("a token signed by a DIFFERENT RSA key (wrong signature) is rejected", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const forged = jwt.sign(
      { sub: "1", iss: resolveIssuer(), aud: "sylo", iat: Math.floor(Date.now() / 1000) },
      privateKey,
      { algorithm: "RS256", keyid: getActiveKeypair().kid }, // same kid header, WRONG key material
    );
    assert.equal(verifyIdTokenHint(forged), null);
  });

  await test("a token with an unknown kid is rejected outright (never falls back to an unrelated key)", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const token = jwt.sign(
      { sub: "1", iss: resolveIssuer(), aud: "sylo", iat: Math.floor(Date.now() / 1000) },
      privateKey,
      { algorithm: "RS256", keyid: "totally-unknown-kid" },
    );
    assert.equal(verifyIdTokenHint(token), null);
  });

  await test("a token from a DIFFERENT issuer (correctly signed by the active key) is rejected", () => {
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign(
      { sub: "1", iss: "https://not-ayzen.example.com", aud: "sylo", iat: Math.floor(Date.now() / 1000) },
      privateKey,
      { algorithm: "RS256", keyid: kid },
    );
    assert.equal(verifyIdTokenHint(token), null);
  });

  await test("an HS256-signed token is rejected outright — id_token_hint is RS256-only, no legacy path", () => {
    const token = jwt.sign(
      { sub: "1", iss: resolveIssuer(), aud: "sylo", iat: Math.floor(Date.now() / 1000) },
      "some-shared-secret",
      { algorithm: "HS256" },
    );
    assert.equal(verifyIdTokenHint(token), null);
  });

  await test("a malformed/garbage token is rejected, never throws", () => {
    assert.equal(verifyIdTokenHint("not-a-jwt-at-all"), null);
  });

  await test("a genuinely-signed token missing sub/aud claim shape is rejected", () => {
    const { privateKey, kid } = getActiveKeypair();
    const token = jwt.sign({ iss: resolveIssuer(), iat: Math.floor(Date.now() / 1000) }, privateKey, {
      algorithm: "RS256",
      keyid: kid,
    });
    assert.equal(verifyIdTokenHint(token), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
