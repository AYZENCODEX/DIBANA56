/**
 * lib/policy/sod/separation-of-duties-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 13 (Separation of Duties).
 *
 * `createSeparationOfDutiesRule()` implements the roadmap's Phase 13
 * section verbatim: "Support constraints such as: creator != approver,
 * requester != reviewer, key-rotator != sole approver. Prioritize finance,
 * vault, security and organization administration." It answers exactly one
 * question: "is `request.subject` on the wrong side of their own prior
 * involvement with `request.resource`, for `request.action`?" — never
 * "is this subject allowed to do this at all".
 *
 * ── A GATE, not a grant path — this rule NEVER returns ALLOW ─────────────
 * Same one-sided posture `assurance-rule.ts` documents for STEP_UP: this
 * rule can only ever DENY or abstain. It says nothing about role/
 * ownership/relationship/attributes/approval-state, so it must never
 * manufacture an ALLOW those other rules didn't themselves produce — it
 * only ever REMOVES a path an otherwise-permitted subject would have had,
 * for the narrow "same person, conflicting role" case the roadmap names.
 *
 * ── Unlike `assurance-rule.ts`, this is a DENY gate, not a STEP_UP gate —
 *    same posture `locked-resource-rule.ts` / the deny half of
 *    `explicit-grant-rule.ts` already establish for a hard stop ───────────
 * A separation-of-duties violation is not "prove you're more assured and
 * try again" (STEP_UP) — no amount of additional authentication fixes
 * "you are also the person who created/requested/rotated the thing you are
 * now trying to approve/review". It is a hard, unconditional stop, so it
 * must win via deny-overrides (policy-engine.ts) regardless of which order
 * rules are registered in, exactly like `locked-resource-rule.ts`'s
 * RESOURCE_LOCKED and `explicit-grant-rule.ts`'s RESOURCE_GRANT_DENIED.
 *
 * ── Which tier this belongs to in a `PrecedenceEngine` is NOT decided
 *    here ─────────────────────────────────────────────────────────────────
 * `precedence-tiers.ts`'s existing "Resource deny" tier (4) is the natural
 * home for this rule — same tier `locked-resource-rule.ts` and the DENY
 * half of `explicit-grant-rule.ts` already occupy, since a separation-of-
 * duties conflict is, like those two, a fact about THIS resource (who
 * created it, what relations are on file for it) rather than a tenant-wide
 * or global policy. As with every prior gate/deny rule in this engine
 * (see `assurance-rule.ts` / `approval-gate-rule.ts` headers), tier
 * assignment is still a registration-time choice made by whoever wires up
 * a specific `PrecedenceEngine` instance, not something this file or
 * `precedence-tiers.ts` hardcodes — a caller using the flat `PolicyEngine`
 * doesn't need to make that choice at all.
 *
 * ── Two independent conflict checks, both evaluated per matching
 *    constraint (not "first match wins") ──────────────────────────────────
 * Unlike `assurance-rule.ts`'s "strictest matching requirement" (a single
 * winner is meaningful there because assurance levels are ordered/
 * comparable), a separation-of-duties conflict is a plain boolean per
 * check — there is no "worse" violation to prefer, only "is there a
 * conflict or not". So this rule walks every registered constraint whose
 * `actions` cover `request.action` and returns the FIRST conflict it
 * finds (resource-owner check first, then conflicting-relations check),
 * in registration order — which one is reported only affects the DENY
 * decision's `message`/`policyId` wording, never whether a conflict is
 * found at all (any single matching conflict is already sufficient to
 * deny).
 *
 * ── `conflictingRelations` requires a `RelationshipProvider`; omitting one
 *    is not an error ────────────────────────────────────────────────────
 * Same "no data source, nothing to check, abstain rather than fabricate"
 * posture `rebac-rule.ts` and `approval-gate-rule.ts` both take toward
 * their own optional storage reads. A caller who only cares about the
 * `blockResourceOwner` check (needs no storage read at all — `ownerId` is
 * already on the request) may construct this rule with no provider; any
 * constraint's `conflictingRelations` is then simply never checked, not
 * treated as an error and not treated as an automatic conflict.
 *
 * ── Requires a concrete resource id for the relations check only ─────────
 * Same boundary `rebac-rule.ts` documents: a relation is inherently about
 * one concrete resource instance. The resource-owner check needs no
 * `resource.id` at all (it only compares `resource.ownerId`), so a
 * constraint with `blockResourceOwner: true` and no `resourceId` on the
 * request still works; only the `conflictingRelations` half is skipped
 * when `resource.id` is absent.
 *
 * ── Action matching reuses RBAC's grammar, not a new one ──────────────────
 * Same reuse `abac-rule.ts` / `assurance-rule.ts` / `approval-gate-rule.ts`
 * already established: `SeparationOfDutyConstraint.actions` (when present)
 * is matched with `rbac/permission-matcher.ts#permissionMatches()`.
 *
 * ── Never trusts client input ─────────────────────────────────────────────
 * `request.subject.userId` is the DB-verified `Subject`, same boundary as
 * every other rule in this engine. `request.resource.ownerId`/`.id`/
 * `.type` are caller-supplied (PEP/route-layer concern, same trust
 * boundary `ownership-rule.ts` / `rebac-rule.ts` both document) — this
 * rule only ever compares/queries with them, it never trusts them to
 * already encode a decision.
 */

import { deny } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { permissionMatches } from "../rbac/permission-matcher";
import { resolveRelations } from "../rebac/relationship-resolver";
import type { RelationshipProvider } from "../rebac/types";
import type { SeparationOfDutyConstraint } from "./types";

/** Stable id this rule should be registered under. */
export const SEPARATION_OF_DUTIES_POLICY_ID = "separation-of-duties";

function constraintAppliesToAction(constraint: SeparationOfDutyConstraint, action: string): boolean {
  if (!constraint.actions || constraint.actions.length === 0) return true;
  return constraint.actions.some((pattern) => permissionMatches(pattern, action));
}

function matchingConstraints(
  constraints: readonly SeparationOfDutyConstraint[],
  action: string,
): SeparationOfDutyConstraint[] {
  return constraints.filter((constraint) => constraintAppliesToAction(constraint, action));
}

/**
 * Builds a `PolicyRule` that DENIES when `action` matches a registered
 * `SeparationOfDutyConstraint` and the subject is found in conflict with
 * their own prior involvement with `request.resource` — via
 * `resource.ownerId` ("creator != approver") and/or a registered
 * conflicting ReBAC relation ("requester != reviewer" /
 * "key-rotator != sole approver") — and otherwise abstains (see file
 * header — this rule never produces ALLOW). `relationshipProvider` is
 * optional: omit it to use only the `blockResourceOwner` check (see file
 * header).
 */
export function createSeparationOfDutiesRule(
  constraints: readonly SeparationOfDutyConstraint[],
  relationshipProvider?: RelationshipProvider,
): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see assurance-rule.ts /
    // approval-gate-rule.ts for the same note), so this branch is
    // unreachable in practice. Kept so this rule is correct even if ever
    // called directly outside that wrapper.
    if (!subject) return null;

    if (constraints.length === 0) return null; // nothing registered — abstain, not a decision

    const matching = matchingConstraints(constraints, request.action);
    if (matching.length === 0) return null; // no constraint covers this action — abstain

    for (const constraint of matching) {
      const blockOwner = constraint.blockResourceOwner ?? true;
      if (blockOwner) {
        const ownerId = request.resource.ownerId;
        if (ownerId !== undefined && ownerId !== null && ownerId === subject.userId) {
          return deny(request, "SEPARATION_OF_DUTIES_VIOLATION", {
            policyId: SEPARATION_OF_DUTIES_POLICY_ID,
            message:
              constraint.message ??
              `separation of duties: subject ${subject.userId} created this resource ` +
                `(${request.resource.type}${request.resource.id !== undefined ? `:${String(request.resource.id)}` : ""}) ` +
                `and may not also perform "${request.action}" on it`,
          });
        }
      }

      if (constraint.conflictingRelations && constraint.conflictingRelations.length > 0 && relationshipProvider) {
        const resourceId = request.resource.id;
        if (resourceId !== undefined && resourceId !== null) {
          const relations = await resolveRelations(relationshipProvider, subject.userId, request.resource.type, String(resourceId));
          const conflict = relations.find((relation) => constraint.conflictingRelations!.includes(relation));
          if (conflict) {
            return deny(request, "SEPARATION_OF_DUTIES_VIOLATION", {
              policyId: SEPARATION_OF_DUTIES_POLICY_ID,
              message:
                constraint.message ??
                `separation of duties: subject ${subject.userId} holds relation "${conflict}" on ` +
                  `${request.resource.type}:${String(resourceId)} and may not also perform "${request.action}" on it`,
            });
          }
        }
      }
    }

    return null; // every matching constraint checked, no conflict found — abstain, let other rules decide
  };
}
