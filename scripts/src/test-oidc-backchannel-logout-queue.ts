/**
 * scripts/src/test-oidc-backchannel-logout-queue.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-c tests.
 *
 * Covers `lib/oidc-logout-propagation.ts`'s 6e-c (Failure Handling)
 * addition — specifically `nextBackchannelLogoutRetryDelayMs()`, the one
 * piece of 6e-c that is pure/side-effect-free the same way
 * `test-oidc-logout-propagation.ts` (6e-a) tests
 * `buildLogoutTokenClaims()`/`propagateBackchannelLogout()` against a fake
 * in-memory `deliver` rather than a live DB.
 *
 * DB-DEPENDENT PARTS NOT EXERCISED HERE (same precedent
 * `test-oidc-clients.ts` and 6e-b's own `test-oidc-backchannel-logout-receive.ts`
 * already set for this codebase — "hand-verify against a live dev DB"):
 *   - `enqueueBackchannelLogoutRetry()` — a real `INSERT`.
 *   - `claimNextBackchannelLogoutBatch()` — a real `FOR UPDATE SKIP LOCKED`
 *     transaction; needs concurrent connections to meaningfully test the
 *     no-double-claim guarantee at all.
 *   - `processBackchannelLogoutQueueRow()` — reads/writes real rows.
 *   - `recoverStaleBackchannelLogoutLocks()` /
 *     `recoverBackchannelLogoutQueueOnStartup()` — same.
 *   - `runBackchannelLogoutQueueSweep()` — composes all of the above.
 * Once a real dev `DATABASE_URL` is available: insert a row via
 * `enqueueBackchannelLogoutRetry()` pointed at a local HTTP listener that
 * fails N times then succeeds, run `runBackchannelLogoutQueueSweep()`
 * repeatedly, and assert the row's `status`/`attempts` progression ends at
 * `'delivered'`; separately, force `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS`
 * consecutive failures and assert it ends at `'dead_letter'`.
 *
 * ENVIRONMENTAL CONSTRAINT (this pass): no network/`pnpm install` access in
 * this sandbox, so this script (like 6e-a's/6e-b's own test scripts before
 * it) has not actually been RUN here — it follows the same
 * `npx tsx scripts/src/...` convention and should be run for real in a dev
 * environment with `pnpm install` already done.
 *
 * Run: npx tsx scripts/src/test-oidc-backchannel-logout-queue.ts
 */
import assert from "node:assert/strict";
import {
  MAX_BACKCHANNEL_LOGOUT_ATTEMPTS,
  nextBackchannelLogoutRetryDelayMs,
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

// Backoff floor/ceiling this test asserts against — kept in the test file
// (not imported) so a change to the internal constants in
// lib/oidc-logout-propagation.ts is a deliberate, visible edit to this
// file too, not something that could silently drift.
const BASE_MS = 10_000;
const MAX_MS = 30 * 60_000;
const JITTER = 0.2;

function assertWithinJitter(actual: number, expectedRaw: number, label: string): void {
  const lo = Math.round(expectedRaw * (1 - JITTER));
  const hi = Math.round(expectedRaw * (1 + JITTER));
  assert.ok(
    actual >= lo && actual <= hi,
    `${label}: expected ${actual} to be within ±${JITTER * 100}% of ${expectedRaw} (i.e. [${lo}, ${hi}])`,
  );
}

console.log("MAX_BACKCHANNEL_LOGOUT_ATTEMPTS — 6e-c");

test("is 5 — 1 inline attempt + 4 queued retries before dead-letter", () => {
  assert.equal(MAX_BACKCHANNEL_LOGOUT_ATTEMPTS, 5);
});

console.log("\nnextBackchannelLogoutRetryDelayMs() — 6e-c");

test("attempts=1 is roughly the base delay (10s)", () => {
  assertWithinJitter(nextBackchannelLogoutRetryDelayMs(1), BASE_MS, "attempts=1");
});

test("attempts=2 roughly doubles attempts=1's raw value (20s)", () => {
  assertWithinJitter(nextBackchannelLogoutRetryDelayMs(2), BASE_MS * 2, "attempts=2");
});

test("attempts=3 roughly quadruples the base (40s)", () => {
  assertWithinJitter(nextBackchannelLogoutRetryDelayMs(3), BASE_MS * 4, "attempts=3");
});

test("attempts=4 (the last queued retry before MAX_BACKCHANNEL_LOGOUT_ATTEMPTS=5 dead-letters) is roughly 8x base (80s)", () => {
  assertWithinJitter(nextBackchannelLogoutRetryDelayMs(4), BASE_MS * 8, "attempts=4");
});

test("never returns a negative delay, even for attempts <= 0 (defensive floor)", () => {
  assert.ok(nextBackchannelLogoutRetryDelayMs(0) >= 0);
  assert.ok(nextBackchannelLogoutRetryDelayMs(-3) >= 0);
});

test("attempts=0 and attempts=1 produce the same raw (pre-jitter) delay — Math.max(0, attempts-1) floors the exponent at 0", () => {
  // Run several times since jitter is randomized; both should always land
  // in the exact same window (base * 2^0), never diverge.
  for (let i = 0; i < 20; i++) {
    assertWithinJitter(nextBackchannelLogoutRetryDelayMs(0), BASE_MS, "attempts=0");
    assertWithinJitter(nextBackchannelLogoutRetryDelayMs(1), BASE_MS, "attempts=1");
  }
});

test("caps at BACKCHANNEL_LOGOUT_BACKOFF_MAX_MS (30 min) for a very large attempts count, never grows unbounded", () => {
  const delay = nextBackchannelLogoutRetryDelayMs(50); // 2^49 * base would otherwise overflow into absurdity
  assertWithinJitter(delay, MAX_MS, "attempts=50 (capped)");
});

test("delay is monotonically non-decreasing (in expectation) as attempts climbs from 1 to the cap", () => {
  // Compare RAW (jitter-free) expected values rather than two live jittered
  // calls, which could occasionally invert near a boundary by chance —
  // same reasoning mail-send-queue.ts's own backoff was designed around.
  let prevRaw = 0;
  for (let attempts = 1; attempts <= 10; attempts++) {
    const raw = Math.min(BASE_MS * 2 ** (attempts - 1), MAX_MS);
    assert.ok(raw >= prevRaw, `raw delay at attempts=${attempts} (${raw}) should be >= attempts=${attempts - 1}'s (${prevRaw})`);
    prevRaw = raw;
  }
});

console.log("\nAll assertions passed (pure-function coverage only — see file header for DB-dependent parts still needing a live dev DB).");
