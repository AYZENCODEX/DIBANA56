// scripts/src/test-sylo-oidc-cutover-regression.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5d-d: Regression Test.
//
// "Verify all major Sylo auth flows" (roadmap 5d-d), run right after 5d-b's
// cutover (or after a 5e-d rollback drill) actually flips the flag. This is
// the DB-free, composed slice of that verification — same "compose what's
// already been individually tested into one script" discipline
// `test-sylo-oidc-cutover-checklist.ts` (5d-a) already established for the
// PRE-cutover side; this is its POST-cutover twin.
//
// WHAT THIS SCRIPT PROVES, DB-FREE
//   1. Legacy login is blocked for Sylo once its flag is on (5d-c), and
//      the block itself is recorded as a monitored failure (5e-a/5e-b),
//      not silently dropped.
//   2. Legacy login for every OTHER app_id is completely unaffected by
//      Sylo's flag being on — 5d's "Sylo only" scope holds under the
//      gate's actual decision function, not just by convention.
//   3. The OIDC token path's own success/failure recording (5c-d) and
//      per-error-code breakdown (5e-a/5e-b) still work exactly as before
//      cutover — cutover changes WHICH path is primary, not how either
//      path is observed.
//   4. Rollback (flipping the flag back to false) immediately reopens the
//      legacy path for Sylo — no separate "undo the cutover" step exists
//      to forget, because 5d-c/5d-b are the same flag (see
//      lib/oidc-cutover-gate.ts's own header).
//   5. `evaluateOidcRolloutHealth()` (5e-c) reads the exact same
//      before/after numbers this script generates and reports healthy
//      when nothing is actually broken — a smoke test against 5e-c's own
//      false-positive rate, not just its true-positive one.
//
// WHAT THIS SCRIPT DOES NOT PROVE (needs a live DB / real HTTP server /
// real browser — same sandbox limitation every earlier CHANGES doc in this
// roadmap already discloses):
//   - That `getOidcRolloutFlag("sylo")` itself reads the same row
//     `set-oidc-rollout-flag.ts --enable` wrote (needs Postgres).
//   - That `POST /auth/login` actually returns HTTP 403 with this body
//     (needs express + a live DB — `evaluateLegacyLoginGate()`'s own
//     decision table is unit-tested DB-free in
//     `test-oidc-cutover-gate.ts`, 5d-c; this script proves the
//     COMPOSITION, not the HTTP transport).
//   - A real browser completing discovery -> authorize -> callback ->
//     PKCE -> token -> session for a live Sylo test account — that is
//     `test-sylo-oidc-cutover-checklist.ts`'s own `LIVE CHECKLIST`
//     (5d-a), unchanged and still required before a real cutover.
//
// Run: npx tsx scripts/src/test-sylo-oidc-cutover-regression.ts
import assert from "node:assert/strict";
import { evaluateLegacyLoginGate } from "../../artifacts/api-server/src/lib/oidc-cutover-gate";
import {
  recordOidcLoginAttempt,
  getOidcLoginAttemptStats,
  evaluateOidcRolloutHealth,
  __resetOidcLoginAttemptsForTests,
} from "../../artifacts/api-server/src/lib/oidc-login-attempts";

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

/**
 * Simulates what `routes/auth.ts`'s POST /auth/login handler now does
 * (5d-c): given a resolved app_id and the CURRENT (simulated) rollout-flag
 * value for it, either records+returns a block, or falls through to a
 * simulated legacy credential check. `credentialsOk` stands in for the
 * bcrypt compare a real request would do — this script never touches
 * password hashing, only the branch structure around it.
 */
function simulateLegacyLoginAttempt(appId: string | null, oidcEnabledForApp: boolean, credentialsOk: boolean): { status: number; body: Record<string, unknown> } {
  if (appId) {
    const gate = evaluateLegacyLoginGate(appId, oidcEnabledForApp);
    if (gate.blocked) {
      recordOidcLoginAttempt(appId, "legacy", "failure", gate.code);
      return { status: 403, body: { error: "This app now signs in with OIDC.", code: gate.code } };
    }
  }
  if (!credentialsOk) {
    if (appId) recordOidcLoginAttempt(appId, "legacy", "failure");
    return { status: 401, body: { error: "Invalid credentials" } };
  }
  if (appId) recordOidcLoginAttempt(appId, "legacy", "success");
  return { status: 200, body: { message: "Signed in" } };
}

console.log("5d-d — Sylo OIDC Cutover Regression");

test("BEFORE cutover: legacy login for sylo with good credentials still succeeds (5c-b baseline)", () => {
  __resetOidcLoginAttemptsForTests();
  const result = simulateLegacyLoginAttempt("sylo", /* oidcEnabledForApp */ false, /* credentialsOk */ true);
  assert.equal(result.status, 200);
  assert.equal(getOidcLoginAttemptStats("sylo").legacy.success, 1);
});

test("AFTER cutover: legacy login for sylo is blocked regardless of credential correctness (5d-c)", () => {
  __resetOidcLoginAttemptsForTests();
  const withGoodCreds = simulateLegacyLoginAttempt("sylo", /* oidcEnabledForApp */ true, /* credentialsOk */ true);
  assert.equal(withGoodCreds.status, 403);
  assert.equal(withGoodCreds.body.code, "OIDC_REQUIRED");
  const withBadCreds = simulateLegacyLoginAttempt("sylo", true, false);
  assert.equal(withBadCreds.status, 403);
});

test("AFTER cutover: the block is recorded as a monitored legacy failure, not silently dropped (5e-a/5e-b)", () => {
  __resetOidcLoginAttemptsForTests();
  simulateLegacyLoginAttempt("sylo", true, true);
  const stats = getOidcLoginAttemptStats("sylo");
  assert.equal(stats.legacy.failure, 1);
  assert.equal(stats.legacy.topErrors[0]?.code, "OIDC_REQUIRED");
});

test("AFTER Sylo's cutover: a DIFFERENT app's legacy login is completely unaffected (5d's Sylo-only scope)", () => {
  __resetOidcLoginAttemptsForTests();
  // Sylo's own flag is on; ryft's is deliberately NOT — this script never
  // even needs a ryft flag value, since evaluateLegacyLoginGate() only
  // ever blocks appId==="sylo" in the first place (see that file's own
  // CUTOVER_SCOPED_APP_IDS).
  const ryftResult = simulateLegacyLoginAttempt("ryft", /* oidcEnabledForApp (irrelevant for ryft) */ true, /* credentialsOk */ true);
  assert.equal(ryftResult.status, 200);
  assert.equal(getOidcLoginAttemptStats("ryft").legacy.success, 1);
  assert.equal(getOidcLoginAttemptStats("sylo").legacy.total, 0, "sylo's counters must not have been touched by a ryft attempt");
});

test("the OIDC ('oidc') path's own success/failure + error-code recording is untouched by 5d-c (5c-d/5e-a/5e-b unchanged)", () => {
  __resetOidcLoginAttemptsForTests();
  recordOidcLoginAttempt("sylo", "oidc", "success");
  recordOidcLoginAttempt("sylo", "oidc", "failure", "invalid_grant");
  const stats = getOidcLoginAttemptStats("sylo");
  assert.equal(stats.oidc.success, 1);
  assert.equal(stats.oidc.failure, 1);
  assert.equal(stats.oidc.topErrors[0]?.code, "invalid_grant");
});

test("ROLLBACK: flipping the (simulated) flag back to false immediately reopens legacy login for sylo (5c-e/5e-d — same flag, no second step)", () => {
  __resetOidcLoginAttemptsForTests();
  const blocked = simulateLegacyLoginAttempt("sylo", true, true);
  assert.equal(blocked.status, 403);
  const afterRollback = simulateLegacyLoginAttempt("sylo", /* oidcEnabledForApp */ false, /* credentialsOk */ true);
  assert.equal(afterRollback.status, 200, "the very next attempt after rollback must succeed with no separate re-enable step");
});

test("evaluateOidcRolloutHealth() reports healthy when the new path is actually fine post-cutover (5e-c smoke test)", () => {
  __resetOidcLoginAttemptsForTests();
  for (let i = 0; i < 25; i++) recordOidcLoginAttempt("sylo", "oidc", "success");
  for (let i = 0; i < 2; i++) recordOidcLoginAttempt("sylo", "oidc", "failure", "invalid_grant");
  const health = evaluateOidcRolloutHealth("sylo");
  assert.equal(health.healthy, true, `expected healthy, got reasons: ${JSON.stringify(health.reasons)}`);
});

test("evaluateOidcRolloutHealth() reports unhealthy when the new path is actually broken post-cutover (5e-c smoke test)", () => {
  __resetOidcLoginAttemptsForTests();
  for (let i = 0; i < 5; i++) recordOidcLoginAttempt("sylo", "legacy", "success"); // legacy's own concurrent baseline stays low-failure
  for (let i = 0; i < 30; i++) recordOidcLoginAttempt("sylo", "oidc", "failure", "invalid_client");
  const health = evaluateOidcRolloutHealth("sylo");
  assert.equal(health.healthy, false);
  assert.ok(health.reasons.length > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
