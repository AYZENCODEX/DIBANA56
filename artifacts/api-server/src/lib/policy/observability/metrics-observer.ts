/**
 * lib/policy/observability/metrics-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24A (Observability —
 * Metrics core).
 *
 * `createMetricsObserver()` builds a `PolicyDecisionObserver`
 * (../policy-engine.ts) — the exact same seam `../decision-observer.ts`'s
 * `createLoggingObserver()` and `../audit/audit-observer.ts`'s
 * `createAuthorizationAuditObserver()` already use — that feeds every
 * finalized decision into a `MetricsRegistry` (./metrics-registry.ts). A
 * caller wires it as:
 *
 *   import { PolicyEngine, createMetricsObserver, MetricsRegistry } from "./lib/policy";
 *   const metrics = new MetricsRegistry();
 *   const engine = new PolicyEngine({ onDecision: createMetricsObserver(metrics) });
 *
 * Nothing in the app constructs this yet — same posture every prior
 * phase's dormant observer/provider surface has taken (see
 * ../decision-observer.ts's own header, ../audit/audit-observer.ts's own
 * header): `PolicyEngine` itself is not yet constructed anywhere outside
 * this library's own doc comments and test scripts (Rule 16, plus the
 * roadmap's own migration strategy — real routes are wired to the engine,
 * and shadow mode, are later phases/work).
 *
 * ── Never throws, adds no latency ────────────────────────────────────
 * `MetricsRegistry.recordDecision()` already wraps itself in try/catch
 * (see that file's own header), so this wrapper doesn't need a second
 * one — but it's added anyway, defensively, for the same reason
 * `createLoggingObserver()`'s own header gives: this must behave
 * correctly even if ever called directly (e.g. from a test) outside
 * `PolicyEngine.notifyObserver()`'s own fire-and-forget wrapper.
 *
 * ── composeObservers() ───────────────────────────────────────────────
 * `PolicyEngineOptions.onDecision` (../policy-engine.ts) accepts exactly
 * one `PolicyDecisionObserver`. Before this phase, that was never a real
 * constraint — nothing in the app constructs a `PolicyEngine` yet, so
 * "only one observer" was a hypothetical someone would eventually run
 * into. This phase adds the second and third dormant observer factory
 * (metrics here, on top of Phase 1C's logging and Phase 17's audit) that
 * a real caller will plausibly want running TOGETHER on the same engine
 * instance (log every decision, persist it to the audit table, AND count
 * it) — at which point "only one `onDecision` slot" stops being
 * hypothetical. `composeObservers()` is the fan-out: it takes any number
 * of observers and returns one that calls each in turn, isolating a
 * throwing/rejecting observer from every other one so, e.g., a metrics
 * bug can never suppress the audit write or the log line for the same
 * decision. Awaited concurrently (`Promise.allSettled`), not
 * sequentially — matches `PolicyEngine.notifyObserver()`'s own
 * fire-and-forget, "never blocks evaluate()'s return" contract; composing
 * observers must not change that contract for any observer already
 * relying on it.
 */

import type { AuthorizationDecision, AuthorizationRequest } from "../types";
import type { PolicyDecisionObserver } from "../policy-engine";
import { MetricsRegistry } from "./metrics-registry";

export function createMetricsObserver(registry: MetricsRegistry): PolicyDecisionObserver {
  return (decision: AuthorizationDecision, _request: AuthorizationRequest | undefined): void => {
    try {
      registry.recordDecision(decision);
    } catch {
      // A metrics-recording failure must never surface as an
      // authorization failure — see file header.
    }
  };
}

/** Fans a single `onDecision` call out to every observer given, running
 *  them concurrently and isolating each one's failure from the others —
 *  see file header. Returns a `PolicyDecisionObserver` itself, so it can
 *  be passed straight to `new PolicyEngine({ onDecision: composeObservers(...) })`
 *  wherever a caller would otherwise have had to pick just one. */
export function composeObservers(...observers: PolicyDecisionObserver[]): PolicyDecisionObserver {
  return (decision: AuthorizationDecision, request: AuthorizationRequest | undefined): void => {
    for (const observer of observers) {
      try {
        // An observer may return void or a Promise<void> (see
        // PolicyDecisionObserver's own type) — either is fine to ignore
        // here for the same fire-and-forget reason PolicyEngine's own
        // notifyObserver() ignores it. Catch synchronous throws directly;
        // catch a returned rejected promise separately so one observer's
        // async failure can't surface as an unhandled rejection and can
        // never block or fail any sibling observer's own turn.
        const result = observer(decision, request);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {
            // Swallowed — see this function's own header: one observer's
            // failure must never affect any other observer.
          });
        }
      } catch {
        // Swallowed — see this function's own header.
      }
    }
  };
}
