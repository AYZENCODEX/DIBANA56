/**
 * lib/policy/resource/group-membership-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Route Integration Roadmap,
 * Season D, Phase D6.
 *
 * ── Why this rule exists ──────────────────────────────────────────────────
 * Season C, Phase C4's own header comment in `routes/teams.ts` named this
 * gap explicitly: that file's authorization is built almost entirely around
 * a PER-TEAM "leader" role — a row in `team_members`, looked up fresh per
 * request — not a single global `ownerId` field (`resource/ownership-
 * rule.ts`) or the subject's platform-wide `role` (`resource/role-override-
 * rule.ts`). C4 could only route the genuinely ownerId-shaped half of a few
 * compound checks through the PDP and had to leave every hand-rolled
 * `role !== "leader"` term exactly as it was, "out of scope for a
 * mechanical sweep... modeling that correctly needs a new rule type (a
 * per-resource membership/role rule) this engine doesn't have yet."
 * Season D's own triage (D1) confirmed the shape is large and repeated
 * (`teams.ts` alone: 51 of its 57 previously-untriaged routes) and sized
 * this rule as D6. This is that rule.
 *
 * ── One rule, two questions ("is a member" / "has role X") ───────────────
 * `createGroupMembershipRule()` with no `requiredRoles` answers "does the
 * subject have ANY active membership row in this group" (teams.ts's own
 * "any active member is enough" routes — team detail, stats, messages,
 * vault, missions list, ...). Passed `requiredRoles: ["leader"]`, it
 * answers the narrower "does the subject hold THIS SPECIFIC role in this
 * group" (teams.ts's leader-gated routes — invite, avatar, missions
 * create/update/delete/claim, mailbox config, ...). Both are the same
 * underlying fact (`resource.groupRole`), just compared differently — same
 * "one rule, a parameter distinguishes the two questions" shape
 * `role-override-rule.ts`'s `allowRoles` parameter already establishes for
 * the platform-role case.
 *
 * ── Caller-supplied fact, exactly like ownership-rule.ts's `ownerId` ─────
 * `resource.groupRole` (`../types.ts`) is never fetched by this module —
 * same trust boundary `ownership-rule.ts`'s header already draws around
 * `resource.ownerId` and `organization-access-rule.ts`'s around
 * `subject.organizationId`/`resource.organizationId`. This is a DELIBERATE
 * choice over a DB-backed provider (contrast `explicit-grant-rule.ts`,
 * which genuinely needs one): every one of `teams.ts`'s in-scope routes
 * either already runs the exact `SELECT role FROM team_members WHERE
 * team_id = ... AND user_id = ... [AND status = 'active']` lookup for its
 * OWN business logic (the response payload, a downstream `role === "leader"`
 * branch elsewhere in the same handler, ...) or needs to run it anyway to
 * learn the role at all — there is no "fetch it for the PDP" step this rule
 * could usefully own that the route wasn't already going to do. Folding a
 * caller's `status` filtering into whether `groupRole` is even present
 * (rather than this rule taking a separate status field and a DB read of
 * its own) means a route's resource-builder decides what "active" means
 * for ITS OWN query — same "the route/service layer already knows" posture
 * `ownership-rule.ts`'s header already establishes for `ownerId`, just
 * applied to a role lookup instead of a single owner column. A future
 * caller with no pre-existing lookup of its own (unlike every current
 * `teams.ts` call site) is free to add a small DB-backed
 * `ResourceRefBuilder` at ITS OWN call site — same division of labor
 * `pep/types.ts`'s `ResourceRefBuilder` doc comment already describes
 * ("no DB access anywhere in [the PEP] directory... the route/service
 * layer already knows which resource it's checking").
 *
 * ── ABSTAIN, not DENY, on "not a member" / "wrong role" ───────────────────
 * Same reasoning as every other Phase 03 rule in this directory
 * (ownership-rule.ts / organization-access-rule.ts / role-override-
 * rule.ts): a non-member (or a member in the wrong role) might still be
 * allowed via a DIFFERENT rule registered alongside this one (an admin
 * override, an explicit resource grant, ...) — this rule only ever ADDS a
 * grant path, it is never the final word on a non-matching request. An
 * explicit `deny()` here would wrongly foreclose those other paths via
 * deny-overrides combining (`../policy-engine.ts`). With only this one
 * rule registered (`teams.ts`'s posture — see that file's own D6 wiring
 * comment), abstain correctly falls through to `PolicyEngine`'s own
 * default-deny (`NO_MATCHING_POLICY`, Rule 7), exactly the outcome every
 * hand-rolled `if (!memberCheck.rows.length) { res.status(403)... }` /
 * `if (role !== "leader") { res.status(403)... }` check already produced.
 *
 * ── Never trusts client input directly ────────────────────────────────────
 * `request.subject.userId` is the DB-verified `Subject`, same boundary
 * every other rule in this engine already trusts. `resource.groupRole` is
 * caller-supplied (see above) — this rule does not (and cannot) verify the
 * caller actually looked up a real row rather than trusting a client-
 * supplied value verbatim; that lookup's correctness is the PEP/route
 * layer's responsibility, the same boundary every other resource-field-
 * consuming rule in this directory draws.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";

/** Stable id this rule should be registered under. */
export const GROUP_MEMBERSHIP_POLICY_ID = "group-membership";

export interface GroupMembershipRuleOptions {
  /** When supplied, `resource.groupRole` must be one of these to ALLOW —
   *  the "must hold role X in this group" question (e.g. `["leader"]`).
   *  Omit for the broader "any known membership is enough" question (the
   *  common case: read routes any active member may use). */
  requiredRoles?: readonly string[];
}

export function createGroupMembershipRule(options: GroupMembershipRuleOptions = {}): PolicyRule {
  return (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()), so
    // this branch is unreachable in practice. Kept so this rule is correct
    // even if ever called directly outside that wrapper.
    if (!subject) return null;

    const groupRole = request.resource.groupRole;
    if (groupRole === undefined || groupRole === null) return null; // no membership fact at all — abstain

    if (options.requiredRoles && !options.requiredRoles.includes(groupRole)) return null; // a member, but not in a role this action requires — abstain

    return allow(request, "EXPLICIT_ALLOW", {
      policyId: GROUP_MEMBERSHIP_POLICY_ID,
      message: options.requiredRoles
        ? `granted via group membership (role "${groupRole}" is one of: ${options.requiredRoles.join(", ")}, in ${request.resource.type} ${request.resource.id})`
        : `granted via group membership (role "${groupRole}" in ${request.resource.type} ${request.resource.id})`,
    });
  };
}
