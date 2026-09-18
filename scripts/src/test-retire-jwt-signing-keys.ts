/**
 * scripts/src/test-retire-jwt-signing-keys.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1D-e: unit tests for the pure retention
 * functions (isRetirementSafe(), retirementEligibleAt(), planRetirement())
 * in artifacts/api-server/src/lib/jwt-keys.ts, plus a boundary check on the
 * RETENTION_PERIOD_MS constant itself.
 *
 * Same shape as scripts/src/test-verification-keys.ts (1D-a),
 * test-resolve-verification-keys.ts (1D-b), test-key-lifecycle.ts (1D-c)
 * and test-rotate-jwt-signing-key.ts (1D-d) — exercises ONLY pure, DB-free
 * functions, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-retire-jwt-signing-keys.ts`.
 *
 * Run: npx tsx scripts/src/test-retire-jwt-signing-keys.ts
 */
import assert from "node:assert/strict";
import {
  MAX_TOKEN_LIFETIME_MS,
  CLOCK_SKEW_ALLOWANCE_MS,
  RETENTION_PERIOD_MS,
  retirementEligibleAt,
  isRetirementSafe,
  planRetirement,
  type RetiringKeyRow,
} from "../../artifacts/api-server/src/lib/jwt-keys";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("RETENTION_PERIOD_MS");

test("retention period is exactly max token lifetime plus clock-skew allowance — no silent third term", () => {
  assert.equal(RETENTION_PERIOD_MS, MAX_TOKEN_LIFETIME_MS + CLOCK_SKEW_ALLOWANCE_MS);
});

test("max token lifetime matches lib/jwt.ts's DEFAULT_EXPIRY ('7d') — update both together if that ever changes", () => {
  assert.equal(MAX_TOKEN_LIFETIME_MS, 7 * 24 * 60 * 60 * 1000);
});

console.log("retirementEligibleAt()");

test("eligible instant is retiringAt + RETENTION_PERIOD_MS, nothing more", () => {
  const retiringAt = new Date("2026-01-01T00:00:00.000Z");
  const expected = new Date(retiringAt.getTime() + RETENTION_PERIOD_MS);
  assert.equal(retirementEligibleAt(retiringAt).getTime(), expected.getTime());
});

console.log("isRetirementSafe()");

test("well before the retention window has elapsed → not safe", () => {
  const retiringAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(retiringAt.getTime() + 1 * 24 * 60 * 60 * 1000); // 1 day later
  assert.equal(isRetirementSafe(retiringAt, now), false);
});

test("exactly at the eligible instant → safe (boundary is inclusive)", () => {
  const retiringAt = new Date("2026-01-01T00:00:00.000Z");
  const now = retirementEligibleAt(retiringAt);
  assert.equal(isRetirementSafe(retiringAt, now), true);
});

test("one millisecond before the eligible instant → not safe (boundary doesn't round in the unsafe direction)", () => {
  const retiringAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(retirementEligibleAt(retiringAt).getTime() - 1);
  assert.equal(isRetirementSafe(retiringAt, now), false);
});

test("well after the retention window has elapsed → safe", () => {
  const retiringAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(retiringAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days later
  assert.equal(isRetirementSafe(retiringAt, now), true);
});

test("exactly max-token-lifetime later, with no skew allowance yet elapsed → still not safe", () => {
  // Regression guard: RETENTION_PERIOD_MS must actually include the skew
  // allowance, not just the raw token lifetime — a key retired the instant
  // the longest possible token could have expired, with zero margin, is
  // exactly the premature-removal case this sub-phase exists to prevent.
  const retiringAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(retiringAt.getTime() + MAX_TOKEN_LIFETIME_MS);
  assert.equal(isRetirementSafe(retiringAt, now), false);
});

console.log("planRetirement()");

test("mix of eligible and not-yet-eligible rows are split correctly", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const rows: RetiringKeyRow[] = [
    { kid: "old-enough", retiringAt: new Date(now.getTime() - RETENTION_PERIOD_MS - 1000) },
    { kid: "too-recent", retiringAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000) },
  ];
  const decisions = planRetirement(rows, now);
  assert.deepEqual(
    decisions.map((d) => d.kid),
    ["old-enough", "too-recent"],
  );
  assert.equal(decisions[0].safe, true);
  assert.equal(decisions[1].safe, false);
  assert.ok(!decisions[1].safe && decisions[1].eligibleAt.getTime() > now.getTime());
});

test("empty input → empty output, no crash on nothing to plan", () => {
  assert.deepEqual(planRetirement([], new Date()), []);
});

test("defaults `now` to the real clock when omitted — a row retiring far in the past is safe under the real clock", () => {
  const decisions = planRetirement([{ kid: "ancient", retiringAt: new Date("2000-01-01T00:00:00.000Z") }]);
  assert.equal(decisions[0].safe, true);
});

console.log("\nAll retire-jwt-signing-keys (1D-e) tests passed.");
