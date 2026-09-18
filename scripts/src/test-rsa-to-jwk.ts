/**
 * scripts/src/test-rsa-to-jwk.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-a: unit tests for verificationKeyToJwk()
 * in artifacts/api-server/src/lib/jwt-keys.ts.
 *
 * Exercises the converter against REAL RSA keypairs generated with
 * node:crypto (same approach 1D-f took for real crypto round-trip
 * verification) — not fixture strings — so "generated JWK can represent
 * every retained verification key" and "private material never appears"
 * (the roadmap's 1E-a acceptance criteria) are checked against actual key
 * material, not a hand-typed stand-in for one.
 *
 * Run: npx tsx scripts/src/test-rsa-to-jwk.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { verificationKeyToJwk, type VerificationKey } from "../../artifacts/api-server/src/lib/jwt-keys";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function genRsaKeypair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

console.log("verificationKeyToJwk()");

test("converts a real RSA public key to { kty: RSA, n, e } plus kid/use/alg", () => {
  const { publicKey } = genRsaKeypair();
  const key: VerificationKey = { kid: "kid-1", publicKey, status: "active" };
  const jwk = verificationKeyToJwk(key);
  assert.equal(jwk.kty, "RSA");
  assert.equal(jwk.use, "sig");
  assert.equal(jwk.alg, "RS256");
  assert.equal(jwk.kid, "kid-1");
  assert.equal(typeof jwk.n, "string");
  assert.ok(jwk.n.length > 0);
  assert.equal(jwk.e, "AQAB"); // standard RSA public exponent 65537, base64url
});

test("output has exactly the six documented fields — no extra/private fields leak", () => {
  const { publicKey } = genRsaKeypair();
  const jwk = verificationKeyToJwk({ kid: "kid-2", publicKey, status: "retiring" });
  assert.deepEqual(Object.keys(jwk).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
  const asRecord = jwk as unknown as Record<string, unknown>;
  assert.equal("d" in asRecord, false); // RSA private exponent — must never appear
  assert.equal("p" in asRecord, false);
  assert.equal("q" in asRecord, false);
});

test("different keypairs produce different `n` values (not a stub/constant)", () => {
  const a = genRsaKeypair();
  const b = genRsaKeypair();
  const jwkA = verificationKeyToJwk({ kid: "a", publicKey: a.publicKey, status: "active" });
  const jwkB = verificationKeyToJwk({ kid: "b", publicKey: b.publicKey, status: "active" });
  assert.notEqual(jwkA.n, jwkB.n);
});

test("`kid` is carried through verbatim, independent of key material", () => {
  const { publicKey } = genRsaKeypair();
  const jwk = verificationKeyToJwk({ kid: "some-arbitrary-kid-string", publicKey, status: "active" });
  assert.equal(jwk.kid, "some-arbitrary-kid-string");
});

test("status (active vs retiring) does not change the JWK shape — JWKS has no status field", () => {
  const { publicKey } = genRsaKeypair();
  const active = verificationKeyToJwk({ kid: "same-kid", publicKey, status: "active" });
  const retiring = verificationKeyToJwk({ kid: "same-kid", publicKey, status: "retiring" });
  assert.deepEqual(active, retiring);
});

test("throws (does not silently coerce) on a non-RSA key", () => {
  const { publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  assert.throws(
    () => verificationKeyToJwk({ kid: "ec-key", publicKey, status: "active" }),
    /not RSA/,
  );
});

test("throws on garbage input rather than returning a malformed JWK", () => {
  assert.throws(() => verificationKeyToJwk({ kid: "bad", publicKey: "not a pem", status: "active" }));
});

test("passing a PRIVATE key PEM where a public key is expected still cannot produce a private JWK", () => {
  // Defense in depth: even if a caller mistakenly passed a private key PEM
  // as `publicKey` (a type-system violation — VerificationKey.publicKey is
  // documented as public-only), createPublicKey() on a private-key PEM
  // derives and returns the PUBLIC key portion — it does not hand back
  // private material. This asserts that safety net actually holds today.
  const { privateKey } = genRsaKeypair();
  const derivedPublic = createPrivateKey(privateKey); // just to confirm privateKey parses as private
  assert.equal(derivedPublic.type, "private");
  const jwk = verificationKeyToJwk({ kid: "misuse-case", publicKey: privateKey, status: "active" });
  assert.deepEqual(Object.keys(jwk).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
});

console.log("All verificationKeyToJwk() tests passed.");
