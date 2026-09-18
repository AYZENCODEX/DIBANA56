/**
 * scripts/src/test-verification-keys.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1D-a: unit tests for the pure
 * mergeVerificationKeys() merge step in
 * artifacts/api-server/src/lib/jwt-keys.ts.
 *
 * Deliberately exercises ONLY the pure, DB-free function — not
 * getVerificationKeys() itself, which needs a live DATABASE_URL/pool. That
 * keeps this runnable in any environment (CI, local, sandboxes with no DB)
 * with nothing but `npx tsx scripts/src/test-verification-keys.ts`.
 *
 * Run: npx tsx scripts/src/test-verification-keys.ts
 */
import assert from "node:assert/strict";
import { mergeVerificationKeys, type JwtKeypair, type VerificationKey } from "../../artifacts/api-server/src/lib/jwt-keys";

const envKeypair: JwtKeypair = { kid: "env-1", privateKey: "PRIV", publicKey: "ENV-PUB" };

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("mergeVerificationKeys()");

test("empty DB table falls back to the env keypair only", () => {
  const result = mergeVerificationKeys([], envKeypair);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { kid: "env-1", publicKey: "ENV-PUB", status: "active" });
});

test("active + retiring DB rows are all returned alongside the env key", () => {
  const dbKeys: VerificationKey[] = [
    { kid: "db-active", publicKey: "PUB-A", status: "active" },
    { kid: "db-retiring", publicKey: "PUB-B", status: "retiring" },
  ];
  const result = mergeVerificationKeys(dbKeys, envKeypair);
  assert.deepEqual(
    result.map((k) => k.kid).sort(),
    ["db-active", "db-retiring", "env-1"],
  );
});

test('a "retired" row never surfaces, even if passed in unfiltered', () => {
  const dbKeys = [{ kid: "db-retired", publicKey: "PUB-C", status: "retired" }] as VerificationKey[];
  const result = mergeVerificationKeys(dbKeys, envKeypair);
  assert.equal(result.some((k) => k.kid === "db-retired"), false);
  assert.equal(result.length, 1); // only the env fallback
});

test("a DB row for the env's own kid wins over the fallback (no duplicate)", () => {
  const dbKeys: VerificationKey[] = [{ kid: "env-1", publicKey: "DB-OVERRIDE-PUB", status: "retiring" }];
  const result = mergeVerificationKeys(dbKeys, envKeypair);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { kid: "env-1", publicKey: "DB-OVERRIDE-PUB", status: "retiring" });
});

test("kid filter narrows to exactly the matching key", () => {
  const dbKeys: VerificationKey[] = [
    { kid: "db-active", publicKey: "PUB-A", status: "active" },
    { kid: "db-retiring", publicKey: "PUB-B", status: "retiring" },
  ];
  const result = mergeVerificationKeys(dbKeys, envKeypair, "db-retiring");
  assert.equal(result.length, 1);
  assert.equal(result[0].kid, "db-retiring");
});

test("kid filter for an unknown kid returns empty — never falls back to an unrelated key", () => {
  const dbKeys: VerificationKey[] = [{ kid: "db-active", publicKey: "PUB-A", status: "active" }];
  const result = mergeVerificationKeys(dbKeys, envKeypair, "does-not-exist");
  assert.equal(result.length, 0);
});

console.log("All mergeVerificationKeys() tests passed.");
