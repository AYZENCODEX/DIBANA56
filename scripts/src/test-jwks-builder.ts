/**
 * scripts/src/test-jwks-builder.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1E-b: unit tests for buildJwks() in
 * artifacts/api-server/src/lib/jwt-keys.ts.
 *
 * Deliberately exercises ONLY the pure, DB-free builder — same discipline as
 * 1D-a's test-verification-keys.ts — against real RSA keypairs (as
 * 1E-a's own test does), so it stays runnable anywhere with nothing but
 * `npx tsx scripts/src/test-jwks-builder.ts`.
 *
 * Run: npx tsx scripts/src/test-jwks-builder.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildJwks, type VerificationKey } from "../../artifacts/api-server/src/lib/jwt-keys";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

function genPub(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
}

console.log("buildJwks()");

test("empty input → { keys: [] }, not an error", () => {
  const result = buildJwks([]);
  assert.deepEqual(result, { keys: [] });
});

test("response structure is deterministic: same input → same shape, same order", () => {
  const keys: VerificationKey[] = [
    { kid: "k1", publicKey: genPub(), status: "active" },
    { kid: "k2", publicKey: genPub(), status: "retiring" },
  ];
  const first = buildJwks(keys);
  const second = buildJwks(keys);
  assert.deepEqual(
    first.keys.map((k) => k.kid),
    ["k1", "k2"],
  );
  assert.deepEqual(first, second);
});

test("active key is included and published as a full RS256 JWK", () => {
  const keys: VerificationKey[] = [{ kid: "active-1", publicKey: genPub(), status: "active" }];
  const result = buildJwks(keys);
  assert.equal(result.keys.length, 1);
  assert.equal(result.keys[0].kid, "active-1");
  assert.equal(result.keys[0].kty, "RSA");
  assert.equal(result.keys[0].alg, "RS256");
});

test("retaining/retiring key is included alongside active (grace-period visibility)", () => {
  const keys: VerificationKey[] = [
    { kid: "active-1", publicKey: genPub(), status: "active" },
    { kid: "retiring-1", publicKey: genPub(), status: "retiring" },
  ];
  const result = buildJwks(keys);
  assert.deepEqual(
    result.keys.map((k) => k.kid).sort(),
    ["active-1", "retiring-1"],
  );
});

test('a "retired" key cannot even be expressed in the input — VerificationKey has no retired state (1D-a)', () => {
  // This is a compile-time guarantee (JwtKeyStatus = "active" | "retiring"),
  // demonstrated here at runtime: every key this function is EVER given is
  // already verify-eligible by construction, so there is no "exclude
  // removed keys" branch to test inside buildJwks() itself — the exclusion
  // already happened one layer down, in mergeVerificationKeys()/
  // fetchDbVerificationKeys() (1D-a/1D-c). What we CAN assert here is that
  // buildJwks() doesn't add its own competing filter that could disagree.
  const keys: VerificationKey[] = [{ kid: "still-good", publicKey: genPub(), status: "retiring" }];
  const result = buildJwks(keys);
  assert.equal(result.keys.length, 1);
});

test("no private material anywhere in the built response", () => {
  const keys: VerificationKey[] = [
    { kid: "k1", publicKey: genPub(), status: "active" },
    { kid: "k2", publicKey: genPub(), status: "retiring" },
  ];
  const result = buildJwks(keys);
  for (const jwk of result.keys) {
    const asRecord = jwk as unknown as Record<string, unknown>;
    assert.equal("d" in asRecord, false);
    assert.equal("p" in asRecord, false);
    assert.equal("q" in asRecord, false);
    assert.equal(Object.keys(jwk).sort().join(","), "alg,e,kid,kty,n,use");
  }
});

test("a single malformed key is skipped, not fatal to the rest of the response", () => {
  const keys: VerificationKey[] = [
    { kid: "good-1", publicKey: genPub(), status: "active" },
    { kid: "corrupt", publicKey: "not a real pem", status: "retiring" },
    { kid: "good-2", publicKey: genPub(), status: "retiring" },
  ];
  const result = buildJwks(keys);
  assert.deepEqual(
    result.keys.map((k) => k.kid).sort(),
    ["good-1", "good-2"],
  );
});

test("many retained keys (simulated multi-rotation history) all resolve", () => {
  const keys: VerificationKey[] = Array.from({ length: 5 }, (_, i) => ({
    kid: `hist-${i}`,
    publicKey: genPub(),
    status: i === 0 ? ("active" as const) : ("retiring" as const),
  }));
  const result = buildJwks(keys);
  assert.equal(result.keys.length, 5);
  assert.equal(new Set(result.keys.map((k) => k.kid)).size, 5); // every kid distinct
});

console.log("All buildJwks() tests passed.");
