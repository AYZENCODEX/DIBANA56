/**
 * lib/policy/decision-reasons.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 1A.
 *
 * Closed vocabulary of reason codes an AuthorizationDecision can carry. Kept
 * as a single flat union (not per-phase files) so a log line's `reason`
 * field is always resolvable from one place, no matter which phase's rule
 * produced it. Phase 02+ rules add new codes here rather than inventing
 * ad-hoc strings inline.
 */

export type DecisionReasonCode =
  // ── Phase 01 — engine-level outcomes (no rule matched / engine failure) ──
  /** No registered rule produced ALLOW, and none produced DENY either — the
   *  request simply wasn't addressed by any policy. Rule 7 (default deny). */
  | "NO_MATCHING_POLICY"
  /** At least one rule explicitly denied. Deny-overrides combining. */
  | "EXPLICIT_DENY"
  /** At least one rule allowed and no rule denied. */
  | "EXPLICIT_ALLOW"
  /** The AuthorizationRequest itself failed shape/invariant validation
   *  before any rule ran (e.g. missing action, malformed resource). */
  | "INVALID_AUTHORIZATION_CONTEXT"
  /** A registered rule threw during evaluation. Fail-closed (Rule 8): this
   *  always resolves to DENY, never to whatever the throwing rule might
   *  have otherwise decided. */
  | "POLICY_EVALUATION_ERROR"
  /** subject is null — caller is not authenticated at all. Distinguished
   *  from EXPLICIT_DENY so logs/metrics can separate "not logged in" from
   *  "logged in but not permitted". */
  | "UNAUTHENTICATED"

  // ── Phase 19 (PEP), Phase 22E (Reliability) hardening ────────────────────
  /** A Phase 18 `PolicyInformationPoint` provider (subject/risk/session/
   *  device) threw while `pep/authorize.ts` was resolving the Subject/
   *  PolicyContext for this request — a DB outage, a network timeout, or
   *  any other provider-level failure. Distinguished from
   *  POLICY_EVALUATION_ERROR (a registered *rule* throwing, already caught
   *  inside `PolicyEngine.evaluateCore()`) because this failure happens
   *  BEFORE a request is even built: there is no trustworthy Subject/
   *  PolicyContext yet to hand to the engine at all, so `authorize()`
   *  fails closed immediately rather than evaluating with unknown or
   *  partially-enriched attributes. See `pep/authorize.ts`'s own header
   *  for why this is a deliberate, narrow exception to "always call the
   *  real engine". */
  | "PIP_ENRICHMENT_ERROR"

  // ── Phase 03 (Resource / Ownership Authorization), sub-phase 3A ──────────
  /** A resource-level rule (locked-resource restriction, resource-level
   *  deny, etc. — see lib/policy/resource/*) explicitly denied, independent
   *  of RBAC/role grants. Kept distinct from EXPLICIT_DENY so audit logs
   *  can tell "no role covers this" apart from "a specific resource's own
   *  state blocked it" without inspecting policyId. */
  | "RESOURCE_LOCKED"

  // ── Phase 03 (Resource / Ownership Authorization), sub-phase 3B ──────────
  /** An explicit per-(subject, resource, action) grant row (see
   *  lib/policy/resource/explicit-grant-rule.ts) had `effect: "deny"` on
   *  file. Kept distinct from EXPLICIT_DENY/RESOURCE_LOCKED so audit logs
   *  can tell "this specific administrative override fired" apart from a
   *  locked-resource restriction or an RBAC-level denial, without
   *  inspecting `policyId`. */
  | "RESOURCE_GRANT_DENIED"

  // ── Phase 05 (ABAC) ────────────────────────────────────────────────────
  /** An attribute-based policy (see lib/policy/abac/abac-rule.ts) with
   *  `effect: "deny"` had its condition match this request. Kept distinct
   *  from EXPLICIT_DENY/RESOURCE_GRANT_DENIED/RESOURCE_LOCKED so audit logs
   *  can tell "an attribute condition fired" apart from an RBAC-level
   *  denial, a per-resource grant deny, or a locked-resource restriction,
   *  without inspecting `policyId`. */
  | "ATTRIBUTE_POLICY_DENIED"

  // ── Phase 10 (Risk-Aware Authorization) ───────────────────────────────
  /** A risk-aware policy (see lib/policy/risk/risk-rule.ts) found the
   *  subject's computed risk level HIGH and denied outright, independent
   *  of role/ownership/relationship/attribute/assurance grants. Kept
   *  distinct from every other *_DENIED code so audit logs can tell "risk
   *  alone blocked this" apart from any other rule's denial, without
   *  inspecting `policyId`. */
  | "HIGH_RISK_DENIED"

  // ── Phase 12 (Approval Engine) ─────────────────────────────────────────
  // (STEP_UP_REQUIRED/APPROVAL_REQUIRED were reserved from Phase 1A — see
  // below; Phase 12 is the first phase to actually produce
  // APPROVAL_REQUIRED, via lib/policy/approval/approval-gate-rule.ts.)

  // ── Phase 13 (Separation of Duties) ───────────────────────────────────
  /** A registered separation-of-duty constraint (see
   *  lib/policy/sod/separation-of-duties-rule.ts) matched this action and
   *  found the subject on the "wrong side" of its own prior involvement
   *  with this exact resource — either as the resource's own creator
   *  (`resource.ownerId === subject.userId`, the roadmap's "creator !=
   *  approver" example) or via a registered conflicting ReBAC relation
   *  (e.g. holding `editor`/`owner`/`manager` on a resource they are now
   *  trying to `approve`, the roadmap's "requester != reviewer" example).
   *  Kept distinct from every other *_DENIED/*_VIOLATION code so audit
   *  logs can tell "the same person is on both sides of this workflow"
   *  apart from any other rule's denial, without inspecting `policyId`.
   *  Unlike `ApprovalEngine`'s `SelfDecisionNotAllowedError` (Phase 12,
   *  which is scoped to one specific `approval_requests` row and its own
   *  literal initiator/decider), this is a general-purpose PDP-level gate
   *  that can fire even for actions that never go through an approval
   *  request at all. */
  | "SEPARATION_OF_DUTIES_VIOLATION"

  // ── Reserved for later Phase 01+ sub-phases / later phases. Not produced
  //    by anything in 1A — listed here now so the union doesn't need a
  //    breaking change when those phases land. ──
  | "STEP_UP_REQUIRED"
  | "APPROVAL_REQUIRED";

export const DECISION_REASON_DESCRIPTIONS: Record<DecisionReasonCode, string> = {
  NO_MATCHING_POLICY: "No registered policy addressed this request; defaulting to deny.",
  EXPLICIT_DENY: "A registered policy explicitly denied this request.",
  EXPLICIT_ALLOW: "A registered policy explicitly allowed this request.",
  INVALID_AUTHORIZATION_CONTEXT: "The authorization request failed validation before evaluation.",
  POLICY_EVALUATION_ERROR: "A policy threw during evaluation; failing closed.",
  UNAUTHENTICATED: "No authenticated subject was present on the request.",
  PIP_ENRICHMENT_ERROR:
    "A Policy Information Point provider failed while resolving the subject or context for this request; failing closed before evaluation.",
  RESOURCE_LOCKED: "The target resource is locked; this action is not permitted while it remains locked.",
  RESOURCE_GRANT_DENIED: "An explicit per-resource grant on file denies this subject this exact action.",
  ATTRIBUTE_POLICY_DENIED: "An attribute-based (ABAC) policy condition matched and explicitly denied this request.",
  HIGH_RISK_DENIED: "The subject's computed risk level is HIGH; denying regardless of any other grant.",
  SEPARATION_OF_DUTIES_VIOLATION:
    "A separation-of-duties constraint denies this subject this action on this resource, due to the subject's own prior involvement with it (e.g. creator, requester, or key-rotator acting as their own approver/reviewer).",
  STEP_UP_REQUIRED: "Stronger authentication assurance is required for this action.",
  APPROVAL_REQUIRED: "This action requires a separate approval before it can proceed.",
};
