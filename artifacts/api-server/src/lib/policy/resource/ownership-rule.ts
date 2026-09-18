/**
 * lib/policy/resource/ownership-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3A.
 *
 * `createResourceOwnershipRule()` builds this engine's second real
 * `PolicyRule` (see rbac-rule.ts's header for the first) — it answers
 * exactly one question: "does `request.subject` own `request.resource`?"
 * Nothing about explicit per-resource grants, organization membership, or
 * classification/sensitivity (those are Phase 03's remaining scope — a
 * later sub-phase, since they need a new DB-backed lookup this sub-phase
 * deliberately does not introduce — see the Phase 3A CHANGES doc's "not
 * done" section).
 *
 * ── Why 3A is scoped to ownership + lock state only ─────────────────────
 * `ResourceRef` (lib/policy/types.ts, Phase 1A) already carries `ownerId`
 * and `locked` — both are plain fields on the request the caller builds,
 * not something this rule has to fetch. That is what makes this sub-phase
 * implementable with zero new schema and zero new provider interface:
 * every other Phase 03 rule (organization access, explicit grants,
 * resource-level deny) needs a data source this rule does not (an org
 * membership table, a resource_grants table) and is left to a later
 * sub-phase (per roadmap Rule 16 — do not implement future phases
 * prematurely).
 *
 * ── Convention this rule assumes ─────────────────────────────────────────
 * `request.resource.ownerId` must be populated by the caller (a PEP-side
 * concern — the route/service layer already knows which resource it's
 * checking and who owns it; this rule never fetches ownership itself, it
 * only compares what it is given). A resource with no `ownerId` at all is
 * not this rule's concern — it abstains, the same as RBAC's rule abstains
 * on a non-RBAC-shaped action.
 *
 * ── ABSTAIN, not DENY, when ownership doesn't match ─────────────────────
 * Same reasoning as rbac-rule.ts: returning `null` (abstain) rather than an
 * explicit `deny()` when the subject is not the owner is a deliberate
 * combining-algorithm choice. A non-owner might still be allowed via an
 * RBAC role grant (Phase 02), an org-level grant, or an explicit per-resource
 * grant (both later Phase 03 sub-phases) — this rule's job is only to
 * ADD a grant path for owners, never to be the final word on every
 * non-owner request. An explicit DENY here would wrongly foreclose those
 * other paths via deny-overrides combining (policy-engine.ts).
 *
 * ── Never trusts client input directly ──────────────────────────────────
 * `request.subject.userId` is the DB-verified `Subject` Phase 1A/1B produce
 * from `getUserFromToken()`'s own DB lookup — never a raw client-supplied
 * id. `request.resource.ownerId` is caller-supplied (see convention above),
 * so it is only as trustworthy as the PEP call site that populated it; this
 * rule does not (and cannot) verify that the caller looked up the real
 * owner rather than trusting a client-supplied resource id verbatim. Doing
 * that lookup correctly is the PEP/route layer's responsibility — the same
 * boundary RBAC draws around `RbacProvider` reads.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";

/** Stable id this rule should be registered under
 *  (`engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule())`). */
export const RESOURCE_OWNERSHIP_POLICY_ID = "resource-ownership";

export function createResourceOwnershipRule(): PolicyRule {
  return (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()), so
    // this branch is unreachable in practice. Kept so this rule is correct
    // even if ever called directly outside that wrapper.
    if (!subject) return null;

    const ownerId = request.resource.ownerId;
    if (ownerId === undefined || ownerId === null) return null; // no ownership fact to check — abstain

    if (ownerId !== subject.userId) return null; // not the owner — abstain, let other rules decide

    return allow(request, "EXPLICIT_ALLOW", {
      policyId: RESOURCE_OWNERSHIP_POLICY_ID,
      message: `granted via resource ownership (resource.ownerId === subject.userId === ${subject.userId})`,
    });
  };
}
