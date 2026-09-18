/**
 * lib/policy/rbac/rbac-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * `createRbacRule()` builds the first real `PolicyRule` (policy-engine.ts,
 * Phase 1A) this whole engine has ever had — every rule slot has been
 * empty since Phase 1A/1B/1C shipped the engine itself with nothing
 * registered against it. This rule answers exactly one question: "does
 * this subject hold a permission (concrete, or via a wildcard grant) that
 * covers `request.action`?" — nothing about resource ownership,
 * relationships, or attributes (Phase 03/04/05's jobs).
 *
 * ── Convention this rule assumes ────────────────────────────────────────
 * `request.action` must be a concrete "product.resource.action" string
 * (permission-matcher.ts's `isValidPermissionKey`) for this rule to have
 * an opinion at all. Phase 01 deliberately left `action` an opaque string
 * ("read", "update", ...) — callers that haven't adopted the RBAC naming
 * convention yet (there are none today; nothing calls `PolicyEngine`
 * anywhere in the app) simply get an abstention from this rule, same as
 * any other action this rule doesn't recognize.
 *
 * ── ABSTAIN, not DENY, on "no matching permission" ──────────────────────
 * Returning `null` (abstain) rather than an explicit `deny()` when no
 * grant matches is a deliberate combining-algorithm choice: Phase 1A's
 * engine already default-denies (`NO_MATCHING_POLICY`) when every
 * registered rule abstains, so an explicit DENY here would add nothing
 * for this phase — but it WOULD wrongly foreclose future phases. A later
 * ReBAC/ABAC rule (Phase 04/05) might still grant the same request via
 * resource ownership even when no role-based permission covers it (e.g. a
 * user reading their OWN vault item they have no explicit permission
 * for). If this rule returned an explicit DENY, deny-overrides combining
 * (policy-engine.ts) would make that DENY win regardless of what a later
 * rule decides — the wrong outcome for a rule whose job is only "grant
 * via role", not "the final word on every other path to ALLOW".
 *
 * ── Never trusts client input ──────────────────────────────────────────
 * Every role/permission lookup goes through `RbacProvider` (server-side
 * DB reads) — the only client-influenced input this rule reads at all is
 * `request.subject`, which is already the DB-verified `Subject` Phase 1A/
 * 1B produce from `getUserFromToken()`'s own DB lookup, never a raw
 * client-supplied role/permission list. There is no code path here that
 * lets a caller name their own roles or permissions.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { isValidPermissionKey, permissionMatches } from "./permission-matcher";
import { resolveEffectivePermissions } from "./role-resolver";
import type { RbacProvider } from "./types";
import { legacyRoleToRoleKeys } from "./legacy-role-map";

/** Stable id this rule should be registered under
 *  (`engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider))`) —
 *  exported so callers/tests/audit don't have to hardcode the string. */
export const RBAC_POLICY_ID = "rbac";

export function createRbacRule(provider: RbacProvider): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    // Defensive only — policy-engine.ts already returns UNAUTHENTICATED
    // before any rule runs when subject is null (see evaluateCore()), so
    // this branch is unreachable in practice. Kept so this rule is
    // correct even if ever called directly (e.g. from a test) outside
    // that wrapper.
    if (!subject) return null;

    if (!isValidPermissionKey(request.action)) return null; // not this rule's concern — abstain

    const startingRoleKeys = new Set<string>([
      ...legacyRoleToRoleKeys(subject.role),
      ...(await provider.getUserRoleKeys(subject.userId)),
    ]);
    if (startingRoleKeys.size === 0) return null; // no role information at all — abstain

    const permissions = await resolveEffectivePermissions(provider, [...startingRoleKeys]);

    for (const grant of permissions) {
      if (permissionMatches(grant, request.action)) {
        return allow(request, "EXPLICIT_ALLOW", {
          policyId: RBAC_POLICY_ID,
          message: `granted via permission "${grant}"`,
        });
      }
    }

    return null; // no matching grant — abstain, let other rules / default-deny decide
  };
}
