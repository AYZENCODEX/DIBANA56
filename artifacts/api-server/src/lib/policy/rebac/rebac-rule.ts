/**
 * lib/policy/rebac/rebac-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC).
 *
 * `createRebacRule()` builds this engine's fifth real `PolicyRule` (after
 * `rbac-rule.ts`, `ownership-rule.ts`, `explicit-grant-rule.ts`,
 * `organization-access-rule.ts`). It answers exactly one question: "does
 * any relation `request.subject` holds on `request.resource` cover
 * `request.action`?" — via `resolveRelations()` (the roadmap-mandated
 * resolver abstraction) and `relationGrantsAction()` (the relation→verb
 * map), never a direct storage query and never a hand-rolled action
 * check.
 *
 * ── Where Phase 04 draws its line ─────────────────────────────────────────
 * This rule deliberately does NOT implement: attribute comparisons/
 * operators (equals, IN, time-based — Phase 05 ABAC), a declarative policy
 * language (Phase 06's DSL), or a policy registry/precedence system
 * (Phase 07/08). It is exactly what the roadmap's Phase 04 section
 * describes and nothing past it: a relation vocabulary, a resolver
 * abstraction, and — the minimum needed to make seven distinct relation
 * kinds actually mean something different from each other, per
 * relation-action-map.ts's header — a fixed relation→action-verb mapping.
 * A finer-grained, caller-configurable action policy per relation is a
 * later phase's job (Rule 16).
 *
 * ── ABSTAIN, not DENY, on "no relation covers this action" ────────────────
 * Same combining-algorithm reasoning every other resource-family rule in
 * this engine already documents (see ownership-rule.ts / organization-
 * access-rule.ts headers): a subject who is merely a `viewer` and is
 * attempting a write action might still be allowed via an explicit
 * per-resource grant (3B) or an RBAC role permission (Phase 02) — this
 * rule only ever ADDS a grant path via relationship, it is never the
 * final word on a request no relation happens to cover. An explicit
 * `deny()` here would wrongly foreclose those other paths via
 * deny-overrides combining (policy-engine.ts). This rule never returns an
 * explicit DENY at all — same one-sided posture as `ownership-rule.ts`
 * and `organization-access-rule.ts` (unlike `explicit-grant-rule.ts`,
 * which is deliberately two-sided because an administrative
 * resource-level deny is a different kind of fact than "no relation
 * happens to apply").
 *
 * ── Requires a concrete resource id, same boundary as explicit grants ─────
 * A relationship, like an explicit resource grant, is inherently about
 * one concrete resource instance — `resource.id` must be present for this
 * rule to have anything to look up (unlike ownership-rule.ts /
 * organization-access-rule.ts, which only compare fields already present
 * on the request and need no storage read at all).
 *
 * ── Never trusts client input ─────────────────────────────────────────────
 * `request.subject.userId` is the DB-verified `Subject`, same boundary as
 * every other rule in this engine. `request.resource.type`/`.id` are
 * caller-supplied (PEP/route-layer concern, same trust boundary
 * ownership-rule.ts and explicit-grant-rule.ts both document) — this rule
 * only ever queries with them, it never trusts them to already encode a
 * decision. Every relation returned by the resolver is itself narrowed to
 * the closed `RelationKind` vocabulary before this rule ever compares it
 * against anything (see relationship-resolver.ts).
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { relationGrantsAction } from "./relation-action-map";
import { resolveRelations } from "./relationship-resolver";
import type { RelationshipProvider } from "./types";

/** Stable id this rule should be registered under. */
export const REBAC_POLICY_ID = "rebac";

export function createRebacRule(provider: RelationshipProvider): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()), so
    // this branch is unreachable in practice. Kept so this rule is
    // correct even if ever called directly (e.g. from a test) outside
    // that wrapper.
    if (!subject) return null;

    const resourceId = request.resource.id;
    if (resourceId === undefined || resourceId === null) return null; // nothing concrete to look up — abstain

    const relations = await resolveRelations(
      provider,
      subject.userId,
      request.resource.type,
      String(resourceId),
    );
    if (relations.length === 0) return null; // no relationship on file at all — abstain

    for (const relation of relations) {
      if (relationGrantsAction(relation, request.action)) {
        return allow(request, "EXPLICIT_ALLOW", {
          policyId: REBAC_POLICY_ID,
          message: `granted via relationship "${relation}" on ${request.resource.type}:${String(resourceId)}`,
        });
      }
    }

    return null; // subject has a relationship, but none covers this action — abstain, let other rules decide
  };
}
