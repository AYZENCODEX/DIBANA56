/**
 * lib/policy/rbac/any-permission-rule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Route Integration Roadmap,
 * Season B, Phase B3 (Admin consoles / dogfooding).
 *
 * `createRbacRule()` (rbac-rule.ts) answers "does the subject hold a grant
 * covering `request.action`" — one fixed action per evaluated request,
 * whatever the PEP caller passed into `requirePolicy()`/`requirePermission()`.
 * That doesn't fit every real check in this codebase: `lib/policy-admin-console.ts`'s
 * own `assertCanViewPolicies()` (and `lib/rbac-admin-console.ts`'s
 * `assertCanViewRbacAdmin()`) ask a DIFFERENT question — "does the subject
 * hold EITHER of two independent, fixed permissions" (`admin.policy.manage`
 * OR `admin.policy.approve`; `admin.role.manage` OR `admin.role.assign`) —
 * regardless of what single `action` string a particular route happens to
 * be checking. `createRbacRule()` cannot express that (it has exactly one
 * `request.action` to compare against); this rule is the documented
 * escape hatch instead (`pep/middleware.ts`'s own header: "Use
 * `requirePolicy()` directly when the built-in sugar doesn't fit...").
 *
 * Same shape as `createRbacRule()` otherwise: DB-free (written against
 * `RbacProvider`, not `@workspace/db`), reuses `resolveEffectivePermissions`/
 * `permissionMatches`/`legacyRoleToRoleKeys` rather than inventing a second
 * permission-resolution path (Rule 4), and ABSTAINs (never an explicit
 * DENY) on "none of these permissions match" — see rbac-rule.ts's own
 * "ABSTAIN, not DENY" section for why: a later-registered rule (ownership,
 * ReBAC) must still be free to grant the same request some other way.
 */

import { allow } from "../authorization-decision";
import type { PolicyRule } from "../policy-engine";
import { permissionMatches } from "./permission-matcher";
import { resolveEffectivePermissions } from "./role-resolver";
import { legacyRoleToRoleKeys } from "./legacy-role-map";
import type { RbacProvider } from "./types";

/** Stable id this rule should be registered under — exported so callers
 *  don't have to hardcode the string, same convention `RBAC_POLICY_ID`
 *  (rbac-rule.ts) already establishes. */
export const ANY_PERMISSION_POLICY_ID = "rbac-any-permission";

/**
 * `permissionKeys` — a fixed, caller-supplied allow-list (e.g.
 * `[POLICY_MANAGE_PERMISSION, POLICY_APPROVE_PERMISSION]`, imported from
 * whichever `lib/policy/*` module already names that constant — never a
 * fresh string literal, per Rule 4). ALLOW as soon as the subject's
 * effective grants (role membership ∪ legacy-role membership, walked
 * through role inheritance — identical resolution `createRbacRule()`
 * itself uses) cover any one of them.
 */
export function createAnyPermissionRule(provider: RbacProvider, permissionKeys: readonly string[]): PolicyRule {
  return async (request) => {
    const subject = request.subject;
    if (!subject) return null; // unreachable in practice — see rbac-rule.ts's own note

    const startingRoleKeys = new Set<string>([...legacyRoleToRoleKeys(subject.role), ...(await provider.getUserRoleKeys(subject.userId))]);
    if (startingRoleKeys.size === 0) return null; // no role information at all — abstain

    const grants = await resolveEffectivePermissions(provider, [...startingRoleKeys]);
    const matched = permissionKeys.find((key) => [...grants].some((grant) => permissionMatches(grant, key)));
    if (matched) {
      return allow(request, "EXPLICIT_ALLOW", {
        policyId: ANY_PERMISSION_POLICY_ID,
        message: `granted via permission "${matched}"`,
      });
    }
    return null; // none of permissionKeys matched — abstain, let other rules / default-deny decide
  };
}
