/**
 * lib/policy/observability/metrics-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24A (Observability —
 * Metrics core).
 *
 * `MetricsRegistry` is a minimal, dependency-free, in-process counter +
 * histogram store for the authorization metrics the roadmap's Phase 24
 * names. No `prom-client`/OpenTelemetry/statsd dependency is added — none
 * is already a dependency anywhere in this workspace (checked: no
 * `package.json` in this repo lists one), and Rule 17 ("avoid unnecessary
 * microservices") plus this phase's own "integrate with existing AYZEN
 * observability" instruction argue for the smallest thing that actually
 * works: an in-memory registry any caller can read a JSON snapshot from,
 * or export in the same text format Prometheus itself expects (so a real
 * Prometheus server can scrape it later with zero further app changes,
 * without this app depending on Prometheus's client library today).
 *
 * ── Metrics implemented (from the roadmap's own Phase 24 list) ─────────
 *   - authorization_requests_total   — every decision observed, any effect
 *   - authorization_allow_total      — effect === "ALLOW"
 *   - authorization_deny_total       — effect === "DENY"
 *   - authorization_step_up_total    — effect === "STEP_UP"
 *   - authorization_approval_total   — effect === "APPROVAL_REQUIRED"
 *   - authorization_policy_errors    — reason is "POLICY_EVALUATION_ERROR"
 *     or "PIP_ENRICHMENT_ERROR" (../decision-reasons.ts's own two
 *     error-shaped codes — see that file's header for why those two, and
 *     only those two, mean "the engine itself failed" rather than "the
 *     engine correctly reached a DENY")
 *   - authorization_latency          — histogram, milliseconds, fed
 *     directly from `AuthorizationDecision.latencyMs`, which
 *     `PolicyEngine.evaluate()`/`evaluateWithTrace()` already stamps on
 *     every decision (see policy-engine.ts's own `stampLatency()`) — this
 *     phase adds no new timing instrumentation, it only aggregates a
 *     number the engine was already computing.
 *
 * ── authorization_cache_hit_rate is DELIBERATELY NOT implemented here ───
 * The roadmap's Phase 24 list names this metric, but no caching layer
 * exists anywhere in `lib/policy/*` yet — checked directly: every
 * provider/registry file that even mentions "cache" in this codebase
 * (`pep/authorize-many.ts`, `rbac-admin/rbac-admin-registry.ts`,
 * `registry/registry-rule-loader.ts`, `rbac/drizzle-rbac-provider.ts`)
 * does so only in a comment explaining that introducing one is future
 * work, per the roadmap's own Performance Rules ("Introduce caching only
 * after correctness") and Rule 16 ("do not implement future phases
 * prematurely"). A hit-rate counter with no real cache behind it would
 * either always read 0% (misleading — reads as "cache is failing") or
 * have to be wired to something fake (Rule 18: "do not convert mock
 * functionality into production functionality without real backend
 * support" — a metric is exactly the kind of thing an operator trusts
 * at face value). `recordCacheLookup()` is written as a documented no-op
 * stub below specifically so the seam is visible and trivial to fill in
 * — not silently missing — the moment a real provider-level cache exists.
 *
 * ── Fire-and-forget, never throws ────────────────────────────────────
 * Every public method here is a synchronous, allocation-light counter
 * bump wrapped in try/catch — same defensive posture
 * `../decision-observer.ts`'s `createLoggingObserver()` and
 * `../audit/audit-observer.ts`'s `createAuthorizationAuditObserver()`
 * both take for their own observer bodies: a metrics-recording failure
 * must never become a new way for authorization to fail, and must never
 * add meaningful latency to the decision path it is measuring.
 *
 * ── Process-local, not cross-instance ────────────────────────────────
 * This registry holds state in plain JS `Map`s/arrays, scoped to one
 * Node process. Exactly right for what this phase actually verifies
 * (that the AYZEN policy engine is instrumented at all); a future
 * multi-instance deployment that wants a single aggregated view needs a
 * real backend (Prometheus federation/remote-write, a shared store) —
 * that is Phase 24's own "Dashboards"/"Integrate with existing AYZEN
 * observability" half, not this file's job.
 */

import type { AuthorizationDecision } from "../types";

/** Upper bounds (milliseconds) of each latency bucket, ascending,
 *  Prometheus-histogram-style ("le" = less-than-or-equal). The last
 *  bucket is always `+Inf` (every observation falls into it) and is not
 *  listed explicitly here — `toPrometheusText()`/`snapshot()` add it. Same
 *  bucket boundaries Prometheus's own client libraries default to for
 *  short in-process operations, since an authorization decision is
 *  expected to be sub-second (DB-backed PIP/RBAC/registry lookups
 *  included) — a decision regularly landing past the last named bucket
 *  (5000ms) is itself an observability signal worth seeing on a
 *  dashboard, not a reason to add more buckets. */
const LATENCY_BUCKET_BOUNDS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

const POLICY_ERROR_REASONS = new Set(["POLICY_EVALUATION_ERROR", "PIP_ENRICHMENT_ERROR"]);

interface Histogram {
  /** Parallel to `LATENCY_BUCKET_BOUNDS_MS` plus one implicit `+Inf`
   *  bucket at the end — `counts[i]` is the number of observations
   *  `<= LATENCY_BUCKET_BOUNDS_MS[i]` (cumulative, matching Prometheus's
   *  own histogram semantics), and `counts[counts.length - 1]` is the
   *  `+Inf` bucket (== total observation count). */
  counts: number[];
  sum: number;
  count: number;
}

function newHistogram(): Histogram {
  return { counts: new Array(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0), sum: 0, count: 0 };
}

function observe(histogram: Histogram, value: number): void {
  histogram.sum += value;
  histogram.count += 1;
  // Cumulative buckets (Prometheus histogram semantics): every bucket
  // whose bound is >= the observed value increments, not just the first
  // match — so counts[i] always means "observations <= bound[i]".
  for (let i = 0; i < LATENCY_BUCKET_BOUNDS_MS.length; i++) {
    if (value <= LATENCY_BUCKET_BOUNDS_MS[i]!) {
      histogram.counts[i]! += 1;
    }
  }
  // The +Inf bucket counts every observation, cumulative over all of them.
  histogram.counts[histogram.counts.length - 1]! += 1;
}

export interface MetricsSnapshot {
  requestsTotal: number;
  allowTotal: number;
  denyTotal: number;
  stepUpTotal: number;
  approvalTotal: number;
  policyErrorsTotal: number;
  latency: {
    bucketBoundsMs: readonly number[];
    /** Cumulative counts, one per bound in `bucketBoundsMs`, plus a final
     *  `+Inf` entry equal to `count`. */
    cumulativeCounts: number[];
    sum: number;
    count: number;
  };
}

export class MetricsRegistry {
  private requestsTotal = 0;
  private allowTotal = 0;
  private denyTotal = 0;
  private stepUpTotal = 0;
  private approvalTotal = 0;
  private policyErrorsTotal = 0;
  private readonly latencyHistogram: Histogram = newHistogram();

  /** Records one finalized `AuthorizationDecision` — the one method a
   *  `PolicyDecisionObserver` (see `createMetricsObserver()` below) calls
   *  per decision. Never throws. */
  recordDecision(decision: AuthorizationDecision): void {
    try {
      this.requestsTotal += 1;
      switch (decision.effect) {
        case "ALLOW":
          this.allowTotal += 1;
          break;
        case "DENY":
          this.denyTotal += 1;
          break;
        case "STEP_UP":
          this.stepUpTotal += 1;
          break;
        case "APPROVAL_REQUIRED":
          this.approvalTotal += 1;
          break;
      }
      if (POLICY_ERROR_REASONS.has(decision.reason)) {
        this.policyErrorsTotal += 1;
      }
      if (typeof decision.latencyMs === "number" && Number.isFinite(decision.latencyMs) && decision.latencyMs >= 0) {
        observe(this.latencyHistogram, decision.latencyMs);
      }
    } catch {
      // A metrics-recording failure must never surface as an
      // authorization failure — see file header.
    }
  }

  /** Documented no-op — see file header's "authorization_cache_hit_rate
   *  is deliberately not implemented" section. Exists so the seam is
   *  visible in this registry's own public API (an IDE-discoverable
   *  "here is where that goes") rather than requiring a future
   *  implementer to invent a new file/method name from scratch, without
   *  this phase pretending a cache already exists. */
  recordCacheLookup(_hit: boolean): void {
    // Intentionally not implemented — no cache layer exists yet in
    // lib/policy/* for this to measure. See this file's own header.
  }

  snapshot(): MetricsSnapshot {
    return {
      requestsTotal: this.requestsTotal,
      allowTotal: this.allowTotal,
      denyTotal: this.denyTotal,
      stepUpTotal: this.stepUpTotal,
      approvalTotal: this.approvalTotal,
      policyErrorsTotal: this.policyErrorsTotal,
      latency: {
        bucketBoundsMs: LATENCY_BUCKET_BOUNDS_MS,
        cumulativeCounts: [...this.latencyHistogram.counts],
        sum: this.latencyHistogram.sum,
        count: this.latencyHistogram.count,
      },
    };
  }

  /** Prometheus text exposition format (the same plain-text format
   *  `/metrics` endpoints serve — see
   *  https://prometheus.io/docs/instrumenting/exposition_formats/) — so a
   *  real Prometheus server can scrape this registry the moment an
   *  operator points one at it, without this app taking a `prom-client`
   *  dependency to produce that format. Hand-rolled deliberately: the
   *  format is a handful of `# TYPE`/`# HELP` lines plus `name value`
   *  pairs, not worth a dependency for. */
  toPrometheusText(): string {
    const s = this.snapshot();
    const lines: string[] = [];

    lines.push("# HELP authorization_requests_total Total authorization decisions evaluated.");
    lines.push("# TYPE authorization_requests_total counter");
    lines.push(`authorization_requests_total ${s.requestsTotal}`);

    lines.push("# HELP authorization_allow_total Total ALLOW decisions.");
    lines.push("# TYPE authorization_allow_total counter");
    lines.push(`authorization_allow_total ${s.allowTotal}`);

    lines.push("# HELP authorization_deny_total Total DENY decisions.");
    lines.push("# TYPE authorization_deny_total counter");
    lines.push(`authorization_deny_total ${s.denyTotal}`);

    lines.push("# HELP authorization_step_up_total Total STEP_UP decisions.");
    lines.push("# TYPE authorization_step_up_total counter");
    lines.push(`authorization_step_up_total ${s.stepUpTotal}`);

    lines.push("# HELP authorization_approval_total Total APPROVAL_REQUIRED decisions.");
    lines.push("# TYPE authorization_approval_total counter");
    lines.push(`authorization_approval_total ${s.approvalTotal}`);

    lines.push("# HELP authorization_policy_errors Total decisions reached via POLICY_EVALUATION_ERROR or PIP_ENRICHMENT_ERROR (fail-closed engine faults, not ordinary denies).");
    lines.push("# TYPE authorization_policy_errors counter");
    lines.push(`authorization_policy_errors ${s.policyErrorsTotal}`);

    lines.push("# HELP authorization_latency_ms Authorization decision latency in milliseconds, end-to-end as measured by PolicyEngine itself.");
    lines.push("# TYPE authorization_latency_ms histogram");
    for (let i = 0; i < s.latency.bucketBoundsMs.length; i++) {
      lines.push(`authorization_latency_ms_bucket{le="${s.latency.bucketBoundsMs[i]}"} ${s.latency.cumulativeCounts[i]}`);
    }
    lines.push(`authorization_latency_ms_bucket{le="+Inf"} ${s.latency.cumulativeCounts[s.latency.cumulativeCounts.length - 1]}`);
    lines.push(`authorization_latency_ms_sum ${s.latency.sum}`);
    lines.push(`authorization_latency_ms_count ${s.latency.count}`);

    // authorization_cache_hit_rate intentionally omitted — see file header.

    return lines.join("\n") + "\n";
  }

  /** Test-only reset — never called from application code. Same
   *  "singletons need a way to be reset between test cases" need every
   *  in-memory fixture in this codebase's test scripts already has, just
   *  scoped to this registry instead of a Fake*Provider. */
  reset(): void {
    this.requestsTotal = 0;
    this.allowTotal = 0;
    this.denyTotal = 0;
    this.stepUpTotal = 0;
    this.approvalTotal = 0;
    this.policyErrorsTotal = 0;
    const fresh = newHistogram();
    this.latencyHistogram.counts = fresh.counts;
    this.latencyHistogram.sum = fresh.sum;
    this.latencyHistogram.count = fresh.count;
  }
}
