/**
 * lib/policy/observability/dashboards.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24B (Observability —
 * Dashboards).
 *
 * Phase 24's roadmap entry names six dashboards verbatim: "authorization
 * health, denial spikes, policy errors, latency, unusual access patterns,
 * high-risk decisions". This file is the ONE place that turns the two raw
 * registry snapshots (`MetricsSnapshot` — ./metrics-registry.ts,
 * `AccessPatternSnapshot` — ./access-pattern-registry.ts) into exactly
 * those six named views, as plain, JSON-serializable objects — no chart
 * rendering, no time-series storage, no alerting thresholds baked in.
 *
 * ── Why plain JSON, not Grafana provisioning / PromQL panel definitions ──
 * `../../routes/telemetry.ts` — this codebase's OWN existing observability
 * surface (Phase 24's own "integrate with existing AYZEN observability"
 * instruction) — is a set of `GET /api/telemetry/*` JSON endpoints
 * consumed directly by a React admin page
 * (`artifacts/ayzen/src/pages/admin/developer.tsx`'s "Telemetry" tab),
 * not a Grafana instance scraping a `/metrics` endpoint. No Grafana (or
 * any other dashboarding product) is a dependency anywhere in this
 * workspace today — inventing dashboard-provisioning JSON for a product
 * this app doesn't run would be exactly the "convert mock functionality
 * into production functionality without real backend support" Rule 18
 * warns against, aimed at infrastructure instead of a feature this time.
 * `MetricsRegistry.toPrometheusText()`/`AccessPatternRegistry.toProme-
 * theusText()` remain available for a REAL future Prometheus/Grafana
 * deployment to scrape — this file is the parallel, zero-new-dependency
 * path for the dashboarding surface that already exists in this app
 * today, the same "smallest thing that actually works" choice
 * ./metrics-registry.ts's own header already made for the metrics format
 * question.
 *
 * ── Every view is a pure function of its snapshot inputs ─────────────────
 * No wall-clock reads, no randomness, no I/O — `buildAuthorizationDash-
 * boards()` and everything it calls take snapshots already produced by
 * `MetricsRegistry.snapshot()`/`AccessPatternRegistry.snapshot()` (or a
 * fixture standing in for one, in a test) and return derived data.
 * Nothing here can throw for a reason a caller needs to catch — every
 * operation is arithmetic over already-validated numbers.
 */

import type { MetricsSnapshot } from "./metrics-registry";
import type { AccessPatternSnapshot } from "./access-pattern-registry";
import type { DecisionReasonCode } from "../decision-reasons";
import { DECISION_REASON_DESCRIPTIONS } from "../decision-reasons";

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? +((numerator / denominator) * 100).toFixed(2) : 0;
}

function reasonBreakdown(
  counts: Partial<Record<DecisionReasonCode, number>>,
): Array<{ reason: DecisionReasonCode; description: string; count: number }> {
  return Object.entries(counts)
    .map(([reason, count]) => ({
      reason: reason as DecisionReasonCode,
      description: DECISION_REASON_DESCRIPTIONS[reason as DecisionReasonCode],
      count: count ?? 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/** "Authorization health" — the roadmap's own first dashboard: overall
 *  volume and the ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED/error split as
 *  percentages of total traffic, the single view an operator checks
 *  first ("is the authorization layer behaving normally right now"). */
export interface AuthorizationHealthDashboard {
  requestsTotal: number;
  allowRate: number;
  denyRate: number;
  stepUpRate: number;
  approvalRate: number;
  policyErrorRate: number;
}

export function buildAuthorizationHealthDashboard(metrics: MetricsSnapshot): AuthorizationHealthDashboard {
  return {
    requestsTotal: metrics.requestsTotal,
    allowRate: pct(metrics.allowTotal, metrics.requestsTotal),
    denyRate: pct(metrics.denyTotal, metrics.requestsTotal),
    stepUpRate: pct(metrics.stepUpTotal, metrics.requestsTotal),
    approvalRate: pct(metrics.approvalTotal, metrics.requestsTotal),
    policyErrorRate: pct(metrics.policyErrorsTotal, metrics.requestsTotal),
  };
}

/** "Denial spikes" — every denial-family reason code observed, ranked by
 *  volume, plus the fraction of ALL requests each one represents. An
 *  operator watching this over time (by polling the same endpoint, or a
 *  future consumer diffing successive snapshots) is what turns "spikes"
 *  from a static count into an actual spike signal — this dashboard
 *  supplies the ranked breakdown a spike detector or a human would need,
 *  not the detection itself (see file header on why no alerting logic
 *  lives here). */
export interface DenialSpikesDashboard {
  totalDenialFamilyDecisions: number;
  byReason: Array<{ reason: DecisionReasonCode; description: string; count: number; shareOfRequests: number }>;
}

export function buildDenialSpikesDashboard(
  metrics: MetricsSnapshot,
  accessPatterns: AccessPatternSnapshot,
): DenialSpikesDashboard {
  const breakdown = reasonBreakdown(accessPatterns.denialReasonCounts);
  return {
    totalDenialFamilyDecisions: breakdown.reduce((sum, r) => sum + r.count, 0),
    byReason: breakdown.map((r) => ({ ...r, shareOfRequests: pct(r.count, metrics.requestsTotal) })),
  };
}

/** "Policy errors" — `authorization_policy_errors` (Phase 24A) is already
 *  a single fail-closed-fault counter; this view adds only the one thing
 *  a bare total can't show — what fraction of ALL traffic is currently
 *  landing on an engine fault rather than a real policy outcome, the
 *  number an SLO/alert threshold actually watches. */
export interface PolicyErrorsDashboard {
  policyErrorsTotal: number;
  policyErrorRate: number;
}

export function buildPolicyErrorsDashboard(metrics: MetricsSnapshot): PolicyErrorsDashboard {
  return {
    policyErrorsTotal: metrics.policyErrorsTotal,
    policyErrorRate: pct(metrics.policyErrorsTotal, metrics.requestsTotal),
  };
}

/** "Latency" — the roadmap's own `authorization_latency` metric, read
 *  back out of the same cumulative histogram `MetricsRegistry` already
 *  builds (Phase 24A), plus p50/p95/p99 estimates derived from the
 *  bucket boundaries — the numbers a latency dashboard is actually for,
 *  not the raw bucket counts a human would otherwise have to eyeball. */
export interface LatencyDashboard {
  count: number;
  averageMs: number;
  /** Estimated from the cumulative bucket the percentile first falls
   *  into — bounded by bucket-width granularity, same limitation any
   *  Prometheus histogram-based percentile carries (this is exactly
   *  Prometheus's own `histogram_quantile()` approach, not a weaker
   *  approximation of it). `null` when there are no observations yet. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

function estimatePercentile(latency: MetricsSnapshot["latency"], percentile: number): number | null {
  if (latency.count === 0) return null;
  const target = latency.count * percentile;
  for (let i = 0; i < latency.bucketBoundsMs.length; i++) {
    if (latency.cumulativeCounts[i]! >= target) return latency.bucketBoundsMs[i]!;
  }
  // Every observation fell past the last named bucket boundary (5000ms) —
  // report that bound itself as the floor of the true value, same as
  // Prometheus's own histogram_quantile() does for the +Inf bucket.
  return latency.bucketBoundsMs[latency.bucketBoundsMs.length - 1]!;
}

export function buildLatencyDashboard(metrics: MetricsSnapshot): LatencyDashboard {
  const { latency } = metrics;
  return {
    count: latency.count,
    averageMs: latency.count > 0 ? +(latency.sum / latency.count).toFixed(2) : 0,
    p50Ms: estimatePercentile(latency, 0.5),
    p95Ms: estimatePercentile(latency, 0.95),
    p99Ms: estimatePercentile(latency, 0.99),
  };
}

/** "Unusual access patterns" — the curated reason subset
 *  `AccessPatternRegistry` tracks specifically for this view (see that
 *  file's own header: UNAUTHENTICATED/ATTRIBUTE_POLICY_DENIED/
 *  SEPARATION_OF_DUTIES_VIOLATION/RESOURCE_LOCKED) — signals worth an
 *  operator's attention even when they never touch the
 *  policy-errors or high-risk counters. */
export interface UnusualAccessPatternsDashboard {
  byReason: Array<{ reason: DecisionReasonCode; description: string; count: number }>;
}

export function buildUnusualAccessPatternsDashboard(
  accessPatterns: AccessPatternSnapshot,
): UnusualAccessPatternsDashboard {
  return { byReason: reasonBreakdown(accessPatterns.unusualPatternReasonCounts) };
}

/** "High-risk decisions" — `risk/risk-rule.ts`'s own outcomes
 *  specifically (see ./access-pattern-registry.ts's header for why this
 *  needs `policyId`, not just `reason`, to isolate the MEDIUM-risk
 *  STEP_UP case from every other STEP_UP source). */
export interface HighRiskDecisionsDashboard {
  highRiskDeniedTotal: number;
  mediumRiskStepUpTotal: number;
}

export function buildHighRiskDecisionsDashboard(accessPatterns: AccessPatternSnapshot): HighRiskDecisionsDashboard {
  return {
    highRiskDeniedTotal: accessPatterns.risk.highRiskDeniedTotal,
    mediumRiskStepUpTotal: accessPatterns.risk.mediumRiskStepUpTotal,
  };
}

/** All six of the roadmap's named dashboards, built from one pair of
 *  snapshots. The one function `../../routes/authorization-telemetry.ts`
 *  calls per request. */
export interface AuthorizationDashboards {
  authorizationHealth: AuthorizationHealthDashboard;
  denialSpikes: DenialSpikesDashboard;
  policyErrors: PolicyErrorsDashboard;
  latency: LatencyDashboard;
  unusualAccessPatterns: UnusualAccessPatternsDashboard;
  highRiskDecisions: HighRiskDecisionsDashboard;
}

export function buildAuthorizationDashboards(
  metrics: MetricsSnapshot,
  accessPatterns: AccessPatternSnapshot,
): AuthorizationDashboards {
  return {
    authorizationHealth: buildAuthorizationHealthDashboard(metrics),
    denialSpikes: buildDenialSpikesDashboard(metrics, accessPatterns),
    policyErrors: buildPolicyErrorsDashboard(metrics),
    latency: buildLatencyDashboard(metrics),
    unusualAccessPatterns: buildUnusualAccessPatternsDashboard(accessPatterns),
    highRiskDecisions: buildHighRiskDecisionsDashboard(accessPatterns),
  };
}
