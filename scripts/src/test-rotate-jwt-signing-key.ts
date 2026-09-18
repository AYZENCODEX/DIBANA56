/**
 * scripts/src/test-rotate-jwt-signing-key.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1D-d: unit tests for planRotation(), the
 * pure decision step in scripts/src/rotate-jwt-signing-key.ts that decides
 * whether a rotation is safe to run and what it should do, WITHOUT touching
 * the database or generating a keypair.
 *
 * Same shape as scripts/src/test-verification-keys.ts (1D-a),
 * test-resolve-verification-keys.ts (1D-b) and test-key-lifecycle.ts (1D-c)
 * — runnable anywhere with nothing but
 * `npx tsx scripts/src/test-rotate-jwt-signing-key.ts`.
 *
 * Run: npx tsx scripts/src/test-rotate-jwt-signing-key.ts
 */
import assert from "node:assert/strict";
import { planRotation } from "./rotate-jwt-signing-key";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("planRotation()");

test("zero active DB rows → bootstrap mode, outgoing kid is the env kid", () => {
  const plan = planRotation([], "env-kid-1");
  assert.deepEqual(plan, { ok: true, mode: "bootstrap", outgoingKid: "env-kid-1" });
});

test("one active DB row matching the env kid → retire-existing mode", () => {
  const plan = planRotation([{ kid: "env-kid-1" }], "env-kid-1");
  assert.deepEqual(plan, { ok: true, mode: "retire-existing", outgoingKid: "env-kid-1" });
});

test("one active DB row NOT matching the env kid → refuses (drifted state)", () => {
  const plan = planRotation([{ kid: "db-kid-other" }], "env-kid-1");
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.match(plan.reason, /diverged/);
  }
});

test("more than one active DB row → refuses (should be impossible, refuses anyway)", () => {
  const plan = planRotation([{ kid: "a" }, { kid: "b" }], "env-kid-1");
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.match(plan.reason, /expected at most one/);
  }
});

test("a real rotation sequence: bootstrap once, then retire-existing on the next run against the same kid", () => {
  // Simulates running the script twice in a row without ever updating the
  // env kid in between (i.e. step 2 of the two-step rotation, "update env
  // and restart", hasn't happened yet) — planRotation() alone can't know
  // that a first rotation already ran; this just checks both individual
  // calls resolve consistently given their own inputs.
  const first = planRotation([], "env-kid-1");
  assert.equal(first.ok, true);
  const second = planRotation([{ kid: "env-kid-1" }], "env-kid-1");
  assert.equal(second.ok, true);
});

console.log("\nAll Phase 1D-d rotation-planning tests passed.");
