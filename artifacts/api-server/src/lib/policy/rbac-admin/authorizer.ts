/**
 * lib/policy/rbac-admin/authorizer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * `RbacRbacAdminAuthorizer` is the real `RbacAdminAuthorizer` (../types.ts)
 * implementation — it reuses Phase 02's own
 * `RbacProvider`/`resolveEffectivePermissions`/`permissionMatches`
 * (../rbac/*) rather than inventing a second permission-resolution path,
 * exactly mirroring ../registry/authorizer.ts's `RbacPolicyAdminAuthorizer`
 * for the Policies section. (Name deliberately keeps the "Rbac" prefix
 * twice — this is an RBAC-backed authorizer FOR the rbac-admin module,
 * same as "RbacPolicyAdminAuthorizer" is an RBAC-backed authorizer for the
 * registry module; there is no third, more RBAC-y RBAC to confuse it
 * with.)
 *
 * DB-free itself — written against the `RbacProvider` interface, not
 * `@workspace/db` directly, so `scripts/src/test-rbac-admin-registry.ts`
 * can exercise it with the same in-memory `FakeRbacProvider` shape
 * `test-policy-rbac.ts`/`test-policy-registry.ts` already use.
 */

import { resolveEffectivePermissions, permissionMatches, legacyRoleToRoleKeys, type RbacProvider } from "../rbac";
import type { Subject } from "../types";
import type { RbacAdminActor, RbacAdminAuthorizer } from "./types";
import { RbacAdminAuthorizationError } from "./errors";

/**
 * Projects a PDP `Subject` into the narrower `RbacAdminActor` this module
 * needs — the exact same "legacy-role-map ∪ real user_roles grants" union
 * `../registry/authorizer.ts`'s `buildPolicyAdminActor()` computes (see
 * ../types.ts's own header for why this is a deliberate small duplication,
 * not a shared import).
 */
export async function buildRbacAdminActor(subject: Subject, rbacProvider: RbacProvider): Promise<RbacAdminActor> {
  const roleKeys = new Set<string>([...legacyRoleToRoleKeys(subject.role), ...(await rbacProvider.getUserRoleKeys(subject.userId))]);
  return {
    userId: subject.userId,
    roleKeys: [...roleKeys],
    assuranceMethods: subject.assuranceMethods,
  };
}

/** Seeded (as a catalog row + an explicit `admin` grant) by migration 104
 *  — see that migration's own header for why an explicit grant exists
 *  even though `admin`'s pre-existing `"*"` wildcard (migration 096)
 *  already satisfies both checks on its own. */
export const ROLE_MANAGE_PERMISSION = "admin.role.manage";
export const ROLE_ASSIGN_PERMISSION = "admin.role.assign";

export class RbacRbacAdminAuthorizer implements RbacAdminAuthorizer {
  constructor(private readonly rbacProvider: RbacProvider) {}

  async assertCanManageRoles(actor: RbacAdminActor): Promise<void> {
    await this.assertHasPermission(actor, ROLE_MANAGE_PERMISSION);
  }

  async assertCanAssignRoles(actor: RbacAdminActor): Promise<void> {
    await this.assertHasPermission(actor, ROLE_ASSIGN_PERMISSION);
  }

  private async assertHasPermission(actor: RbacAdminActor, permissionKey: string): Promise<void> {
    const grants = await resolveEffectivePermissions(this.rbacProvider, actor.roleKeys);
    const allowed = [...grants].some((grant) => permissionMatches(grant, permissionKey));
    if (!allowed) {
      throw new RbacAdminAuthorizationError(`User ${actor.userId} lacks permission "${permissionKey}" required for this RBAC-admin action.`);
    }
  }
}
