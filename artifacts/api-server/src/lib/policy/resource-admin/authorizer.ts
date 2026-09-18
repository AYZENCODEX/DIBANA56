/**
 * lib/policy/resource-admin/authorizer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * `RbacResourceAdminAuthorizer` is the real `ResourceAdminAuthorizer`
 * (../types.ts) implementation — it reuses Phase 02's own
 * `RbacProvider`/`resolveEffectivePermissions`/`permissionMatches`
 * (../rbac/*) rather than inventing a second permission-resolution path,
 * exactly mirroring ../registry/authorizer.ts's `RbacPolicyAdminAuthorizer`
 * and ../rbac-admin/authorizer.ts's `RbacRbacAdminAuthorizer` for their
 * own admin surfaces. (Name deliberately keeps the "Rbac" prefix, same
 * "RBAC-backed authorizer FOR this other admin module" convention those
 * two siblings already establish.)
 *
 * DB-free itself — written against the `RbacProvider` interface, not
 * `@workspace/db` directly, so `scripts/src/test-resource-admin-registry.ts`
 * can exercise it with the same in-memory `FakeRbacProvider` shape
 * `test-policy-rbac.ts`/`test-policy-registry.ts`/
 * `test-rbac-admin-registry.ts` already use.
 */

import { resolveEffectivePermissions, permissionMatches, legacyRoleToRoleKeys, type RbacProvider } from "../rbac";
import type { Subject } from "../types";
import type { ResourceAdminActor, ResourceAdminAuthorizer } from "./types";
import { ResourceAdminAuthorizationError } from "./errors";

/**
 * Projects a PDP `Subject` into the narrower `ResourceAdminActor` this
 * module needs — the exact same "legacy-role-map ∪ real user_roles
 * grants" union `../rbac-admin/authorizer.ts`'s `buildRbacAdminActor()`
 * and `../registry/authorizer.ts`'s `buildPolicyAdminActor()` both
 * compute (see either sibling's own header for why this is a deliberate
 * small duplication, not a shared import).
 */
export async function buildResourceAdminActor(subject: Subject, rbacProvider: RbacProvider): Promise<ResourceAdminActor> {
  const roleKeys = new Set<string>([...legacyRoleToRoleKeys(subject.role), ...(await rbacProvider.getUserRoleKeys(subject.userId))]);
  return {
    userId: subject.userId,
    roleKeys: [...roleKeys],
    assuranceMethods: subject.assuranceMethods,
  };
}

/** Seeded (as a catalog row + an explicit `admin` grant) by migration 105
 *  — see that migration's own header for why an explicit grant exists
 *  even though `admin`'s pre-existing `"*"` wildcard (migration 096)
 *  already satisfies the check on its own. One flat permission — see
 *  ../types.ts's own header for why this module, unlike RBAC-admin, does
 *  not split manage vs. a narrower second permission. */
export const RESOURCE_GRANT_MANAGE_PERMISSION = "admin.resource.manage";

export class RbacResourceAdminAuthorizer implements ResourceAdminAuthorizer {
  constructor(private readonly rbacProvider: RbacProvider) {}

  async assertCanManageResourceGrants(actor: ResourceAdminActor): Promise<void> {
    const grants = await resolveEffectivePermissions(this.rbacProvider, actor.roleKeys);
    const allowed = [...grants].some((grant) => permissionMatches(grant, RESOURCE_GRANT_MANAGE_PERMISSION));
    if (!allowed) {
      throw new ResourceAdminAuthorizationError(`User ${actor.userId} lacks permission "${RESOURCE_GRANT_MANAGE_PERMISSION}" required for this action.`);
    }
  }
}
