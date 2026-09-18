/**
 * lib/policy/registry/authorizer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * `RbacPolicyAdminAuthorizer` is the real `PolicyAdminAuthorizer`
 * (../registry/types.ts) implementation — it reuses Phase 02's own
 * `RbacProvider`/`resolveEffectivePermissions`/`permissionMatches`
 * (../rbac/*) rather than inventing a second permission-resolution path,
 * per Rule 4 ("Reuse existing auth, role, ... data"). This directly
 * satisfies the roadmap's Phase 07 requirement: "Only authorized
 * administrators may modify policies."
 *
 * DB-free itself — like `rbac-rule.ts`, this file is written against the
 * `RbacProvider` interface, not `@workspace/db` directly, so
 * `scripts/src/test-policy-registry.ts` can exercise it with the same
 * in-memory `FakeRbacProvider` `test-policy-rbac.ts` already defines.
 */

import { resolveEffectivePermissions, permissionMatches, legacyRoleToRoleKeys, type RbacProvider } from "../rbac";
import type { Subject } from "../types";
import type { PolicyAdminActor, PolicyAdminAuthorizer } from "./types";
import { PolicyAuthorizationError } from "./errors";

/**
 * Phase 23A (Admin Policy Console). Projects a PDP `Subject` (the shape
 * every authenticated route already has, via `subjectFromAuthUser()` —
 * ../pip/subject-adapter.ts) into the narrower `PolicyAdminActor` this
 * registry module actually needs. `roleKeys` is the exact same
 * "legacy-role-map ∪ real user_roles grants" union `rbac-rule.ts`'s
 * `createRbacRule()` already computes for the PDP's own RBAC rule — kept
 * identical deliberately (not re-derived some other way here), since an
 * actor built by this function must carry the SAME effective role
 * membership a route's own PDP-side RBAC check would see for that same
 * user; two different projections of "what roles does this user have"
 * would be a real (if subtle) authorization inconsistency between the PDP
 * and this admin console.
 *
 * `assuranceMethods` is an honest passthrough of `subject.assuranceMethods`
 * (including `undefined`, when the session carries none) — never defaulted
 * to `[]` here, since `PolicyRegistry`'s own `hasStrongAssurance()` check
 * already treats "no methods" and "empty array" identically, and silently
 * substituting one for the other would obscure which case actually
 * happened during debugging (e.g. via decision-observability tooling).
 */
export async function buildPolicyAdminActor(subject: Subject, rbacProvider: RbacProvider): Promise<PolicyAdminActor> {
  const roleKeys = new Set<string>([...legacyRoleToRoleKeys(subject.role), ...(await rbacProvider.getUserRoleKeys(subject.userId))]);
  return {
    userId: subject.userId,
    roleKeys: [...roleKeys],
    assuranceMethods: subject.assuranceMethods,
  };
}

/** Catalog entries seeded by migration 099 — see that migration's own
 *  "purely informational" note (the 'admin' role's existing '*' wildcard
 *  from migration 096 already covers both without needing a new grant
 *  row). Kept as named constants, not inline string literals, so a typo
 *  in either check fails to compile against nothing (there's no shared
 *  enum to check against) rather than silently checking the wrong string —
 *  at minimum this makes the one legitimate place either string appears
 *  easy to grep for. */
export const POLICY_MANAGE_PERMISSION = "admin.policy.manage";
export const POLICY_APPROVE_PERMISSION = "admin.policy.approve";

export class RbacPolicyAdminAuthorizer implements PolicyAdminAuthorizer {
  constructor(private readonly rbacProvider: RbacProvider) {}

  async assertCanManagePolicies(actor: PolicyAdminActor): Promise<void> {
    await this.assertHasPermission(actor, POLICY_MANAGE_PERMISSION);
  }

  async assertCanApprovePolicies(actor: PolicyAdminActor): Promise<void> {
    await this.assertHasPermission(actor, POLICY_APPROVE_PERMISSION);
  }

  private async assertHasPermission(actor: PolicyAdminActor, permissionKey: string): Promise<void> {
    const grants = await resolveEffectivePermissions(this.rbacProvider, actor.roleKeys);
    const allowed = [...grants].some((grant) => permissionMatches(grant, permissionKey));
    if (!allowed) {
      throw new PolicyAuthorizationError(`User ${actor.userId} lacks permission "${permissionKey}" required for this policy-registry action.`);
    }
  }
}
