/**
 * lib/policy/temporary-access/temporary-access-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 11 (Temporary / Expiring
 * Access).
 *
 * `createTemporaryAccessRule()` implements the roadmap's Phase 11 section
 * verbatim: grants carrying `grantedBy`, `reason`, `startsAt`, `expiresAt`,
 * `scope`, `resource`, `action`, where "Expired grants must stop
 * authorizing automatically."
 *
 * ── Allow-only — this rule NEVER returns DENY ─────────────────────────────
 * Unlike `resource/explicit-grant-rule.ts` (which is two-sided: an
 * `effect: "deny"` row produces an explicit DENY), every row this rule
 * reads is a grant — there is no `effect` column at all (see
 * `temporary-access-grants.ts`'s schema header). An expired, not-yet-active,
 * or out-of-scope grant simply means "this particular grant has nothing to
 * say right now" — the rule ABSTAINS (returns null), exactly like
 * `ownership-rule.ts` does for a non-owner. It never manufactures a DENY
 * from the mere fact that a temporary grant lapsed; some other rule (RBAC,
 * ownership, a permanent resource grant) may still separately allow the
 * same request, and deny-overrides combining (policy-engine.ts) must not be
 * short-circuited by this rule pretending to have an opinion it doesn't.
 *
 * ── Time source: `request.context.timestamp`, never a fresh clock read ────
 * Rule 12 (deterministic evaluation) — the SAME AuthorizationRequest object
 * evaluated twice must produce the SAME decision. `context.timestamp` is
 * fixed once, at request-build time (`createPolicyContext()` /
 * `buildAuthorizationRequest()`), so this rule reads that value rather than
 * calling `new Date()` internally — matching the exact pattern
 * `abac/operators.ts`'s own header already documents for its
 * before/after time comparisons ("a before/after comparison's 'now' is
 * whatever environment.time the caller resolved it to, already fixed at
 * request-build time"). This is also what makes the rule trivially testable
 * without mocking a global clock: tests simply construct a `PolicyContext`
 * with whatever `timestamp` they want to assert a boundary at.
 *
 * ── Boundary semantics: half-open interval [startsAt, expiresAt) ──────────
 * `now < startsAt`  → not yet active, abstain.
 * `now === startsAt` → active (inclusive start).
 * `now === expiresAt` → EXPIRED (exclusive end) — "stop authorizing
 *   automatically" is read as "at expiresAt exactly, the window has already
 *   closed", not "closes the instant after expiresAt". This avoids the
 *   off-by-one ambiguity a caller could otherwise exploit by timing a
 *   request for exactly `expiresAt` and arguing it was "still within" the
 *   grant.
 * `now > expiresAt` → expired, abstain.
 *
 * ── `scope: "resource"` vs `scope: "resource_type"` ────────────────────────
 * `"resource"` rows match only when `request.resource.id` stringifies to
 * exactly the grant's `resourceId` — same exact-match posture
 * `explicit-grant-rule.ts` already documents.
 * `"resource_type"` rows match any resource of the grant's `resourceType`
 * for the grant's `action`, further narrowed by `organizationId` when the
 * grant has one set (see types.ts's header). A `"resource_type"` grant with
 * no `organizationId` matches every organization — this is a deliberately
 * broad, short-lived capability (e.g. "give this on-call engineer 2h read
 * access to every vault item, any org") and is exactly why these grants are
 * time-boxed in the first place; there is no equivalent in
 * `resource_grants` (Phase 03), which is exact-match-only.
 *
 * ── Never trusts client input ─────────────────────────────────────────────
 * `request.subject.userId` is the DB-verified `Subject`, same boundary as
 * every other rule in this engine. `request.resource.type`/`.id`/
 * `.organizationId` are caller-supplied (PEP/route-layer concern) — this
 * rule only ever compares against them, it never trusts them to already
 * encode a decision.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import type { TemporaryAccessGrant, TemporaryAccessGrantProvider } from "./types";

/** Stable id this rule should be registered under. Belongs at the
 *  EXPLICIT_GRANT precedence tier (see ../precedence-tiers.ts's own table)
 *  — same tier as ownership, the ALLOW half of resource/explicit-grant-rule,
 *  and ReBAC: a time-boxed grant is still, at its core, an explicit grant,
 *  merely one with a validity window attached. */
export const TEMPORARY_ACCESS_POLICY_ID = "temporary-access-grant";

function isGrantActiveNow(grant: TemporaryAccessGrant, now: Date): boolean {
  return now.getTime() >= grant.startsAt.getTime() && now.getTime() < grant.expiresAt.getTime();
}

function grantMatchesResource(
  grant: TemporaryAccessGrant,
  resource: { id?: string | number; organizationId?: number | null },
): boolean {
  if (grant.scope === "resource") {
    if (resource.id === undefined || resource.id === null) return false; // nothing concrete to match — no match
    return grant.resourceId != null && String(resource.id) === grant.resourceId;
  }

  // scope === "resource_type": matches every resource of this type, unless
  // the grant itself was narrowed to one organization.
  if (grant.organizationId === undefined || grant.organizationId === null) return true;
  return resource.organizationId === grant.organizationId;
}

export function createTemporaryAccessRule(provider: TemporaryAccessGrantProvider): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see rbac-rule.ts /
    // ownership-rule.ts for the same note), so this branch is unreachable
    // in practice. Kept so this rule is correct even if ever called
    // directly outside that wrapper.
    if (!subject) return null;

    const grants = await provider.getTemporaryAccessGrants(subject.userId, request.resource.type, request.action);
    if (grants.length === 0) return null; // no temporary grants on file at all — abstain

    const now = request.context.timestamp;

    for (const grant of grants) {
      if (!grantMatchesResource(grant, request.resource)) continue;
      if (!isGrantActiveNow(grant, now)) continue; // not yet active, or already expired — this grant has nothing to say

      return allow(request, "EXPLICIT_ALLOW", {
        policyId: TEMPORARY_ACCESS_POLICY_ID,
        message: grant.reason ?? `granted via temporary access (window closes ${grant.expiresAt.toISOString()})`,
      });
    }

    return null; // every candidate grant was out of scope, not yet active, or expired — abstain, never deny
  };
}
