/**
 * lib/policy/test-framework/runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21A (Policy Test
 * Framework — declarative model).
 *
 * `runPolicyTestCase()`/`runPolicyTestSuite()` are this sub-phase's whole
 * runtime surface: given a `PolicyTestCase`/`PolicyTestSuite` (./types.ts)
 * and a real engine, actually ask the PDP the GIVEN/WHEN question and
 * check the THEN. `assertPolicyTestSuitePassed()` is the thin
 * `node:assert`-shaped wrapper every `scripts/src/test-policy-*.ts` file
 * can drop straight into its own existing `test()`/`assert` harness (see
 * that convention in e.g. `scripts/src/test-policy-pep.ts`) without this
 * framework inventing a second test runner alongside the one this
 * codebase's `scripts/src/test-policy-*.ts` files already use.
 *
 * ── Never a second way to reach a Decision ────────────────────────────────
 * `runPolicyTestCase()` calls `engine.evaluate()` — the exact same method
 * `authorize()` (Phase 19, ../pep/authorize.ts), `authorizeMany()`
 * (Phase 20, ../pep/authorize-many.ts), and every real route eventually
 * will call. This file never re-implements combining logic, never
 * inspects registered rules directly, and never produces a decision of
 * its own — same "PEP enforces, PDP decides" discipline `../pep/types.ts`
 * documents, here restated as "the test framework asks, it never
 * decides."
 *
 * ── `TestableEngine` is structurally `AuthorizingEngine`, not imported
 *    from `../pep` ─────────────────────────────────────────────────────
 * `../pep/types.ts`'s `AuthorizingEngine` names the identical structural
 * shape (`evaluate(input): Promise<AuthorizationDecision>`) this file
 * needs, but this directory does not import anything from `../pep` —
 * `lib/policy/test-framework` is a PDP-facing testing utility with no
 * Express dependency of its own (it takes a `PolicyEngine`/
 * `PrecedenceEngine` directly, never a `Request`), and importing `../pep`
 * merely to reuse one interface name would give this directory an
 * Express-adjacent dependency it does not actually have. TypeScript
 * interfaces are structural (same reasoning `../pep/types.ts`'s own
 * header already gives for not importing the concrete engine classes) —
 * both real engines already satisfy `TestableEngine` with no change on
 * either side.
 *
 * ── What "pass" means for a case vs. a suite ──────────────────────────────
 * A `PolicyTestCaseResult.passed` is true only when every `then` field the
 * case actually set matches the real decision — an omitted `then` field
 * is never checked (see ./types.ts's own header on that). A
 * `PolicyTestSuiteResult.passed` is true only when EVERY case in the suite
 * passed AND the suite's cases collectively cover all five roadmap
 * categories (./types.ts's `PolicyTestCategory`) — a suite with 40
 * passing cases that all happen to be `"happy_path"` is reported as
 * FAILING, with `missingCategories` naming exactly which of the roadmap's
 * five are absent. This is deliberate: the roadmap's own "every policy
 * should have" wording is a coverage requirement, not merely a
 * suggestion, and a coverage gap is exactly the kind of thing a human
 * reviewer might not notice in a long, all-passing case list.
 */

import type { AuthorizationDecision } from "../types";
import type { BuildAuthorizationRequestInput } from "../authorization-request";
import type { PolicyTestCase, PolicyTestCategory, PolicyTestSuite } from "./types";

/**
 * Structural subset of `PolicyEngine`/`PrecedenceEngine`'s own `evaluate()`
 * — see file header for why this is declared here rather than imported
 * from `../pep/types.ts`'s `AuthorizingEngine`.
 */
export interface TestableEngine {
  evaluate(input: BuildAuthorizationRequestInput): Promise<AuthorizationDecision>;
}

/** The roadmap's own five categories, in the order the roadmap lists them
 *  — used only to produce a stable, deterministic `missingCategories`
 *  ordering (Rule 12), never to imply a required running order for a
 *  suite's own `cases` array (a suite may list its cases in whatever
 *  order reads best). */
const REQUIRED_CATEGORIES: readonly PolicyTestCategory[] = [
  "happy_path",
  "negative_path",
  "boundary",
  "privilege_escalation",
  "tenant_isolation",
];

export interface PolicyTestCaseResult {
  name: string;
  category: PolicyTestCategory;
  passed: boolean;
  /** The real decision the engine produced — always present, pass or
   *  fail, so a failing case's own report can show exactly what actually
   *  happened alongside what was expected (in `failures`). */
  decision: AuthorizationDecision;
  /** Empty when `passed` is true. One human-readable line per mismatched
   *  `then` field — e.g. `"effect: expected ALLOW, got DENY"` — never a
   *  thrown error at this layer (throwing is `assertPolicyTestSuitePassed()`'s
   *  job, below), so a caller can collect every case's result even when
   *  several fail. */
  failures: string[];
}

export interface PolicyTestSuiteResult {
  policyId: string;
  results: PolicyTestCaseResult[];
  /** Every category from `PolicyTestCategory` (./types.ts) with zero
   *  cases in this suite, in the roadmap's own listed order. Empty when
   *  every category has at least one case — never when every category
   *  merely has a PASSING case; a suite can be fully covered and still
   *  have `passed: false` if a covered category's own case fails. */
  missingCategories: PolicyTestCategory[];
  /** True only when every case passed AND `missingCategories` is empty —
   *  see file header's "What 'pass' means for a case vs. a suite". */
  passed: boolean;
}

/**
 * Evaluates ONE case's GIVEN/WHEN against `engine` and checks its THEN.
 * Never throws for a failing case (a mismatch is reported in the returned
 * `failures`, not thrown) — the one exception is whatever
 * `engine.evaluate()`/`buildAuthorizationRequest()` itself would already
 * throw for a genuinely malformed GIVEN (e.g. an invalid `resource.type`
 * — see ../authorization-request.ts's own `assertValidResource()`), which
 * is a case-authoring bug, not a policy failure, and is deliberately left
 * to surface as-is rather than being swallowed into a `failures` string.
 */
export async function runPolicyTestCase(
  engine: TestableEngine,
  testCase: PolicyTestCase,
): Promise<PolicyTestCaseResult> {
  const decision = await engine.evaluate({
    subject: testCase.given.subject,
    action: testCase.when.action,
    resource: testCase.given.resource,
    context: testCase.given.context,
  });

  const failures: string[] = [];

  if (decision.effect !== testCase.then.effect) {
    failures.push(`effect: expected ${testCase.then.effect}, got ${decision.effect}`);
  }
  if (testCase.then.reason !== undefined && decision.reason !== testCase.then.reason) {
    failures.push(`reason: expected ${testCase.then.reason}, got ${decision.reason}`);
  }
  if (testCase.then.policyId !== undefined && decision.policyId !== testCase.then.policyId) {
    failures.push(`policyId: expected ${testCase.then.policyId}, got ${String(decision.policyId)}`);
  }
  if (
    testCase.then.requiredAssurance !== undefined &&
    decision.requiredAssurance !== testCase.then.requiredAssurance
  ) {
    failures.push(
      `requiredAssurance: expected ${testCase.then.requiredAssurance}, got ${String(decision.requiredAssurance)}`,
    );
  }

  return { name: testCase.name, category: testCase.category, passed: failures.length === 0, decision, failures };
}

/**
 * Runs every case in `suite.cases` against `engine` (sequentially, in
 * array order — cases are expected to be independent of one another; see
 * ./types.ts's own header on why a suite is scoped to one policy), then
 * checks the suite's own category coverage. Never throws — see
 * `assertPolicyTestSuitePassed()` below for the throwing counterpart a
 * `scripts/src/test-policy-*.ts` file actually wants.
 */
export async function runPolicyTestSuite(
  engine: TestableEngine,
  suite: PolicyTestSuite,
): Promise<PolicyTestSuiteResult> {
  const results: PolicyTestCaseResult[] = [];
  for (const testCase of suite.cases) {
    results.push(await runPolicyTestCase(engine, testCase));
  }

  const presentCategories = new Set(suite.cases.map((c) => c.category));
  const missingCategories = REQUIRED_CATEGORIES.filter((category) => !presentCategories.has(category));

  const passed = results.every((r) => r.passed) && missingCategories.length === 0;

  return { policyId: suite.policyId, results, missingCategories, passed };
}

/**
 * Throws a single, readable `Error` summarizing every failing case and
 * every missing category when `result.passed` is false; returns
 * (void) silently when it is true. This is the one function a
 * `scripts/src/test-policy-*.ts` file is expected to actually call —
 * every existing suite in this codebase already follows a "throw on
 * failure, let the process exit non-zero" convention (see e.g.
 * `scripts/src/test-policy-pep.ts`'s own `test()` helper, which re-throws
 * inside a `.catch()`); this function produces exactly the kind of error
 * that convention already expects, rather than asking every call site to
 * hand-roll its own summary of a `PolicyTestSuiteResult`.
 */
export function assertPolicyTestSuitePassed(result: PolicyTestSuiteResult): void {
  if (result.passed) return;

  const lines: string[] = [`Policy test suite "${result.policyId}" failed:`];

  for (const caseResult of result.results) {
    if (!caseResult.passed) {
      lines.push(`  ✗ [${caseResult.category}] ${caseResult.name}`);
      for (const failure of caseResult.failures) {
        lines.push(`      - ${failure}`);
      }
    }
  }

  if (result.missingCategories.length > 0) {
    lines.push(`  missing required categories: ${result.missingCategories.join(", ")}`);
  }

  throw new Error(lines.join("\n"));
}
