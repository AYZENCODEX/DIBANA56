/**
 * lib/policy/abac/abac-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC).
 *
 * `createAbacRule()` builds this engine's sixth real `PolicyRule` (after
 * `rbac-rule.ts`, `ownership-rule.ts`, `explicit-grant-rule.ts`,
 * `organization-access-rule.ts`, `rebac-rule.ts`). It answers: "does any
 * registered `AbacPolicyDefinition` whose `actions` cover this action have
 * a `condition` that matches this request's resolved attributes?" —
 * evaluated via `resolveAttributes()` + `evaluateAbacCondition()`, never a
 * hand-rolled attribute comparison.
 *
 * ── Two-sided, deny-overrides WITHIN this rule too ────────────────────────
 * Like `explicit-grant-rule.ts` (and unlike `ownership-rule.ts`/
 * `organization-access-rule.ts`/`rebac-rule.ts`, which only ever ALLOW or
 * abstain), an ABAC policy can carry `effect: "deny"` — an attribute
 * condition matching (e.g. "resource.sensitivity == high AND NOT
 * subject.verificationLevel == identity_verified") is exactly the kind of
 * deliberate, condition-shaped restriction the roadmap's ABAC section
 * describes, not merely "no grant path found". This function therefore
 * mirrors `policy-engine.ts`'s own deny-overrides combining algorithm one
 * level down: it scans every policy (in list order), returns the first
 * matching `deny` IMMEDIATELY (never a later matching `allow` overrides an
 * earlier matching `deny`, regardless of list position — matching deny-
 * overrides' "order is irrelevant to the final effect" guarantee), and
 * otherwise remembers the first matching `allow` and keeps scanning (a
 * later policy's `deny` must still be able to override it).
 *
 * ── ABSTAIN when nothing matches ──────────────────────────────────────────
 * If no policy's `actions` cover this action, or no matching policy's
 * `condition` evaluates true, this rule returns `null` — same posture as
 * every ALLOW-or-abstain rule in this engine: "no attribute policy had an
 * opinion" is not the same fact as "denied", and must not foreclose an
 * RBAC/ownership/ReBAC grant path via deny-overrides (policy-engine.ts).
 *
 * ── Action matching reuses RBAC's grammar, not a new one ──────────────────
 * `AbacPolicyDefinition.actions` (when present) is matched with
 * `rbac/permission-matcher.ts#permissionMatches()` — the same "product.
 * resource.action" / trailing-wildcard grammar RBAC grants already use.
 * This is a deliberate reuse, not a new action-matching concept Phase 05
 * invents: one grammar for "which actions does this apply to" across the
 * whole engine, audited once (see permission-matcher.ts's own header for
 * why it fails closed on malformed patterns).
 *
 * ── Never trusts client input beyond what upstream already verified ───────
 * Same boundary every other rule in this engine draws (see ownership-
 * rule.ts's header): `request.subject` is the DB-verified `Subject`;
 * every other attribute this rule reads (`resource.*`, `context.*`) is only
 * as trustworthy as whatever PEP/route-layer code populated the
 * `AuthorizationRequest` — this rule does not and cannot verify that
 * upstream. It also does no attribute resolution or comparison via
 * `eval()` or any other dynamic code execution — see abac/types.ts's
 * header for why that's true by construction, not merely by convention.
 */

import { allow, deny } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { permissionMatches } from "../rbac/permission-matcher";
import { resolveAttributes } from "./attribute-resolver";
import { evaluateAbacCondition } from "./condition-evaluator";
import type { AbacPolicyDefinition } from "./types";

/** Stable id this rule should be registered under
 *  (`engine.registerRule(ABAC_POLICY_ID, createAbacRule(policies))`). */
export const ABAC_POLICY_ID = "abac";

/** True if `policy` applies to `action` — no `actions` list at all means
 *  "applies to every action"; otherwise at least one pattern must match via
 *  RBAC's own grammar (see file header). */
function policyAppliesToAction(policy: AbacPolicyDefinition, action: string): boolean {
  if (!policy.actions || policy.actions.length === 0) return true;
  return policy.actions.some((pattern) => permissionMatches(pattern, action));
}

export function createAbacRule(policies: readonly AbacPolicyDefinition[]): PolicyRule {
  return (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()), so
    // this branch is unreachable in practice. Kept so this rule is correct
    // even if ever called directly outside that wrapper.
    if (!subject) return null;

    if (policies.length === 0) return null; // nothing registered — abstain, not a decision

    const bag = resolveAttributes(subject, request.resource, request.context, request.action);

    let firstAllow: ReturnType<typeof allow> | null = null;

    for (const policy of policies) {
      if (!policyAppliesToAction(policy, request.action)) continue;
      if (!evaluateAbacCondition(policy.condition, bag)) continue;

      if (policy.effect === "deny") {
        return deny(request, "ATTRIBUTE_POLICY_DENIED", {
          policyId: ABAC_POLICY_ID,
          message: policy.message ?? `attribute policy "${policy.id}" denied this request`,
        });
      }

      if (firstAllow === null) {
        firstAllow = allow(request, "EXPLICIT_ALLOW", {
          policyId: ABAC_POLICY_ID,
          message: policy.message ?? `attribute policy "${policy.id}" allowed this request`,
        });
        // Keep scanning — a later policy in this same list may still match
        // with effect "deny", which must override this allow (see header).
      }
    }

    return firstAllow; // may be null → abstain, let other rules/default-deny decide
  };
}
