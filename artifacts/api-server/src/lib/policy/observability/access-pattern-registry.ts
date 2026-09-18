/**
 * lib/policy/observability/access-pattern-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24B (Observability —
 * Dashboards).
 *
 * `MetricsRegistry` (./metrics-registry.ts, Phase 24A) counts decisions by
 * `effect` only — enough for the roadmap's flat
 * requests/allow/deny/step_up/approval/latency/policy_errors metric list,
 * but not enough to build three of the roadmap's own six named dashboards:
 * "denial spikes" (which DENY *reason* is spiking — RBAC gap? a locked
 * resource? risk?), "unusual access patterns" (an UNAUTHENTICATED or
 * PIP_ENRICHMENT_ERROR burst — signals that never reach DENY/policy-error
 * territory on their own), and "high-risk decisions" (the roadmap's Phase
 * 10 risk engine's own outcomes specifically, not denials in general).
 * None of those three can be told apart from a bare effect counter without
 * inspecting `reason` (see decision-reasons.ts's own header: rules keep
 * every distinguishable outcome on a dedicated reason code for exactly
 * this "tell them apart without inspecting policyId" purpose already).
 *
 * `AccessPatternRegistry` is the Phase 24B companion this reads: a
 * reason-code counter map, plus a risk-decision breakdown keyed off
 * `risk/risk-rule.ts`'s own `RISK_POLICY_ID` — the same "smallest thing
 * that works" posture ./metrics-registry.ts's own header lays out (no
 * external metrics dependency, in-process `Map`s, fire-and-forget,
 * process-local). It is deliberately a SEPARATE class rather than new
 * fields bolted onto `MetricsRegistry`: that file's own header frames its
 * seven counters/histogram as a literal, closed reading of the roadmap's
 * metric list, and its `toPrometheusText()` output is meant to be exactly
 * that list, nothing more — a per-reason label set belongs beside it, not
 * inside it, the same way this phase's own `dashboards.ts` composes BOTH
 * registries' snapshots rather than either one trying to be the other's
 * superset.
 *
 * ── Why reason codes, not a generic "top N" structure ────────────────────
 * `DecisionReasonCode` (../decision-reasons.ts) is already a closed,
 * documented union — every value this registry will ever see is known
 * ahead of time, so a plain `Record`/`Map` keyed by that union is exact,
 * not a guess at cardinality. No unbounded label growth risk (the classic
 * reason hand-rolled per-reason Prometheus counters get avoided in
 * general) because the key space is fixed by the same union
 * ./metrics-registry.ts's own `POLICY_ERROR_REASONS` set already reads
 * from.
 *
 * ── "High-risk decisions" needs policyId, not just reason ────────────────
 * `HIGH_RISK_DENIED` (decision-reasons.ts) already uniquely identifies a
 * HIGH-risk DENY — no other rule produces that code. But `risk-rule.ts`'s
 * MEDIUM-risk outcome is a plain `STEP_UP` with reason `STEP_UP_REQUIRED`,
 * the SAME reason `assurance/assurance-rule.ts`'s STEP_UP uses (see
 * `authorization-decision.ts`'s `stepUp()` — one fixed reason code
 * regardless of caller). The only field that tells a risk-driven STEP_UP
 * apart from an assurance-driven one is `policyId === RISK_POLICY_ID`
 * (`../risk/risk-rule.ts`) — so this registry reads `policyId` for that
 * one case specifically, not as a general-purpose dimension.
 *
 * ── Fire-and-forget, never throws — same discipline as Phase 24A's own
 *    registry/observer pair; see that file's own header for why. ────────
 */

import type { AuthorizationDecision } from "../types";
import type { DecisionReasonCode } from "../decision-reasons";
import { RISK_POLICY_ID } from "../risk/risk-rule";

/** Every DENY-family or engine-fault reason worth its own denial-spike
 *  line — i.e. every reason code EXCEPT the two "things went fine"
 *  outcomes (`EXPLICIT_ALLOW`) and the two forward-reserved-but-unused
 *  placeholders that are never actually the *reason* stamped on a
 *  decision on their own (`STEP_UP_REQUIRED`/`APPROVAL_REQUIRED` ARE real
 *  reasons — they're excluded from "denial" framing only, not from
 *  tracking; see `reasonCounts` below, which tracks every code). This set
 *  exists solely to let `dashboards.ts` filter a "denials only" view out
 *  of the full `reasonCounts` map without re-deriving the same list. */
const DENIAL_FAMILY_REASONS = new Set<DecisionReasonCode>([
  "NO_MATCHING_POLICY",
  "EXPLICIT_DENY",
  "INVALID_AUTHORIZATION_CONTEXT",
  "POLICY_EVALUATION_ERROR",
  "UNAUTHENTICATED",
  "PIP_ENRICHMENT_ERROR",
  "RESOURCE_LOCKED",
  "RESOURCE_GRANT_DENIED",
  "ATTRIBUTE_POLICY_DENIED",
  "HIGH_RISK_DENIED",
  "SEPARATION_OF_DUTIES_VIOLATION",
]);

/** Reason codes that signal an access pattern worth flagging even though
 *  they aren't necessarily "the system is broken" (POLICY_EVALUATION_ERROR/
 *  PIP_ENRICHMENT_ERROR already have their own dedicated
 *  `authorization_policy_errors` metric in Phase 24A) — an authenticated-
 *  session boundary being crossed unexpectedly (UNAUTHENTICATED), an
 *  attribute condition someone is repeatedly probing
 *  (ATTRIBUTE_POLICY_DENIED), or the same person landing on both sides of
 *  a workflow they shouldn't (SEPARATION_OF_DUTIES_VIOLATION). Distinct
 *  from `DENIAL_FAMILY_REASONS` above: this is a curated subset for the
 *  "unusual access patterns" dashboard specifically, not "every denial".
 */
const UNUSUAL_ACCESS_PATTERN_REASONS = new Set<DecisionReasonCode>([
  "UNAUTHENTICATED",
  "ATTRIBUTE_POLICY_DENIED",
  "SEPARATION_OF_DUTIES_VIOLATION",
  "RESOURCE_LOCKED",
]);

export interface AccessPatternSnapshot {
  /** Every observed decision's reason code, counted — the full
   *  breakdown `MetricsRegistry.snapshot()`'s bare effect counters can't
   *  provide. Only keys actually observed at least once are present
   *  (no zero-filled entries for reasons never seen this process
   *  lifetime — same "don't manufacture data" posture
   *  `recordCacheLookup()`'s own no-op stub takes in ./metrics-registry.ts). */
  reasonCounts: Partial<Record<DecisionReasonCode, number>>;
  /** `reasonCounts` filtered to `DENIAL_FAMILY_REASONS` — what
   *  `dashboards.ts`'s "denial spikes" view reads directly instead of
   *  re-filtering the full map itself. */
  denialReasonCounts: Partial<Record<DecisionReasonCode, number>>;
  /** `reasonCounts` filtered to `UNUSUAL_ACCESS_PATTERN_REASONS` — what
   *  the "unusual access patterns" dashboard reads directly. */
  unusualPatternReasonCounts: Partial<Record<DecisionReasonCode, number>>;
  risk: {
    /** HIGH-risk DENYs — `reason === "HIGH_RISK_DENIED"`, unambiguous on
     *  its own (see file header). */
    highRiskDeniedTotal: number;
    /** MEDIUM-risk STEP_UPs — `effect === "STEP_UP" && policyId ===
     *  RISK_POLICY_ID` (see file header for why `policyId`, not
     *  `reason`, is the only field that identifies this case). */
    mediumRiskStepUpTotal: number;
  };
}

export class AccessPatternRegistry {
  private readonly reasonCounts = new Map<DecisionReasonCode, number>();
  private highRiskDeniedTotal = 0;
  private mediumRiskStepUpTotal = 0;

  /** Records one finalized `AuthorizationDecision`. Never throws — same
   *  contract as `MetricsRegistry.recordDecision()`; see that file's
   *  header for why a recording failure must never surface as an
   *  authorization failure. */
  recordDecision(decision: AuthorizationDecision): void {
    try {
      this.reasonCounts.set(decision.reason, (this.reasonCounts.get(decision.reason) ?? 0) + 1);

      if (decision.reason === "HIGH_RISK_DENIED") {
        this.highRiskDeniedTotal += 1;
      } else if (decision.effect === "STEP_UP" && decision.policyId === RISK_POLICY_ID) {
        this.mediumRiskStepUpTotal += 1;
      }
    } catch {
      // A recording failure must never surface as an authorization
      // failure — see file header.
    }
  }

  snapshot(): AccessPatternSnapshot {
    const reasonCounts: Partial<Record<DecisionReasonCode, number>> = {};
    const denialReasonCounts: Partial<Record<DecisionReasonCode, number>> = {};
    const unusualPatternReasonCounts: Partial<Record<DecisionReasonCode, number>> = {};

    for (const [reason, count] of this.reasonCounts) {
      reasonCounts[reason] = count;
      if (DENIAL_FAMILY_REASONS.has(reason)) denialReasonCounts[reason] = count;
      if (UNUSUAL_ACCESS_PATTERN_REASONS.has(reason)) unusualPatternReasonCounts[reason] = count;
    }

    return {
      reasonCounts,
      denialReasonCounts,
      unusualPatternReasonCounts,
      risk: {
        highRiskDeniedTotal: this.highRiskDeniedTotal,
        mediumRiskStepUpTotal: this.mediumRiskStepUpTotal,
      },
    };
  }

  /** Prometheus text exposition, labeled by `reason` — deliberately a
   *  SEPARATE metric family from ./metrics-registry.ts's own unlabeled
   *  counters (see that file's header: its output is a literal reading
   *  of the roadmap's flat metric list, nothing more). Cardinality is
   *  bounded by `DecisionReasonCode`'s own closed union — see file
   *  header. */
  toPrometheusText(): string {
    const s = this.snapshot();
    const lines: string[] = [];

    lines.push("# HELP authorization_decisions_by_reason_total Total authorization decisions, labeled by reason code.");
    lines.push("# TYPE authorization_decisions_by_reason_total counter");
    for (const [reason, count] of Object.entries(s.reasonCounts)) {
      lines.push(`authorization_decisions_by_reason_total{reason="${reason}"} ${count}`);
    }

    lines.push("# HELP authorization_risk_decisions_total Total decisions produced by the risk-aware policy rule (risk/risk-rule.ts), labeled by risk level.");
    lines.push("# TYPE authorization_risk_decisions_total counter");
    lines.push(`authorization_risk_decisions_total{level="high"} ${s.risk.highRiskDeniedTotal}`);
    lines.push(`authorization_risk_decisions_total{level="medium"} ${s.risk.mediumRiskStepUpTotal}`);

    return lines.join("\n") + "\n";
  }

  /** Test-only reset — never called from application code. Same rationale
   *  as `MetricsRegistry.reset()` (./metrics-registry.ts). */
  reset(): void {
    this.reasonCounts.clear();
    this.highRiskDeniedTotal = 0;
    this.mediumRiskStepUpTotal = 0;
  }
}
