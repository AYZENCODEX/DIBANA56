/**
 * lib/policy/decision-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core),
 * sub-phase 1C. Phase 16 (Policy Versioning) added `policyVersion` to
 * `toLogFields()`'s output — see that function's own comment.
 *
 * `PolicyEngine`'s `onDecision` hook (policy-engine.ts) is deliberately a
 * bare callback with no opinion on *how* a decision gets logged — this file
 * is one convenience implementation of that callback, for the common case
 * of "log every decision through the app's existing structured logger".
 *
 * This does NOT import `lib/logger.ts` (the app's real pino instance).
 * `lib/policy/*` has stayed decoupled from concrete app singletons since
 * Phase 1A (pure types, no DB, no Express in the core) — this file keeps
 * that discipline by accepting anything structurally shaped like a logger
 * (`DecisionLoggerLike`), which the app's pino `logger` already satisfies
 * with zero glue code. A caller wires it as:
 *
 *   import { logger } from "../logger";
 *   import { PolicyEngine, createLoggingObserver } from "./lib/policy";
 *   const engine = new PolicyEngine({ onDecision: createLoggingObserver(logger) });
 *
 * Nothing in the app does this yet (see
 * CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE1C.md) — this is dormant,
 * opt-in surface area, not automatic logging of anything.
 *
 * This is intentionally NOT Phase 17 (Authorization Audit). There is no
 * database write here, no `decisionId`, no persistence, no retention
 * policy — just a structured log line. Phase 17 can build real, queryable
 * audit storage on top of this same `onDecision` seam later without
 * touching the engine again.
 */

import type { AuthorizationDecision, AuthorizationRequest } from "./types";
import type { PolicyDecisionObserver } from "./policy-engine";

/** Minimal structural subset of pino's logger interface (and most other
 *  structured loggers) that this file actually needs. The app's real
 *  `lib/logger.ts` pino instance satisfies this without modification. */
export interface DecisionLoggerLike {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/** Fields pulled out of a decision (+ its request, when available) for a
 *  log line. Deliberately excludes anything that could be sensitive: no
 *  raw resource payloads, no subject scopes/roles beyond what's already on
 *  the decision, no IP/session id (those live on PolicyContext, which this
 *  does not walk into — a future Phase 17 audit table can decide deliberately
 *  which of those belong in durable storage; this helper is not that
 *  decision). */
function toLogFields(decision: AuthorizationDecision, request: AuthorizationRequest | undefined): Record<string, unknown> {
  return {
    requestId: decision.requestId,
    effect: decision.effect,
    reason: decision.reason,
    policyId: decision.policyId,
    // Phase 16 (Policy Versioning): included alongside policyId, from the
    // same decision field — see types.ts's own doc comment on
    // `AuthorizationDecision.policyVersion`. `undefined` for any decision
    // not produced by a registry-backed rule, same as `policyId` itself
    // was already `undefined` for every non-registry rule before this.
    policyVersion: decision.policyVersion,
    action: request?.action,
    resourceType: request?.resource?.type,
    subjectPresent: request ? request.subject !== null : undefined,
  };
}

/**
 * Builds a `PolicyDecisionObserver` (see policy-engine.ts) that logs every
 * decision through the given logger. DENY-family effects (`DENY`,
 * `STEP_UP`, `APPROVAL_REQUIRED`) log at `warn` — not because they are
 * errors (default-deny denying an unpermitted request is the system
 * working correctly), but so denial volume/spikes are easy to filter for in
 * existing log tooling. `ALLOW` logs at `info`.
 *
 * Never throws — `PolicyEngine` already treats observer failures as
 * fire-and-forget (see notifyObserver() in policy-engine.ts), but this is
 * also defensive on its own so it behaves correctly if ever called
 * directly (e.g. from a test) outside that wrapper.
 */
export function createLoggingObserver(logger: DecisionLoggerLike): PolicyDecisionObserver {
  return (decision, request) => {
    try {
      const fields = toLogFields(decision, request);
      if (decision.effect === "ALLOW") {
        logger.info(fields, "authorization decision");
      } else {
        logger.warn(fields, "authorization decision");
      }
    } catch {
      // A logging failure must never surface as an authorization failure.
    }
  };
}
