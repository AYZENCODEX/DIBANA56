/**
 * lib/policy/policy-errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 1A.
 *
 * These errors are only ever thrown internally within lib/policy/* — they
 * exist so `PolicyEngine.evaluate()` can catch a specific, known error type
 * and turn it into a well-labeled DENY decision, rather than deny-by-accident
 * via a generic try/catch around anything. `evaluate()` never lets one of
 * these escape to its caller (fail-closed, Rule 8 — see policy-engine.ts).
 */

/** Thrown by `buildAuthorizationRequest()` when the supplied shape does not
 *  satisfy the AuthorizationRequest invariants (see authorization-request.ts
 *  for the exact checks). Caught by the engine and converted to a DENY with
 *  reason INVALID_AUTHORIZATION_CONTEXT. */
export class InvalidAuthorizationContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthorizationContextError";
  }
}

/** Wraps any error thrown by a registered PolicyRule during evaluation.
 *  The original error is kept on `.cause` for logging, but is never exposed
 *  in the resulting AuthorizationDecision's message (rules can throw
 *  arbitrary/sensitive errors; the PDP's job is to fail closed, not to leak
 *  rule internals). */
export class PolicyEvaluationError extends Error {
  constructor(
    message: string,
    readonly policyId: string | undefined,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PolicyEvaluationError";
  }
}
