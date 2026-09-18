// scripts/src/test-oidc-cutover-gate.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5d-c tests.
//
// Covers `lib/oidc-cutover-gate.ts`'s `evaluateLegacyLoginGate()` — the one
// piece of 5d-c's logic with a real decision table, and (per that file's
// own header) DB-free and Express-free by design. Same "inject the
// effectful boundary, unit-test the pure decision" discipline every other
// test file in this roadmap already follows.
//
// NOT covered here (needs a live DB / real HTTP server — same sandbox
// limitation every earlier CHANGES doc in this roadmap already discloses):
//   - lib/oidc-client-rollout.ts's getOidcRolloutFlag() (touches Postgres).
//   - routes/auth.ts's POST /auth/login handler actually calling this gate
//     and returning 403 — would need express + a live DB the same way
//     test-openid-configuration-endpoint.ts already does for 1E-e. See
//     test-sylo-oidc-cutover-regression.ts (5d-d) for the composed,
//     still-DB-free regression suite that exercises this gate alongside
//     everything else 5c/5d built.
//
// Run: npx tsx scripts/src/test-oidc-cutover-gate.ts
import assert from "node:assert/strict";
import { evaluateLegacyLoginGate } from "../../artifacts/api-server/src/lib/oidc-cutover-gate";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
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

console.log("evaluateLegacyLoginGate()");

test("null appId (unresolved app) never blocks, flag on or off", () => {
  assert.equal(evaluateLegacyLoginGate(null, true).blocked, false);
  assert.equal(evaluateLegacyLoginGate(null, false).blocked, false);
});

test("sylo, flag off -> not blocked (5c-b: old path stays intact)", () => {
  const result = evaluateLegacyLoginGate("sylo", false);
  assert.equal(result.blocked, false);
  assert.equal(result.code, undefined);
});

test("sylo, flag on -> blocked with OIDC_REQUIRED (5d-c)", () => {
  const result = evaluateLegacyLoginGate("sylo", true);
  assert.equal(result.blocked, true);
  assert.equal(result.code, "OIDC_REQUIRED");
});

test("a non-Sylo app_id is never blocked, even if its flag were somehow on (5d's own Sylo-only scope)", () => {
  assert.equal(evaluateLegacyLoginGate("ryft", true).blocked, false);
  assert.equal(evaluateLegacyLoginGate("wisp", true).blocked, false);
});

test("appId case is the caller's responsibility — this function does not itself normalize", () => {
  // resolveLegacyLoginAppId() (5c-d) already always returns lowercase
  // "sylo" or null, so the route never actually calls this with mixed
  // case — documented here so a future caller doesn't assume otherwise.
  assert.equal(evaluateLegacyLoginGate("SYLO", true).blocked, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
