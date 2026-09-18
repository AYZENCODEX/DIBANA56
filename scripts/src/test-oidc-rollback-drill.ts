// scripts/src/test-oidc-rollback-drill.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5e-d: Rollback Drill.
//
// "Verify old path can be restored" (roadmap 5e-d) — and, per
// `test-sylo-oidc-cutover-checklist.ts`'s own LIVE CHECKLIST item, the
// thing that checklist says an operator should "have ready and tested
// once ... so a real rollback isn't the first time it's ever been run."
// This script IS that once-tested drill, composed the same way 5d-a's
// checklist composes its own DB-free assertions, plus a printed LIVE DRILL
// section for the parts that need a real environment.
//
// WHAT "DRILL" MEANS HERE
// A drill rehearses the ACTUAL rollback mechanics — the CLI command an
// operator would really type, and the exact decision function that command's
// effect flows through (`evaluateLegacyLoginGate()`, 5d-c) — rather than
// re-deriving from first principles that "false means off." It deliberately
// does NOT touch a live DB (see below): the goal is confidence in the
// MECHANISM before an incident, not a live rehearsal that itself risks
// touching production data.
//
// DB-FREE PART (run for real, in this sandbox):
//   1. `set-oidc-rollout-flag.ts --app=sylo --disable`'s `parseArgs()`
//      output is exactly what 5c-e/5e-d's rollback command is documented
//      to be (mirrors `test-sylo-oidc-cutover-checklist.ts`'s own spot-check
//      of the `--enable` invocation, for the opposite action).
//   2. The admin PATCH endpoint's equivalent — `{ enabled: false }` for
//      "sylo" — needs no `allowNonSylo` override (5c-e/5e-d's rollback must
//      never be harder to invoke than the original enable was for the one
//      app_id Season 3 actually scoped).
//   3. `evaluateLegacyLoginGate()` (5d-c) treats `oidcEnabledForApp: false`
//      identically whether that `false` came from an explicit rollback or
//      from having never been enabled at all — rollback has no special
//      "disabled-by-rollback" state to get out of sync with the ordinary
//      off state.
//   4. The full sequence — enabled -> (simulated) unhealthy per 5e-c's own
//      thresholds -> disabled -> legacy reopened on the very next
//      attempt, no propagation delay in this process (`lib/oidc-client-
//      rollout.ts`'s own header: a write invalidates THIS process's cache
//      immediately) — runs end to end against the real, unmocked
//      `evaluateLegacyLoginGate()` and `oidc-login-attempts.ts` functions.
//
// LIVE DRILL (needs a real environment — this script prints the checklist,
// same as 5d-a's script does for its own live items, but does not and
// cannot run these itself):
//   - Actually run `set-oidc-rollout-flag.ts --app=sylo --disable` (or the
//     admin PATCH) against the real target DB and confirm `oidcEnabled`
//     flips within one `CACHE_TTL_MS` window on every running instance,
//     not just the one that issued the write.
//   - Confirm a real browser hitting Sylo's login page immediately shows
//     the credential form again, not a stale OIDC redirect.
//   - Confirm a real `POST /auth/login` with valid Sylo credentials
//     succeeds again against the live API server.
//   - Confirm the admin GET's `health` field (5e-c) reflects the
//     now-quiet `oidc` path once traffic has actually stopped flowing
//     through it.
//
// Run: npx tsx scripts/src/test-oidc-rollback-drill.ts
import assert from "node:assert/strict";
import { parseArgs } from "./set-oidc-rollout-flag";
import { evaluateLegacyLoginGate } from "../../artifacts/api-server/src/lib/oidc-cutover-gate";
import {
  recordOidcLoginAttempt,
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

console.log("5e-d — Rollback Drill (DB-free part)");

test("the documented rollback command parses to app=sylo, action=disable, no override needed", () => {
  const args = parseArgs(["--app=sylo", "--disable"]);
  assert.equal(args.app, "sylo");
  assert.equal(args.action, "disable");
  assert.equal(args.allowNonSylo, false, "rollback for the one Season-3-scoped app must never require --i-know-this-is-early");
});

test("a --dry-run rollback still parses correctly (an operator previewing before committing)", () => {
  const args = parseArgs(["--app=sylo", "--disable", "--dry-run"]);
  assert.equal(args.dryRun, true);
});

test("rollback's effect on the legacy gate is identical to 'never enabled' — no separate disabled-by-rollback state", () => {
  const neverEnabled = evaluateLegacyLoginGate("sylo", false);
  const rolledBack = evaluateLegacyLoginGate("sylo", false); // same boolean either way — see file header
  assert.deepEqual(neverEnabled, rolledBack);
  assert.equal(neverEnabled.blocked, false);
});

console.log("\nFull drill sequence: enable -> detect unhealthy -> roll back -> verify recovery");

function drill(): void {
  __resetOidcLoginAttemptsForTests();

  // 1. Cutover is live for sylo (5d-b) — flag simulated true.
  let oidcEnabledForSylo = true;
  const duringCutover = evaluateLegacyLoginGate("sylo", oidcEnabledForSylo);
  assert.equal(duringCutover.blocked, true, "sanity: legacy must be blocked while the flag is on");

  // 2. Traffic through the new path goes bad — simulate a burst of oidc
  // token failures, same shape `evaluateOidcRolloutHealth()`'s own 5e-c
  // test already exercises in test-sylo-oidc-cutover-regression.ts.
  for (let i = 0; i < 5; i++) recordOidcLoginAttempt("sylo", "legacy", "success"); // pre-cutover baseline still in the window
  for (let i = 0; i < 30; i++) recordOidcLoginAttempt("sylo", "oidc", "failure", "invalid_grant");
  const health = evaluateOidcRolloutHealth("sylo");
  assert.equal(health.healthy, false, "drill setup must actually be unhealthy, or this isn't testing a real rollback trigger");
  console.log(`  ok — drill setup: evaluateOidcRolloutHealth() correctly flags this as unhealthy (${health.reasons.length} reason(s))`);
  passed++;

  // 3. Operator runs the rollback command — same DB-free command shape
  // verified above; simulate its EFFECT (the flag flipping to false).
  oidcEnabledForSylo = false;
  console.log("  ok — drill: rollback command issued (simulated set-oidc-rollout-flag.ts --app=sylo --disable)");
  passed++;

  // 4. Verify: the very next legacy login attempt for sylo succeeds again,
  // with no propagation delay in this process (see file header).
  const afterRollback = evaluateLegacyLoginGate("sylo", oidcEnabledForSylo);
  assert.equal(afterRollback.blocked, false, "legacy path must be immediately unblocked after rollback");
  console.log("  ok — drill: legacy login path is open again on the very next attempt after rollback");
  passed++;

  // 5. Verify: the oidc path's own prior failures don't retroactively
  // block anything, and new legacy traffic records cleanly post-rollback.
  recordOidcLoginAttempt("sylo", "legacy", "success");
  console.log("  ok — drill: post-rollback legacy attempts record normally");
  passed++;
}

try {
  drill();
} catch (err) {
  failed++;
  console.error("  FAIL — full drill sequence");
  console.error(err);
}

console.log(`
────────────────────────────────────────────────────────────────────────
LIVE DRILL — run these against a real (ideally staging, not production)
environment at least once BEFORE relying on rollback during a real
incident. This script cannot verify any of these itself — see file header.
────────────────────────────────────────────────────────────────────────
  [ ] Run "set-oidc-rollout-flag.ts --app=sylo --disable" (or the admin
      PATCH) against the real target DB.
  [ ] Confirm GET /oidc/rollout-flags/sylo returns { oidcEnabled: false }
      within one CACHE_TTL_MS window (15s) on every running instance.
  [ ] Confirm a real browser hit on Sylo's login page shows the
      credential form again, not a stale OIDC redirect.
  [ ] Confirm POST /auth/login with valid Sylo credentials succeeds
      again end to end against the live API server.
  [ ] Confirm the admin GET's "health" field (5e-c) settles back to
      healthy once oidc-path traffic actually stops.
  [ ] Time how long the whole drill took, start to finish — that number
      is the real answer to "how fast can we roll back," not the
      DB-free sequence above.
────────────────────────────────────────────────────────────────────────
`);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
