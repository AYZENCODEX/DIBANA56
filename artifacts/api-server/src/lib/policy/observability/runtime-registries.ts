/**
 * lib/policy/observability/runtime-registries.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 24 (Observability).
 *
 * Every other file in this directory is a pure class/function — nothing
 * instantiates `MetricsRegistry`/`AccessPatternRegistry` itself, by design
 * (a caller might reasonably want a scoped registry in a test). But
 * `../../routes/authorization-telemetry.ts` (this phase's own "integrate
 * with existing AYZEN observability" deliverable) and the FUTURE call site
 * that actually constructs a real `PolicyEngine` (a later migration wave —
 * see the roadmap's own "MIGRATION STRATEGY" section; no such call site
 * exists yet, same as every prior phase's own dormant-observer note
 * already says) both need to agree on the SAME registry instances, or the
 * route would only ever read a registry no engine ever writes to.
 *
 * This file is that one shared process-local singleton pair, plus a
 * ready-composed observer (via ./metrics-observer.ts's own
 * `composeObservers()`) a future engine constructor can plug in with zero
 * further glue:
 *
 *   import { PolicyEngine } from "./lib/policy";
 *   import { authorizationObserver } from "./lib/policy/observability/runtime-registries";
 *   const engine = new PolicyEngine({ onDecision: authorizationObserver });
 *
 * Until that call site exists, both registries simply stay at zero —
 * `authorization-telemetry.ts`'s dashboards read honest empty-state data,
 * not fabricated numbers (see ./dashboards.ts's own header on why nothing
 * in this phase invents data a real engine hasn't produced yet).
 */

import { MetricsRegistry } from "./metrics-registry";
import { AccessPatternRegistry } from "./access-pattern-registry";
import { createMetricsObserver, composeObservers } from "./metrics-observer";
import { createAccessPatternObserver } from "./access-pattern-observer";

export const metricsRegistry = new MetricsRegistry();
export const accessPatternRegistry = new AccessPatternRegistry();

/** Wire this straight into `new PolicyEngine({ onDecision: ... })` — see
 *  file header. Fans out to both registries via `composeObservers()`
 *  (./metrics-observer.ts), so a failure recording to one registry can
 *  never suppress the other's own recording of the same decision. */
export const authorizationObserver = composeObservers(
  createMetricsObserver(metricsRegistry),
  createAccessPatternObserver(accessPatternRegistry),
);
