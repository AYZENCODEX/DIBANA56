/**
 * scripts/src/test-oidc-backchannel-logout-monitoring.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-d tests.
 *
 * Covers `lib/oidc-logout-propagation.ts`'s 6e-d (Monitoring) addition —
 * specifically `computeBackchannelLogoutQueueHealth()`, the one piece of
 * 6e-d that is pure/side-effect-free (takes an already-built
 * `BackchannelLogoutQueueStats` object, returns a verdict — no DB, no
 * clock read beyond what the caller already put in the stats object).
 * Same "test the pure calculation against hand-built input" precedent
 * `test-oidc-backchannel-logout-queue.ts` (6e-c) already set for
 * `nextBackchannelLogoutRetryDelayMs()`.
 *
 * DB-DEPENDENT PARTS NOT EXERCISED HERE (same "hand-verify against a live
 * dev DB" precedent 6e-b/6e-c's own test scripts already set):
 *   - `getBackchannelLogoutQueueStats()` — four real queries against
 *     `ayzen_oidc_backchannel_logout_queue`.
 *   - `evaluateBackchannelLogoutQueueHealth()` — thin wrapper around the
 *     above plus this file's own pure function; nothing new to test once
 *     both halves are covered separately.
 *   - `alertAdminsOfDeadLetteredBackchannelLogout()` — a real `usersTable`
 *     query plus real `sendEmail()` calls.
 * Once a real dev `DATABASE_URL`/email config is available: dead-letter a
 * row via the same manual flow 6e-c's own test file describes (force
 * `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS` consecutive failures), then confirm
 * `GET /api/admin/oidc-backchannel-logout/status` reflects it in
 * `countsInWindow.deadLetter`/`recentDeadLetters`, and that the admin
 * alert email actually arrives.
 *
 * ENVIRONMENTAL CONSTRAINT (this pass): no network/`pnpm install` access in
 * this sandbox, so this script (like every prior sub-phase's own test
 * script) has not actually been RUN here — it follows the same
 * `npx tsx scripts/src/...` convention and should be run for real in a dev
 * environment with `pnpm install` already done.
 *
 * Run: npx tsx scripts/src/test-oidc-backchannel-logout-monitoring.ts
 */
import assert from "node:assert/strict";
import {
  computeBackchannelLogoutQueueHealth,
  DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS,
  type BackchannelLogoutQueueStats,
} from "../../artifacts/api-server/src/lib/oidc-logout-propagation";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

/** Hand-built base stats — a quiet, healthy queue. Individual tests override just the field(s) that matter for that case, same "start from a known-good baseline, mutate one thing" shape as most fixture-based tests. */
function baseStats(overrides: Partial<BackchannelLogoutQueueStats> = {}): BackchannelLogoutQueueStats {
  return {
    windowMs: 60 * 60_000,
    countsInWindow: { pending: 0, sending: 0, delivered: 3, deadLetter: 0 },
    countsAllTime: { pending: 0, sending: 0, delivered: 40, deadLetter: 2 },
    oldestPendingAgeMs: null,
    recentDeadLetters: [],
    ...overrides,
  };
}

console.log("computeBackchannelLogoutQueueHealth() — 6e-d");

test("a quiet queue (no dead letters, nothing pending) is healthy", () => {
  const result = computeBackchannelLogoutQueueHealth(baseStats());
  assert.equal(result.healthy, true);
  assert.deepEqual(result.reasons, []);
});

test("dead letters within window but under the threshold stay healthy", () => {
  const stats = baseStats({
    countsInWindow: { pending: 0, sending: 0, delivered: 3, deadLetter: DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS.maxDeadLettersInWindow },
  });
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.equal(result.healthy, true, "count equal to the threshold should not itself trip it (strictly greater-than)");
});

test("dead letters exceeding the threshold report unhealthy with a reason", () => {
  const stats = baseStats({
    countsInWindow: { pending: 0, sending: 0, delivered: 3, deadLetter: DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS.maxDeadLettersInWindow + 1 },
  });
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.equal(result.healthy, false);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /dead-lettered/);
});

test("a pending row younger than the backlog threshold stays healthy", () => {
  const stats = baseStats({ oldestPendingAgeMs: DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS.maxPendingBacklogAgeMs - 1_000 });
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.equal(result.healthy, true);
});

test("a pending row older than the backlog threshold reports unhealthy — the stalled-worker case", () => {
  const stats = baseStats({ oldestPendingAgeMs: DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS.maxPendingBacklogAgeMs + 1_000 });
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.equal(result.healthy, false);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /retry worker may not be running/);
});

test("both thresholds crossed at once produces both reasons, not just the first", () => {
  const stats = baseStats({
    countsInWindow: { pending: 0, sending: 0, delivered: 0, deadLetter: DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS.maxDeadLettersInWindow + 3 },
    oldestPendingAgeMs: DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS.maxPendingBacklogAgeMs * 5,
  });
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.equal(result.healthy, false);
  assert.equal(result.reasons.length, 2);
});

test("null oldestPendingAgeMs (nothing pending) never trips the backlog check", () => {
  const stats = baseStats({ oldestPendingAgeMs: null });
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.equal(result.healthy, true);
});

test("stats/thresholds are echoed back unchanged on the result", () => {
  const stats = baseStats();
  const result = computeBackchannelLogoutQueueHealth(stats);
  assert.deepEqual(result.stats, stats);
  assert.deepEqual(result.thresholds, DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS);
});

console.log("\nAll 6e-d monitoring tests passed.");
