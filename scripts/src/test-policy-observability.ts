/**
 * scripts/src/test-policy-observability.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24 (Observability) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-observability.ts
 *
 * Three parts:
 *   1. MetricsRegistry (24A) — effect counters, the policy-error reason
 *      pair, the latency histogram's cumulative bucket semantics, and
 *      that recordDecision() never throws on a malformed decision.
 *   2. AccessPatternRegistry (24B) — reason-code breakdown, the
 *      denial-family/unusual-pattern filtered views, and the
 *      HIGH_RISK_DENIED vs. RISK_POLICY_ID-tagged-STEP_UP split.
 *   3. dashboards.ts (24B) — buildAuthorizationDashboards() end-to-end
 *      against a small synthetic decision stream, including the p50/p95
 *      latency-percentile estimate and an empty-registry baseline.
 *
 * Run: npx tsx scripts/src/test-policy-observability.ts
 */

import assert from "node:assert/strict";
import {
  MetricsRegistry,
  createMetricsObserver,
  composeObservers,
  AccessPatternRegistry,
  createAccessPatternObserver,
  buildAuthorizationDashboards,
  RISK_POLICY_ID,
  type AuthorizationDecision,
} from "../../artifacts/api-server/src/lib/policy";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

let seq = 0;
function decision(overrides: Partial<AuthorizationDecision>): AuthorizationDecision {
  seq += 1;
  return {
    effect: "ALLOW",
    reason: "EXPLICIT_ALLOW",
    requestId: `req-${seq}`,
    evaluatedAt: new Date(),
    ...overrides,
  };
}

async function main() {
  console.log("Phase 24 (Observability) tests\n");

  // ── Part 1: MetricsRegistry ──────────────────────────────────────────
  await test("recordDecision: tallies effect counters correctly", () => {
    const registry = new MetricsRegistry();
    registry.recordDecision(decision({ effect: "ALLOW", reason: "EXPLICIT_ALLOW" }));
    registry.recordDecision(decision({ effect: "DENY", reason: "EXPLICIT_DENY" }));
    registry.recordDecision(decision({ effect: "STEP_UP", reason: "STEP_UP_REQUIRED" }));
    registry.recordDecision(decision({ effect: "APPROVAL_REQUIRED", reason: "APPROVAL_REQUIRED" }));

    const snap = registry.snapshot();
    assert.equal(snap.requestsTotal, 4);
    assert.equal(snap.allowTotal, 1);
    assert.equal(snap.denyTotal, 1);
    assert.equal(snap.stepUpTotal, 1);
    assert.equal(snap.approvalTotal, 1);
  });

  await test("recordDecision: only POLICY_EVALUATION_ERROR/PIP_ENRICHMENT_ERROR count as policy errors, not ordinary EXPLICIT_DENY", () => {
    const registry = new MetricsRegistry();
    registry.recordDecision(decision({ effect: "DENY", reason: "EXPLICIT_DENY" }));
    registry.recordDecision(decision({ effect: "DENY", reason: "POLICY_EVALUATION_ERROR" }));
    registry.recordDecision(decision({ effect: "DENY", reason: "PIP_ENRICHMENT_ERROR" }));

    const snap = registry.snapshot();
    assert.equal(snap.denyTotal, 3);
    assert.equal(snap.policyErrorsTotal, 2);
  });

  await test("recordDecision: latency histogram buckets are cumulative (Prometheus 'le' semantics)", () => {
    const registry = new MetricsRegistry();
    for (const ms of [3, 30, 300, 3000]) {
      registry.recordDecision(decision({ latencyMs: ms }));
    }
    const snap = registry.snapshot();
    assert.equal(snap.latency.count, 4);
    assert.equal(snap.latency.sum, 3 + 30 + 300 + 3000);
    // bucketBoundsMs = [1,5,10,25,50,100,250,500,1000,2500,5000]
    // le=5 → only the 3ms observation
    assert.equal(snap.latency.cumulativeCounts[1], 1);
    // le=50 → 3ms and 30ms
    assert.equal(snap.latency.cumulativeCounts[4], 2);
    // le=500 → 3,30,300
    assert.equal(snap.latency.cumulativeCounts[7], 3);
    // +Inf → all four
    assert.equal(snap.latency.cumulativeCounts[snap.latency.cumulativeCounts.length - 1], 4);
  });

  await test("recordDecision: never throws, even on a decision missing required fields", () => {
    const registry = new MetricsRegistry();
    assert.doesNotThrow(() => registry.recordDecision({} as AuthorizationDecision));
  });

  await test("toPrometheusText(): emits the roadmap's metric names, omits authorization_cache_hit_rate", () => {
    const registry = new MetricsRegistry();
    registry.recordDecision(decision({}));
    const text = registry.toPrometheusText();
    for (const name of [
      "authorization_requests_total",
      "authorization_allow_total",
      "authorization_deny_total",
      "authorization_step_up_total",
      "authorization_approval_total",
      "authorization_policy_errors",
      "authorization_latency_ms",
    ]) {
      assert.ok(text.includes(name), `expected ${name} in Prometheus text`);
    }
    assert.ok(!text.includes("authorization_cache_hit_rate"));
  });

  await test("createMetricsObserver()/composeObservers(): a throwing observer never blocks a sibling observer", () => {
    const registry = new MetricsRegistry();
    const throwing = () => {
      throw new Error("boom");
    };
    const composed = composeObservers(throwing, createMetricsObserver(registry));
    assert.doesNotThrow(() => composed(decision({}), undefined));
    assert.equal(registry.snapshot().requestsTotal, 1);
  });

  // ── Part 2: AccessPatternRegistry ────────────────────────────────────
  await test("recordDecision: reason-code breakdown, filtered denial/unusual-pattern views", () => {
    const registry = new AccessPatternRegistry();
    registry.recordDecision(decision({ effect: "ALLOW", reason: "EXPLICIT_ALLOW" }));
    registry.recordDecision(decision({ effect: "DENY", reason: "UNAUTHENTICATED" }));
    registry.recordDecision(decision({ effect: "DENY", reason: "UNAUTHENTICATED" }));
    registry.recordDecision(decision({ effect: "DENY", reason: "RESOURCE_LOCKED" }));

    const snap = registry.snapshot();
    assert.equal(snap.reasonCounts.EXPLICIT_ALLOW, 1);
    assert.equal(snap.reasonCounts.UNAUTHENTICATED, 2);
    assert.equal(snap.denialReasonCounts.UNAUTHENTICATED, 2);
    assert.equal(snap.denialReasonCounts.RESOURCE_LOCKED, 1);
    assert.equal(snap.unusualPatternReasonCounts.UNAUTHENTICATED, 2);
    // ALLOW is never a denial or an unusual-access-pattern reason.
    assert.equal(snap.denialReasonCounts.EXPLICIT_ALLOW, undefined);
    assert.equal(snap.unusualPatternReasonCounts.EXPLICIT_ALLOW, undefined);
  });

  await test("recordDecision: HIGH_RISK_DENIED and RISK_POLICY_ID-tagged STEP_UP are counted, an unrelated STEP_UP is not", () => {
    const registry = new AccessPatternRegistry();
    registry.recordDecision(decision({ effect: "DENY", reason: "HIGH_RISK_DENIED", policyId: RISK_POLICY_ID }));
    registry.recordDecision(decision({ effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: RISK_POLICY_ID }));
    // An assurance-driven STEP_UP: same reason code, different policyId.
    registry.recordDecision(decision({ effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: "assurance" }));

    const snap = registry.snapshot();
    assert.equal(snap.risk.highRiskDeniedTotal, 1);
    assert.equal(snap.risk.mediumRiskStepUpTotal, 1);
  });

  await test("createAccessPatternObserver(): never throws", () => {
    const registry = new AccessPatternRegistry();
    const observer = createAccessPatternObserver(registry);
    assert.doesNotThrow(() => observer(decision({}), undefined));
    assert.equal(registry.snapshot().reasonCounts.EXPLICIT_ALLOW, 1);
  });

  // ── Part 3: dashboards.ts ────────────────────────────────────────────
  await test("buildAuthorizationDashboards(): empty registries produce a zeroed, non-throwing baseline", () => {
    const metrics = new MetricsRegistry();
    const accessPatterns = new AccessPatternRegistry();
    const dashboards = buildAuthorizationDashboards(metrics.snapshot(), accessPatterns.snapshot());
    assert.equal(dashboards.authorizationHealth.requestsTotal, 0);
    assert.equal(dashboards.authorizationHealth.allowRate, 0);
    assert.equal(dashboards.latency.p50Ms, null);
    assert.deepEqual(dashboards.denialSpikes.byReason, []);
    assert.deepEqual(dashboards.highRiskDecisions, { highRiskDeniedTotal: 0, mediumRiskStepUpTotal: 0 });
  });

  await test("buildAuthorizationDashboards(): end-to-end against a synthetic decision stream", () => {
    const metrics = new MetricsRegistry();
    const accessPatterns = new AccessPatternRegistry();
    const observer = composeObservers(createMetricsObserver(metrics), createAccessPatternObserver(accessPatterns));

    // 10 requests: 6 allow, 2 unauthenticated denies, 1 high-risk deny, 1 medium-risk step-up.
    for (let i = 0; i < 6; i++) observer(decision({ effect: "ALLOW", reason: "EXPLICIT_ALLOW", latencyMs: 10 }), undefined);
    for (let i = 0; i < 2; i++) observer(decision({ effect: "DENY", reason: "UNAUTHENTICATED", latencyMs: 5 }), undefined);
    observer(decision({ effect: "DENY", reason: "HIGH_RISK_DENIED", policyId: RISK_POLICY_ID, latencyMs: 8 }), undefined);
    observer(decision({ effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: RISK_POLICY_ID, latencyMs: 6 }), undefined);

    const dashboards = buildAuthorizationDashboards(metrics.snapshot(), accessPatterns.snapshot());
    assert.equal(dashboards.authorizationHealth.requestsTotal, 10);
    assert.equal(dashboards.authorizationHealth.allowRate, 60);
    assert.equal(dashboards.authorizationHealth.denyRate, 30);
    assert.equal(dashboards.authorizationHealth.stepUpRate, 10);

    assert.equal(dashboards.denialSpikes.totalDenialFamilyDecisions, 3);
    const unauthEntry = dashboards.denialSpikes.byReason.find((r) => r.reason === "UNAUTHENTICATED");
    assert.equal(unauthEntry?.count, 2);
    assert.equal(unauthEntry?.shareOfRequests, 20);

    assert.equal(dashboards.unusualAccessPatterns.byReason.find((r) => r.reason === "UNAUTHENTICATED")?.count, 2);

    assert.equal(dashboards.highRiskDecisions.highRiskDeniedTotal, 1);
    assert.equal(dashboards.highRiskDecisions.mediumRiskStepUpTotal, 1);

    assert.equal(dashboards.latency.count, 10);
    assert.ok(dashboards.latency.p50Ms !== null);
  });

  console.log("\nAll Phase 24 observability tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
