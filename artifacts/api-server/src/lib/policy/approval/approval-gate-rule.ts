/**
 * lib/policy/approval/approval-gate-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * `createApprovalGateRule()` implements the roadmap's Phase 12 section:
 * "Support REQUIRE_APPROVAL" — a `PolicyRule` that answers "does this
 * action require a separate, already-on-file approval before it can
 * proceed, and if so, does one exist?".
 *
 * ── A gate that CAN allow, unlike `assurance-rule.ts` ──────────────────────
 * `createAssuranceRule()` (../assurance/assurance-rule.ts) can only ever
 * STEP_UP or abstain — meeting an assurance requirement is necessary but
 * never sufficient for access on its own. Approval is different: the
 * roadmap's own target architecture places `APPROVAL` as a THIRD sibling
 * outcome alongside `ALLOW`/`STEP-UP`, not a mere precondition layered on
 * top of some other rule's grant — an approved request IS the grant for
 * this specific action. So this rule:
 *   - returns `APPROVAL_REQUIRED` when a registered requirement matches
 *     the action and no live `APPROVED` request covers this exact
 *     `(initiator, resourceType, resourceId, action)` tuple;
 *   - returns `ALLOW` when one does;
 *   - abstains (`null`) when no registered requirement matches the action
 *     at all — same "no requirement covers this, nothing to add" abstain
 *     `assurance-rule.ts` already documents.
 * It never returns `DENY` — a `REJECTED` or `EXPIRED` prior request simply
 * means no live `APPROVED` row exists yet, which this rule treats
 * identically to "never requested at all": `APPROVAL_REQUIRED`, prompting
 * a fresh request. Manufacturing a permanent `DENY` from a past rejection
 * would foreclose ever trying again through this same gate, which nothing
 * in the roadmap's Phase 12 section asks for (Separation of Duties-style
 * hard blocks are Phase 13's concern, not this one's).
 *
 * ── `APPROVAL_REQUIRED` short-circuits regardless of which engine runs it,
 *    and regardless of registration order relative to any ALLOW ──────────
 * `policy-engine.ts`'s `evaluateCore()` treats `STEP_UP`/`APPROVAL_REQUIRED`
 * as an immediate, non-combinable outcome (see that file's own header) —
 * once ANY registered rule returns `APPROVAL_REQUIRED`, evaluation stops
 * right there. Because the loop still visits every earlier-registered
 * rule first, an `ALLOW` from a rule registered BEFORE this one does NOT
 * protect the request: `evaluateCore()`'s "keep scanning after a first
 * ALLOW" step still reaches this rule, and once it returns
 * `APPROVAL_REQUIRED` the engine returns that immediately, discarding the
 * already-recorded `ALLOW`. This is deliberate and required by the
 * roadmap: an approval-gated action must never be silently let through by
 * some OTHER, approval-blind grant path (RBAC, ownership, an explicit
 * resource grant) that happens to also cover the same action — same
 * reasoning `assurance-rule.ts`'s header gives for its own STEP_UP.
 * A `DENY` from a rule registered BEFORE this one still wins outright
 * (deny-overrides, unconditionally) — only registration ORDER relative to
 * a DENY (not to an ALLOW) matters, exactly as `assurance-rule.ts`'s
 * header already documents for STEP_UP. Which precedence tier this rule
 * should occupy in a `PrecedenceEngine` is likewise NOT decided here — see
 * that same header section; a caller wiring up a `PrecedenceEngine`
 * instance makes that registration-time choice, same as for ABAC/
 * assurance.
 *
 * ── Exact-match lookup only — no wildcard resource matching ────────────────
 * `provider.findApprovedRequest()` is asked about the EXACT
 * `(initiatorUserId, resourceType, resourceId, action)` tuple this request
 * names — same granularity `resource_grants`/`explicit-grant-rule.ts`
 * already establish for a permanent per-resource grant (see schema file's
 * header: "resourceType + resourceId (when present) + action is therefore
 * always an exact-match tuple here"). There is no `scope: "resource_type"`
 * breadth the way Phase 11's temporary grants have — an approval request
 * is inherently about ONE named initiator asking for ONE specific,
 * accountable action, not a broad short-lived capability.
 *
 * ── Which actions require approval is a registration-time input, same
 *    posture `AssuranceRequirement[]`/`AbacPolicyDefinition[]` already take ──
 * `ApprovalRequirement[]` is passed in by whatever code registers
 * `createApprovalGateRule()` — not persisted/versioned/administered
 * anywhere by this phase (Rule 16; a future Phase 07-style registry entry
 * could compile down to this shape later, same bridge `assurance-rule.ts`'s
 * header notes for its own `AssuranceRequirement`, but nothing in Phase 12
 * builds it).
 *
 * ── Action matching reuses RBAC's grammar, not a new one ──────────────────
 * Same reuse `assurance-rule.ts`/`abac-rule.ts` already established:
 * `ApprovalRequirement.actions` (when present) is matched with
 * `rbac/permission-matcher.ts#permissionMatches()`.
 */

import { allow, approvalRequired } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { permissionMatches } from "../rbac/permission-matcher";
import type { ApprovalRequestProvider } from "./types";

/** Stable id this rule should be registered under. */
export const APPROVAL_GATE_POLICY_ID = "approval-gate";

/**
 * One "this action requires a separate approval" statement, as
 * `createApprovalGateRule()` consumes it. Deliberately NOT persisted
 * anywhere yet — see file header.
 */
export interface ApprovalRequirement {
  /** Stable identifier for this individual statement (distinct from the
   *  rule's own registration id). Surfaced in the decision's `message`
   *  for audit/debugging, same role `AssuranceRequirement.id` plays. */
  id: string;
  /** Optional action pattern(s) this requirement applies to, using
   *  `permissionMatches()`'s grammar (e.g. `["ryft.payment.approve"]`).
   *  Omit to apply to every action regardless of what it is — same
   *  "no actions list means every action" default `abac-rule.ts`'s
   *  `policyAppliesToAction()`/`assurance-rule.ts`'s
   *  `requirementAppliesToAction()` already use. */
  actions?: string[];
  /** Optional human-readable detail surfaced on a resulting
   *  `APPROVAL_REQUIRED` decision's `message`. Never put secrets/PII here
   *  — same rule as everywhere else in this engine. */
  message?: string;
}

function requirementAppliesToAction(requirement: ApprovalRequirement, action: string): boolean {
  if (!requirement.actions || requirement.actions.length === 0) return true;
  return requirement.actions.some((pattern) => permissionMatches(pattern, action));
}

function firstMatchingRequirement(
  requirements: readonly ApprovalRequirement[],
  action: string,
): ApprovalRequirement | undefined {
  return requirements.find((requirement) => requirementAppliesToAction(requirement, action));
}

/** `request.resource.id` normalized to exactly what `ApprovalRequestRecord.
 *  resourceId`/`provider.findApprovedRequest()` expect: a string, or
 *  `null` for "no concrete resource" — never `undefined`, so a lookup
 *  against a `resourceId IS NULL` row (an org-wide approval) works
 *  regardless of whether the caller omitted `resource.id` or explicitly
 *  passed `undefined`. */
function normalizeResourceId(id: string | number | undefined): string | null {
  if (id === undefined || id === null) return null;
  return String(id);
}

/**
 * Builds a `PolicyRule` that returns `APPROVAL_REQUIRED` when `action`
 * matches a registered `ApprovalRequirement` and no live `APPROVED`
 * request covers this exact request, `ALLOW` when one does, and otherwise
 * abstains. See file header for the full contract, in particular why this
 * rule (unlike `assurance-rule.ts`) can return `ALLOW`.
 */
export function createApprovalGateRule(
  requirements: readonly ApprovalRequirement[],
  provider: ApprovalRequestProvider,
): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see assurance-rule.ts /
    // rbac-rule.ts for the same note), so this branch is unreachable in
    // practice. Kept so this rule is correct even if ever called directly
    // outside that wrapper.
    if (!subject) return null;

    if (requirements.length === 0) return null; // nothing registered — abstain, not a decision

    const requirement = firstMatchingRequirement(requirements, request.action);
    if (!requirement) return null; // no requirement covers this action — abstain

    const resourceId = normalizeResourceId(request.resource.id);
    const approved = await provider.findApprovedRequest(subject.userId, request.resource.type, resourceId, request.action);

    if (approved) {
      return allow(request, "EXPLICIT_ALLOW", {
        policyId: APPROVAL_GATE_POLICY_ID,
        message:
          approved.decisionReason ??
          `approved by user ${approved.decidedBy} on ${approved.decidedAt ? approved.decidedAt.toISOString() : "unknown date"}`,
      });
    }

    return approvalRequired(request, {
      policyId: APPROVAL_GATE_POLICY_ID,
      message: requirement.message ?? `action "${request.action}" requires a separate approval before it can proceed`,
    });
  };
}
