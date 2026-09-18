/**
 * scripts/src/test-key-lifecycle.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1D-c: unit tests for the key lifecycle
 * rules (canSign(), canVerify()) in artifacts/api-server/src/lib/jwt-keys.ts,
 * plus a regression check that mergeVerificationKeys() (Phase 1D-a) still
 * agrees with them now that it reads the rule from canVerify() instead of a
 * hand-written status check.
 *
 * Deliberately exercises ONLY pure, DB-free functions — same shape as
 * scripts/src/test-verification-keys.ts (1D-a) and
 * scripts/src/test-resolve-verification-keys.ts (1D-b) — so it's runnable
 * anywhere with nothing but `npx tsx scripts/src/test-key-lifecycle.ts`.
 *
 * Run: npx tsx scripts/src/test-key-lifecycle.ts
 */
import assert from "node:assert/strict";
import {
  canSign,
  canVerify,
  mergeVerificationKeys,
  type JwtKeyLifecycleStatus,
  type JwtKeypair,
  type VerificationKey,
} from "../../artifacts/api-server/src/lib/jwt-keys";

const ALL_STATUSES: JwtKeyLifecycleStatus[] = ["active", "retiring", "retired"];
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

console.log("canSign()");

test("only 'active' may sign", () => {
  assert.equal(canSign("active"), true);
  assert.equal(canSign("retiring"), false);
  assert.equal(canSign("retired"), false);
});

test("canSign() is total over every known lifecycle status", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(typeof canSign(status), "boolean");
  }
});

console.log("canVerify()");

test("'active' and 'retiring' may verify; 'retired' may not", () => {
  assert.equal(canVerify("active"), true);
  assert.equal(canVerify("retiring"), true);
  assert.equal(canVerify("retired"), false);
});

test("every signing-eligible status is also verify-eligible (a key that can sign can always verify its own tokens)", () => {
  for (const status of ALL_STATUSES) {
    if (canSign(status)) assert.equal(canVerify(status), true);
  }
});

test("canVerify() is total over every known lifecycle status", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(typeof canVerify(status), "boolean");
  }
});

console.log("mergeVerificationKeys() agrees with canVerify() (Phase 1D-a regression check)");

test("a 'retiring' DB key — grace period — still verifies", () => {
  const dbKeys: VerificationKey[] = [{ kid: "db-retiring", publicKey: "PUB-R", status: "retiring" }];
  const result = mergeVerificationKeys(dbKeys, envKeypair);
  assert.ok(result.some((k) => k.kid === "db-retiring"));
});

test("exactly one 'active' key survives the merge when the DB's active row matches the env kid (the steady-state case once 1D-d writes rotations)", () => {
  const dbKeys: VerificationKey[] = [
    { kid: envKeypair.kid, publicKey: "PUB-A", status: "active" }, // matches AYZEN_JWT_KID, per migration 078's own invariant
    { kid: "db-retiring", publicKey: "PUB-R", status: "retiring" },
  ];
  const result = mergeVerificationKeys(dbKeys, envKeypair);
  const activeKeys = result.filter((k) => k.status === "active");
  assert.equal(activeKeys.length, 1);
  assert.equal(activeKeys[0].kid, envKeypair.kid); // the DB row wins (Map.set overwrite order), not a duplicate env fallback
});

test("an 'active' DB row under a DIFFERENT kid than the env keypair produces two active entries — the drift warnIfMultipleActive() exists to catch", () => {
  // Today (pre-1D-d) this is the actual state of the world whenever
  // jwt_signing_keys has ANY row at all: the table has no write path yet,
  // so a manually-inserted 'active' row will almost never share a kid with
  // whatever AYZEN_JWT_KID currently is. This is exactly the scenario
  // warnIfMultipleActive() logs on — asserted here so that behavior stays
  // documented and doesn't silently change.
  const dbKeys: VerificationKey[] = [{ kid: "db-active-other", publicKey: "PUB-A", status: "active" }];
  const result = mergeVerificationKeys(dbKeys, envKeypair);
  const activeKeys = result.filter((k) => k.status === "active");
  assert.equal(activeKeys.length, 2);
});

console.log("\nAll Phase 1D-c key-lifecycle tests passed.");
