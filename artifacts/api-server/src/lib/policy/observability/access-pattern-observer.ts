/**
 * lib/policy/observability/access-pattern-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24B (Observability —
 * Dashboards).
 *
 * `createAccessPatternObserver()` is the `AccessPatternRegistry` (./access-
 * pattern-registry.ts) counterpart to Phase 24A's own
 * `createMetricsObserver()` (./metrics-observer.ts) — same
 * `PolicyDecisionObserver` seam (../policy-engine.ts), same
 * never-throws contract, same dormant "nothing constructs a `PolicyEngine`
 * yet" posture every observer factory in this directory (and
 * ../decision-observer.ts, ../audit/audit-observer.ts before it) has held
 * since Phase 1C.
 */

import type { AuthorizationDecision, AuthorizationRequest } from "../types";
import type { PolicyDecisionObserver } from "../policy-engine";
import { AccessPatternRegistry } from "./access-pattern-registry";

export function createAccessPatternObserver(registry: AccessPatternRegistry): PolicyDecisionObserver {
  return (decision: AuthorizationDecision, _request: AuthorizationRequest | undefined): void => {
    try {
      registry.recordDecision(decision);
    } catch {
      // A recording failure must never surface as an authorization
      // failure — see ./access-pattern-registry.ts's own header.
    }
  };
}
