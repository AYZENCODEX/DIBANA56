/**
 * lib/policy/resource/organization-access-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3C.
 *
 * `createOrganizationAccessRule()` implements the roadmap's "organization
 * access" line item — the last of Phase 03's five rules still missing
 * after 3A (ownership, locked-resource) and 3B (explicit grants,
 * resource-level deny). It answers exactly one question: "does
 * `request.subject` belong to the same organization that owns
 * `request.resource`?"
 *
 * ── Why this needed no new DB table (unlike 3B) ──────────────────────────
 * Both halves of the comparison already exist as plain fields on types
 * Phase 1A shipped: `Subject.organizationId` and `ResourceRef.organizationId`
 * (lib/policy/types.ts). Phase 1A's own comment on `Subject.organizationId`
 * says "Not modeled by the current schema yet (Phase 03+ concern) — carried
 * here as optional so later phases don't need to touch this interface" —
 * this rule is that later phase. Same posture as ownership-rule.ts (3A):
 * a pure comparison over caller-supplied fields, zero new schema, zero new
 * provider interface. Nothing in this codebase populates
 * `Subject.organizationId` from a real org-membership table yet (see the
 * Phase 3C CHANGES doc's "not done" section) — same "additive, unwired
 * surface area" posture every other sub-phase in this roadmap has shipped
 * with (RBAC's `user_roles`, 3B's `resource_grants` table both started
 * empty/unwired too).
 *
 * ── Convention this rule assumes ─────────────────────────────────────────
 * Both `request.subject.organizationId` and `request.resource.organizationId`
 * are caller-supplied (a PIP/PEP-side concern — whatever populates the
 * `Subject`/builds the `ResourceRef` already knows the real org membership
 * and the real resource's org; this rule never looks either up itself).
 * Same trust boundary ownership-rule.ts documents for `ownerId`.
 *
 * ── ABSTAIN, not DENY, on a mismatch or missing fact ─────────────────────
 * Exactly ownership-rule.ts's reasoning, restated for org membership: a
 * subject outside the resource's organization might still be allowed via
 * an explicit per-resource grant (3B) or an RBAC role grant (Phase 02) —
 * this rule only ever ADDS a grant path for same-org subjects, it is never
 * the final word on a cross-tenant request. Returning an explicit `deny()`
 * here would wrongly foreclose those other paths via deny-overrides
 * combining (policy-engine.ts). A resource with no `organizationId` at all,
 * or a subject with no `organizationId` at all (the common case today,
 * since nothing populates it yet), both abstain — there is no organization
 * fact to compare, not a mismatch.
 *
 * ── Deliberately no action restriction (symmetric with ownership-rule.ts) ──
 * Like ownership-rule.ts, this rule grants access to every action once the
 * organization matches — it does not itself scope which actions an org
 * member may take (that is Phase 02's RBAC rule's job, layered on top by
 * the engine's combining algorithm; a same-org ALLOW here does not bypass
 * a locked-resource DENY or a resource-grant DENY either — see
 * policy-engine.ts's deny-overrides algorithm and this rule's own test
 * file for the composition tests). Blanket "same org ⇒ full access" is a
 * deliberately blunt starting rule, matching the roadmap's plain
 * "organization access" line item; a finer-grained per-role-within-org
 * model is Phase 04 (ReBAC)'s "member/manager/viewer/editor" relationship
 * vocabulary, not this sub-phase's scope (Rule 16).
 *
 * ── Never trusts client input directly ──────────────────────────────────
 * `request.subject` is the DB-verified `Subject` object the PDP is handed
 * (Phase 1A/1B) — never a raw client-supplied id. `request.resource.
 * organizationId` is caller-supplied (see convention above); this rule does
 * not (and cannot) verify the caller looked up the resource's real owning
 * organization rather than trusting a client-supplied value verbatim —
 * that lookup is the PEP/route layer's responsibility, the same boundary
 * every other resource-field-consuming rule in this file draws.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";

/** Stable id this rule should be registered under. */
export const ORGANIZATION_ACCESS_POLICY_ID = "organization-access";

export function createOrganizationAccessRule(): PolicyRule {
  return (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()), so
    // this branch is unreachable in practice. Kept so this rule is correct
    // even if ever called directly outside that wrapper.
    if (!subject) return null;

    const subjectOrgId = subject.organizationId;
    if (subjectOrgId === undefined || subjectOrgId === null) return null; // subject has no org membership fact — abstain

    const resourceOrgId = request.resource.organizationId;
    if (resourceOrgId === undefined || resourceOrgId === null) return null; // resource has no org fact — abstain

    if (resourceOrgId !== subjectOrgId) return null; // different organization — abstain, let other rules decide

    return allow(request, "EXPLICIT_ALLOW", {
      policyId: ORGANIZATION_ACCESS_POLICY_ID,
      message: `granted via organization access (resource.organizationId === subject.organizationId === ${subjectOrgId})`,
    });
  };
}
