/**
 * lib/policy/explain/explain-authorization.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 15 (Explainability).
 *
 * `explainAuthorizationDecision()` is this phase's whole surface: given a
 * decision an engine already produced (never a second, parallel evaluation
 * — see "Explaining is not re-evaluating" below), render the roadmap's own
 * two-audience output — a fixed, safe user-facing message, and (gated)
 * rich admin/debug detail.
 *
 * ── Explaining is not re-evaluating ──────────────────────────────────────
 * This function takes an already-produced `AuthorizationDecision` (plus,
 * optionally, the `AuthorizationRequest` that produced it and a rule
 * trace) as INPUT — it never calls `PolicyEngine.evaluate()` /
 * `PrecedenceEngine.evaluate()` itself, and never re-derives ALLOW/DENY/
 * STEP_UP/APPROVAL_REQUIRED from scratch. Same "reuse the real evaluation,
 * never a parallel copy" posture ../simulation/policy-simulator.ts's own
 * header establishes for `simulatePolicy()`/`simulatePrecedence()`: an
 * explanation that could disagree with the decision it explains (e.g. a
 * hand-maintained second copy of "what does EXPLICIT_DENY mean") would be
 * worse than useless. A caller wanting a rendered explanation from raw
 * subject/action/resource/context input should call `evaluate()` (or
 * `evaluateWithTrace()`, if it also wants a trace to hand to this
 * function) and pass the RESULT here — never the other way around.
 *
 * ── Why ALLOW gets no `userMessage` ───────────────────────────────────────
 * The roadmap's own Phase 15 wording ("You don't have permission to
 * perform this action") is a DENIAL message — there is nothing to explain
 * to the ordinary caller of an action that simply succeeded. Populating
 * `userMessage` for ALLOW too (e.g. "you have permission") would add a
 * string no real caller asked for and no roadmap wording names; leaving it
 * `undefined` for ALLOW keeps this function's one fixed string doing
 * exactly the one job the roadmap describes.
 *
 * ── `includeDetail` is the caller's decision, not this module's ──────────
 * This function has no notion of "who is asking" — it does not read a
 * `Subject`, does not call an `RbacProvider`, and cannot itself decide
 * whether the current caller is an authorized admin. That decision is
 * ./viewer-authorization.ts's `canViewExplanationDetail()`, which the
 * PEP/route layer is expected to call FIRST (server-side, against the
 * viewer's own DB-verified `Subject` — never trusting a client-supplied
 * "am I an admin" flag, per Rule 9) and pass the result in as
 * `includeDetail`. Keeping this split means the "is this policy internals
 * exposure safe" question lives in exactly one place
 * (viewer-authorization.ts), reusable by any future caller, rather than
 * being re-decided ad hoc at every call site that wants an explanation.
 *
 * ── Never a second source of truth for reason-code prose ─────────────────
 * `reasonDescription` is looked up from ../decision-reasons.ts's own
 * `DECISION_REASON_DESCRIPTIONS` — the exact same table every other
 * consumer of a `DecisionReasonCode` would read — never independently
 * authored here. Adding a new `DecisionReasonCode` in a future phase
 * therefore never requires touching this file too.
 */

import type { AuthorizationDecision, AuthorizationRequest } from "../types";
import { DECISION_REASON_DESCRIPTIONS } from "../decision-reasons";
import { computeAssuranceLevel } from "../assurance/assurance-level";
import type { MatchedRuleTrace } from "../simulation/types";
import { GENERIC_DENIAL_MESSAGE, type AuthorizationExplanation, type PolicyExplanationDetail } from "./types";

export interface ExplainAuthorizationOptions {
  /** The decision to explain — from a real `evaluate()`/
   *  `evaluateWithTrace()` call (or a Phase 14 simulation). Required. */
  decision: AuthorizationDecision;
  /** The `AuthorizationRequest` that produced `decision`, when the caller
   *  has it (e.g. from `evaluateWithTrace()`'s own return shape, or a
   *  Phase 14 `simulatePolicy()`/`simulatePrecedence()` caller that also
   *  holds the `SimulationInput` it built). Optional — when omitted,
   *  `detail.assuranceLevel`/`risk`/`resource` are all left `undefined`
   *  (there is nothing to read them from); every other `detail` field is
   *  unaffected, since those come from `decision` alone. */
  request?: AuthorizationRequest;
  /** Every rule this decision's evaluation actually consulted, in order,
   *  INCLUDING abstentions — from `PolicyEngine.evaluateWithTrace()`,
   *  `PrecedenceEngine.evaluateWithTrace()` (reshaped, since that one adds
   *  a `tier` field `MatchedRuleTrace` also accepts), or a Phase 14
   *  `PolicySimulationResult.matchedRules`. Optional — omit for a
   *  decision where no trace was captured (`detail.matchedRules` is then
   *  `undefined`, not `[]` — see ./types.ts's own doc comment on that
   *  field for why the distinction matters). */
  trace?: MatchedRuleTrace[];
  /** Best-effort Phase 07 registry version for `decision.policyId`, when
   *  the caller already resolved one (e.g. via
   *  ../simulation/policy-simulator.ts's own `resolvePolicyVersion()`, or
   *  a direct `PolicyRegistryProvider.getActivePolicy()` call). This
   *  module deliberately does not perform that DB-touching lookup itself
   *  — ../simulation/policy-simulator.ts already owns exactly that
   *  best-effort, never-throwing enrichment step; duplicating it here
   *  would be a second, parallel implementation of the same read-only
   *  lookup for no benefit. Omit for `detail.policyVersion: undefined`. */
  policyVersion?: number;
  /** Whether the CALLER (not this function) has already determined the
   *  current viewer is authorized to see `detail` — see this file's own
   *  header and ./viewer-authorization.ts's `canViewExplanationDetail()`.
   *  `false`/omitted yields an explanation with `detail: undefined`,
   *  regardless of how sensitive or benign the actual decision was —
   *  fail-closed on exposure, the same posture every other "never trust
   *  client-supplied context" boundary in this engine already takes. */
  includeDetail?: boolean;
}

/**
 * Renders `options.decision` into the roadmap's own two-audience
 * `AuthorizationExplanation` shape. Never throws (every field here is
 * either a direct copy or a lookup against a fixed, always-defined table
 * — there is no I/O, no DB, no external call for this function to fail
 * on). Deterministic (Rule 12): a pure function of its own arguments.
 */
export function explainAuthorizationDecision(
  options: ExplainAuthorizationOptions,
): AuthorizationExplanation {
  const { decision, request, trace, policyVersion, includeDetail } = options;

  const userMessage = decision.effect === "ALLOW" ? undefined : GENERIC_DENIAL_MESSAGE;

  if (!includeDetail) {
    return { userMessage };
  }

  const detail: PolicyExplanationDetail = {
    policyId: decision.policyId,
    policyVersion,
    matchedRule: decision.policyId,
    matchedRules: trace,
    decision: decision.effect,
    reasonCode: decision.reason,
    reasonDescription: DECISION_REASON_DESCRIPTIONS[decision.reason],
    requiredAssurance: decision.requiredAssurance,
    assuranceLevel: request ? computeAssuranceLevel(request.subject, request.context) : undefined,
    risk: request?.subject?.riskLevel,
    resource: request?.resource,
    requestId: decision.requestId,
    evaluatedAt: decision.evaluatedAt,
  };

  return { userMessage, detail };
}
