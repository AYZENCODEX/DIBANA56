/**
 * lib/policy/authorization-decision.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 1A. Phase 16 (Policy
 * Versioning) added the `policyVersion` pass-through described below.
 *
 * Small factory helpers so every AuthorizationDecision is built the same
 * way (always stamps requestId + evaluatedAt from the triggering request /
 * clock — a rule author never has to remember to do this by hand). Rules
 * (PolicyRule implementations, from Phase 02 onward) should build their
 * ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED return values with these rather than
 * constructing the object literal directly.
 *
 * ── Phase 16: `policyVersion` is purely additive ─────────────────────────
 * `options.policyVersion` on every builder below is an optional pass-
 * through onto the resulting decision's own `policyVersion` field (see
 * types.ts's doc comment on that field) — a caller that doesn't pass it
 * gets byte-for-byte the same decision shape every phase before Phase 16
 * already produced (the field is simply `undefined`). Only
 * `../registry/registry-rule-loader.ts`'s `createRegistryPolicyRule()`
 * passes it today, always alongside `policyId` from the exact same
 * `PolicyRecord`, so the two can never disagree about which version fired.
 */

import type { AuthorizationDecision, AuthorizationRequest, DecisionEffect } from "./types";
import type { DecisionReasonCode } from "./decision-reasons";

function stamp(
  request: AuthorizationRequest,
  effect: DecisionEffect,
  reason: DecisionReasonCode,
  message?: string,
  policyId?: string,
  requiredAssurance?: string,
  policyVersion?: number,
): AuthorizationDecision {
  return {
    effect,
    reason,
    message,
    requestId: request.context.requestId,
    evaluatedAt: new Date(),
    policyId,
    requiredAssurance,
    policyVersion,
  };
}

export function allow(
  request: AuthorizationRequest,
  reason: DecisionReasonCode,
  options?: { message?: string; policyId?: string; policyVersion?: number },
): AuthorizationDecision {
  return stamp(request, "ALLOW", reason, options?.message, options?.policyId, undefined, options?.policyVersion);
}

export function deny(
  request: AuthorizationRequest,
  reason: DecisionReasonCode,
  options?: { message?: string; policyId?: string; policyVersion?: number },
): AuthorizationDecision {
  return stamp(request, "DENY", reason, options?.message, options?.policyId, undefined, options?.policyVersion);
}

/**
 * Phase 14 addition: `options.requiredAssurance` is an optional, purely
 * additive pass-through onto the resulting decision's own
 * `requiredAssurance` field (see types.ts's doc comment on that field) — a
 * caller that doesn't pass it gets byte-for-byte the same decision shape
 * every phase before Phase 14 already produced (the field is simply
 * `undefined`). Only `assurance/assurance-rule.ts` passes it today.
 */
export function stepUp(
  request: AuthorizationRequest,
  options?: { message?: string; policyId?: string; requiredAssurance?: string; policyVersion?: number },
): AuthorizationDecision {
  return stamp(
    request,
    "STEP_UP",
    "STEP_UP_REQUIRED",
    options?.message,
    options?.policyId,
    options?.requiredAssurance,
    options?.policyVersion,
  );
}

export function approvalRequired(
  request: AuthorizationRequest,
  options?: { message?: string; policyId?: string; policyVersion?: number },
): AuthorizationDecision {
  return stamp(request, "APPROVAL_REQUIRED", "APPROVAL_REQUIRED", options?.message, options?.policyId, undefined, options?.policyVersion);
}
