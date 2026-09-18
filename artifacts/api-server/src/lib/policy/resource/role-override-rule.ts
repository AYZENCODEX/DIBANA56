/**
 * lib/policy/resource/role-override-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Route Integration Roadmap,
 * Season C, Phase C1 (mechanical sweep).
 *
 * `routes/support.ts`'s ticket read/reply and `routes/tasks.ts`'s
 * submission-receipt read/revoke/email each had (before this phase) the
 * exact same hand-rolled shape:
 *
 *   if (record.userId !== requester.userId && requester.role !== "admin") {
 *     res.status(403)...; return;
 *   }
 *
 * — "the owner, OR someone with an elevated role, may act". Neither
 * existing rule expresses this alone: `createResourceOwnershipRule()`
 * (./ownership-rule.ts) has no opinion about role at all, and
 * `lib/policy/pep/middleware.ts`'s own `requireRole()` rule is
 * documented to return an EXPLICIT DENY on a role mismatch (see that
 * file's header, "requireRole()" section) — registering THAT alongside
 * `createResourceOwnershipRule()` in one engine would let a non-elevated
 * OWNER's ALLOW get overridden by the role rule's own DENY (deny-overrides
 * combining, policy-engine.ts), the wrong outcome for an "OR" check.
 *
 * `createRoleOverrideRule()` is `requireRole()`'s rule with that one
 * change: it ABSTAINs (never DENIES) on a role mismatch — same "ABSTAIN,
 * not DENY" posture `./ownership-rule.ts` / `../rbac/rbac-rule.ts` /
 * `../rbac/any-permission-rule.ts` already establish for the identical
 * reason (leave room for a DIFFERENT rule, registered alongside this one,
 * to still grant the same request). Registered together in one engine —
 * `createResourceOwnershipRule()` + `createRoleOverrideRule(["admin"])` —
 * either one ALLOWing is enough (deny-overrides only short-circuits on an
 * actual DENY; two ABSTAINs fall through to default-deny, Rule 7), which
 * is exactly "owner OR admin".
 *
 * ── Why this isn't just `createRbacRule()`/`createAnyPermissionRule()` ────
 * Both of those (../rbac/*) answer a DB-backed "does this subject hold a
 * `product.resource.action` PERMISSION grant" question (role inheritance,
 * wildcards, the `permissions`/`role_permissions` tables). This rule asks
 * a cheaper, DB-free question — "is `subject.role` literally one of these
 * strings" — the same raw-role check `requireRole()`'s own rule already
 * makes, just with ABSTAIN semantics instead of DENY. Reaching for RBAC
 * permissions here would be a strictly heavier tool for a question these
 * two routes never asked in permission terms to begin with (their own
 * hand-rolled check compares `role`, not a permission key) — Rule 4 is
 * about not inventing a SECOND way to answer a question a tool already
 * answers, not about always reaching for the most general tool available.
 *
 * ── Never trusts client input ──────────────────────────────────────────
 * Reads `request.subject.role` only — the same DB-verified `Subject`
 * every other rule in this engine already trusts (see rbac-rule.ts's own
 * "Never trusts client input" section); never reads anything from
 * `request.resource` or raw `req.body`/`req.query`.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";

/** Stable id this rule should be registered under — exported so callers
 *  don't have to hardcode the string, same convention every other rule
 *  factory in this engine already establishes. */
export const ROLE_OVERRIDE_POLICY_ID = "role-override";

export function createRoleOverrideRule(allowRoles: readonly string[]): PolicyRule {
  return (request) => {
    const subject = request.subject;
    if (!subject) return null; // unreachable in practice — policy-engine.ts denies UNAUTHENTICATED first

    if (!allowRoles.includes(subject.role)) return null; // not an elevated role — abstain, let other rules decide

    return allow(request, "EXPLICIT_ALLOW", {
      policyId: ROLE_OVERRIDE_POLICY_ID,
      message: `granted via elevated role "${subject.role}"`,
    });
  };
}
