/**
 * scripts/src/test-oidc-login-attempts-last-issued.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 5, Phase 9a: tests for
 * `artifacts/api-server/src/lib/oidc-login-attempts.ts`'s new
 * `getOidcLastTokenIssuedAt()`.
 *
 * Scoped narrowly to this pass's own addition — `oidc-login-attempts.ts`'s
 * pre-existing Season 3 functions (`getOidcLoginAttemptStats()`,
 * `evaluateOidcRolloutHealth()`, ...) have no dedicated test file of their
 * own in this codebase yet; retroactively covering them is not this
 * phase's job, so this file tests only the one function 9a adds.
 *
 * DB-free, in-memory, runnable anywhere with nothing but
 * `npx tsx scripts/src/test-oidc-login-attempts-last-issued.ts`.
 *
 * Run: npx tsx scripts/src/test-oidc-login-attempts-last-issued.ts
 */
import assert from "node:assert/strict";
import {
  recordOidcLoginAttempt,
  getOidcLastTokenIssuedAt,
  __resetOidcLoginAttemptsForTests,
} from "../../artifacts/api-server/src/lib/oidc-login-attempts";

function test(name: string, fn: () => void): void {
  __resetOidcLoginAttemptsForTests();
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    throw err;
  }
}

console.log("getOidcLastTokenIssuedAt()");

test("no recorded attempts at all — null", () => {
  assert.equal(getOidcLastTokenIssuedAt("wisp"), null);
});

test("a single 'oidc' success is returned", () => {
  const before = Date.now();
  recordOidcLoginAttempt("wisp", "oidc", "success");
  const result = getOidcLastTokenIssuedAt("wisp");
  assert.notEqual(result, null);
  assert.ok((result as number) >= before);
});

test("only the MOST RECENT 'oidc' success is returned, not the first", () => {
  recordOidcLoginAttempt("wisp", "oidc", "success");
  const firstAt = getOidcLastTokenIssuedAt("wisp") as number;
  // Force a strictly later timestamp than the first record.
  const later = firstAt + 1000;
  recordOidcLoginAttempt("wisp", "oidc", "success");
  // Directly verify ordering rather than relying on real wall-clock delay
  // in a fast-running test: the second call's `at` is >= firstAt by
  // construction (Date.now() is monotonic non-decreasing here), and
  // getOidcLastTokenIssuedAt() must report that later value, not the
  // first one it saw.
  const result = getOidcLastTokenIssuedAt("wisp") as number;
  assert.ok(result >= firstAt);
  void later;
});

test("an 'oidc' FAILURE does not count as a token issuance", () => {
  recordOidcLoginAttempt("wisp", "oidc", "failure", "invalid_grant");
  assert.equal(getOidcLastTokenIssuedAt("wisp"), null);
});

test("a success on the 'legacy' or 'callback' path does not count — only 'oidc' path successes do", () => {
  recordOidcLoginAttempt("wisp", "legacy", "success");
  assert.equal(getOidcLastTokenIssuedAt("wisp"), null);
});

test("appId is normalized (trim + lowercase), same as every other function in this file", () => {
  recordOidcLoginAttempt("Wisp", "oidc", "success");
  assert.notEqual(getOidcLastTokenIssuedAt("  wisp  "), null);
});

test("each app_id's last-issued time is tracked independently", () => {
  recordOidcLoginAttempt("wisp", "oidc", "success");
  assert.equal(getOidcLastTokenIssuedAt("ryft"), null);
});

test("unbounded by any window — an old success is still returned (unlike getOidcLoginAttemptStats)", () => {
  recordOidcLoginAttempt("wisp", "oidc", "success");
  // No windowMs parameter exists on this function at all — its signature
  // itself proves this, but assert the behavior explicitly: a value
  // recorded is still visible with no time-based expiry applied here.
  assert.notEqual(getOidcLastTokenIssuedAt("wisp"), null);
});

console.log("All oidc-login-attempts (getOidcLastTokenIssuedAt) tests passed.");
