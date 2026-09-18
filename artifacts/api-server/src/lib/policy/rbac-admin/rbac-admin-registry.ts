/**
 * lib/policy/rbac-admin/rbac-admin-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * `RbacAdminRegistry` is this phase's own PAP-equivalent for the RBAC
 * tables — the "Roles"/"Permissions"/"Assignments" counterpart to
 * `../registry/policy-registry.ts`'s `PolicyRegistry` for the "Policies"/
 * "Policy Versions" sections. It is the ONE place that:
 *   - enforces WHO may call it (an injected `RbacAdminAuthorizer`);
 *   - enforces the business rules storage alone cannot (system-role
 *     immutability, role-hierarchy-cycle prevention, in-use guards before
 *     delete, grant-pattern/permission-key shape validation, duplicate
 *     detection);
 *   - enforces assurance (Rule 13) on the one genuinely sensitive
 *     mutation this module has — assigning a role TO a user;
 *   - writes an audit entry for every mutation (Rule 10).
 *
 * Deliberately NOT part of this file/phase:
 *   - No maker-checker / approval gate on any RBAC-admin mutation. Unlike
 *     `PolicyRegistry.transitionStatus()`'s "author may not also approve"
 *     rule (a policy going ACTIVE is a fundamentally two-party decision by
 *     roadmap design), nothing in Phase 02's own spec calls for role/
 *     permission/assignment changes to require a second approver. Phase 13
 *     (Separation of Duties) is the roadmap's own named home for that kind
 *     of constraint if a future pass wants one for RBAC specifically
 *     (e.g. "grantor != grantee" for `admin.role.assign` itself) — not
 *     invented here, per Rule 16.
 *   - No cascading delete of a role's OWN `role_permissions` grants is
 *     silently skipped, but a role's IN-USE checks (child roles, user
 *     assignments) intentionally block deletion first — see
 *     `deleteRole()`'s own doc comment for exactly what does and does not
 *     get cleaned up.
 *   - Nothing here feeds a changed `role_permissions`/`user_roles` row
 *     into any request-scoped cache. No such cache exists yet anywhere in
 *     this codebase (roadmap's own "introduce caching only after
 *     correctness" rule) — when one does, its invalidation-on-role-change
 *     hook is that future phase's job, not this one's.
 */

import { isValidPermissionKey, isValidGrantPattern } from "../rbac/permission-matcher";
import type {
  NewPermissionCatalogInput,
  NewRoleInput,
  PermissionCatalogRecord,
  RbacAdminActor,
  RbacAdminAuthorizer,
  RbacAdminProvider,
  RoleAdminRecord,
  RolePermissionGrantRecord,
  RoleUpdateInput,
  UserRoleAssignmentRecord,
} from "./types";
import {
  GrantAlreadyExistsError,
  GrantNotFoundError,
  InvalidGrantPatternError,
  InvalidPermissionKeyError,
  PermissionAlreadyExistsError,
  RbacAdminInsufficientAssuranceError,
  RoleAlreadyExistsError,
  RoleHierarchyCycleError,
  RoleInUseError,
  RoleNotFoundError,
  SystemRoleImmutableError,
  UserRoleAlreadyAssignedError,
  UserRoleAssignmentNotFoundError,
} from "./errors";

/** Same assurance vocabulary/list `../registry/policy-registry.ts`'s own
 *  `hasStrongAssurance()` uses (kept as an independent copy, not a shared
 *  import, for the same "these two modules must not depend on each
 *  other" reason ../types.ts's header documents for `RbacAdminActor`
 *  itself). */
const STRONG_ASSURANCE_METHODS = new Set(["otp", "totp", "passkey", "backup_code"]);

function hasStrongAssurance(actor: RbacAdminActor): boolean {
  return (actor.assuranceMethods ?? []).some((m) => STRONG_ASSURANCE_METHODS.has(m));
}

/** Bounded ancestor walk used only to reject a `parentRoleKey` change that
 *  would make a role its own (possibly indirect) ancestor. Deliberately
 *  independent of `../rbac/role-resolver.ts`'s own bounded BFS (that
 *  function resolves PERMISSIONS across a whole `roleKeys` set at
 *  evaluation time; this one walks a single `parentRoleKey` CHAIN at
 *  admin-write time to answer a yes/no cycle question) — same `MAX_DEPTH`
 *  ceiling and same "stop rather than loop forever on malformed/hostile
 *  data" posture, applied to a different question. */
const MAX_HIERARCHY_DEPTH = 32;

export class RbacAdminRegistry {
  constructor(
    private readonly provider: RbacAdminProvider,
    private readonly authorizer: RbacAdminAuthorizer,
  ) {}

  // ── Roles ────────────────────────────────────────────────────────────

  async listRoles(): Promise<RoleAdminRecord[]> {
    return this.provider.listRoles();
  }

  async getRole(roleKey: string): Promise<RoleAdminRecord | null> {
    return this.provider.getRoleByKey(roleKey);
  }

  /** Creates a new, always non-system role. Throws `RoleAlreadyExistsError`
   *  if `input.key` is already on file, `RoleNotFoundError` if
   *  `input.parentRoleKey` is given but does not exist. */
  async createRole(actor: RbacAdminActor, input: NewRoleInput): Promise<RoleAdminRecord> {
    await this.authorizer.assertCanManageRoles(actor);

    const existing = await this.provider.getRoleByKey(input.key);
    if (existing) {
      throw new RoleAlreadyExistsError(input.key);
    }

    if (input.parentRoleKey) {
      const parent = await this.provider.getRoleByKey(input.parentRoleKey);
      if (!parent) {
        throw new RoleNotFoundError(input.parentRoleKey);
      }
    }

    const created = await this.provider.createRole(input);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "role_created",
      subjectKey: created.key,
      before: null,
      after: toRoleAuditSnapshot(created),
    });
    return created;
  }

  /** Updates `name`/`description`/`parentRoleKey` on an existing,
   *  non-system role. Throws `RoleNotFoundError` if `roleKey` (or a
   *  supplied new `parentRoleKey`) does not exist,
   *  `SystemRoleImmutableError` if `roleKey` is a system role, and
   *  `RoleHierarchyCycleError` if the new `parentRoleKey` would make
   *  `roleKey` its own ancestor. */
  async updateRole(actor: RbacAdminActor, roleKey: string, patch: RoleUpdateInput): Promise<RoleAdminRecord> {
    await this.authorizer.assertCanManageRoles(actor);

    const current = await this.provider.getRoleByKey(roleKey);
    if (!current) {
      throw new RoleNotFoundError(roleKey);
    }
    if (current.isSystem) {
      throw new SystemRoleImmutableError(roleKey, "update");
    }

    if (patch.parentRoleKey !== undefined && patch.parentRoleKey !== null) {
      const parent = await this.provider.getRoleByKey(patch.parentRoleKey);
      if (!parent) {
        throw new RoleNotFoundError(patch.parentRoleKey);
      }
      await this.assertNoHierarchyCycle(roleKey, patch.parentRoleKey);
    }

    const before = toRoleAuditSnapshot(current);
    const updated = await this.provider.updateRole(roleKey, patch);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "role_updated",
      subjectKey: roleKey,
      before,
      after: toRoleAuditSnapshot(updated),
    });
    return updated;
  }

  /** Deletes a non-system role with no remaining dependents. Throws
   *  `RoleNotFoundError`, `SystemRoleImmutableError`, or `RoleInUseError`
   *  (either because a `user_roles` row still references it, or because
   *  another role's `parentRoleKey` still points at it) — see
   *  `RoleInUseError`'s own doc comment for why both block deletion.
   *  Deleting a role also deletes its OWN `role_permissions` grant rows
   *  (there is nothing meaningful left for a dangling grant to attach to
   *  once the role itself is gone); it does NOT touch any OTHER role's
   *  grants or any audit history describing this role, which remains
   *  legible by `roleKey`/`subjectKey` even after the row is gone. */
  async deleteRole(actor: RbacAdminActor, roleKey: string): Promise<void> {
    await this.authorizer.assertCanManageRoles(actor);

    const current = await this.provider.getRoleByKey(roleKey);
    if (!current) {
      throw new RoleNotFoundError(roleKey);
    }
    if (current.isSystem) {
      throw new SystemRoleImmutableError(roleKey, "delete");
    }
    if (await this.provider.hasUserAssignments(current.id)) {
      throw new RoleInUseError(roleKey, "has_user_assignments");
    }
    if (await this.provider.hasChildRoles(roleKey)) {
      throw new RoleInUseError(roleKey, "has_child_roles");
    }

    const before = toRoleAuditSnapshot(current);
    await this.provider.deleteRole(roleKey);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "role_deleted",
      subjectKey: roleKey,
      before,
      after: null,
    });
  }

  /** Walks `candidateParentKey`'s own ancestor chain looking for
   *  `roleKey` — finding it means the proposed re-parent would create a
   *  cycle. Bounded by `MAX_HIERARCHY_DEPTH` (see that constant's own doc
   *  comment); hitting the bound without finding `roleKey` is treated as
   *  "no cycle found" (the safer of the two possible wrong answers a
   *  malformed/absurdly long existing chain could otherwise produce). */
  private async assertNoHierarchyCycle(roleKey: string, candidateParentKey: string): Promise<void> {
    let cursor: string | null = candidateParentKey;
    const visited = new Set<string>();
    for (let depth = 0; cursor && depth < MAX_HIERARCHY_DEPTH; depth++) {
      if (cursor === roleKey) {
        throw new RoleHierarchyCycleError(roleKey, candidateParentKey);
      }
      if (visited.has(cursor)) break; // pre-existing cycle elsewhere in the data — not this call's concern to fix
      visited.add(cursor);
      const role = await this.provider.getRoleByKey(cursor);
      cursor = role?.parentRoleKey ?? null;
    }
  }

  // ── Permission catalog ───────────────────────────────────────────────

  async listPermissionCatalog(): Promise<PermissionCatalogRecord[]> {
    return this.provider.listPermissionCatalog();
  }

  /** Adds a documentation-only catalog row (see ../types.ts's own header:
   *  this does not grant anything to anyone by itself). Throws
   *  `InvalidPermissionKeyError` if `input.key` is not a concrete
   *  `product.resource.action` string, `PermissionAlreadyExistsError` if
   *  it is already cataloged. */
  async createPermissionCatalogEntry(actor: RbacAdminActor, input: NewPermissionCatalogInput): Promise<PermissionCatalogRecord> {
    await this.authorizer.assertCanManageRoles(actor);

    if (!isValidPermissionKey(input.key)) {
      throw new InvalidPermissionKeyError(input.key);
    }
    const existing = await this.provider.getPermissionByKey(input.key);
    if (existing) {
      throw new PermissionAlreadyExistsError(input.key);
    }

    const created = await this.provider.createPermissionCatalogEntry(input);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "permission_created",
      subjectKey: created.key,
      before: null,
      after: { key: created.key, description: created.description },
    });
    return created;
  }

  // ── Role → permission grants ────────────────────────────────────────

  async listRolePermissionGrants(roleKey: string): Promise<RolePermissionGrantRecord[]> {
    const role = await this.provider.getRoleByKey(roleKey);
    if (!role) {
      throw new RoleNotFoundError(roleKey);
    }
    return this.provider.listRolePermissionGrants(role.id);
  }

  /** Attaches a grant PATTERN (concrete key or trailing-wildcard — see
   *  ../rbac/permission-matcher.ts's own header for the exact grammar) to
   *  `roleKey`. Throws `RoleNotFoundError`, `InvalidGrantPatternError`, or
   *  `GrantAlreadyExistsError`. Deliberately does NOT require
   *  `permissionKey` to already have a catalog entry — see
   *  lib/db/src/schema/rbac.ts's own header for why a wildcard grant
   *  legitimately covers permissions the catalog cannot enumerate. */
  async grantPermissionToRole(actor: RbacAdminActor, roleKey: string, permissionKey: string): Promise<RolePermissionGrantRecord> {
    await this.authorizer.assertCanManageRoles(actor);

    const role = await this.provider.getRoleByKey(roleKey);
    if (!role) {
      throw new RoleNotFoundError(roleKey);
    }
    if (!isValidGrantPattern(permissionKey)) {
      throw new InvalidGrantPatternError(permissionKey);
    }
    const existing = await this.provider.getRolePermissionGrant(role.id, permissionKey);
    if (existing) {
      throw new GrantAlreadyExistsError(roleKey, permissionKey);
    }

    const created = await this.provider.grantPermissionToRole(role.id, permissionKey);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "permission_granted",
      subjectKey: `${roleKey}:${permissionKey}`,
      before: null,
      after: { roleKey, permissionKey },
    });
    return created;
  }

  /** Detaches a direct grant from `roleKey`. Throws `RoleNotFoundError`
   *  or `GrantNotFoundError`. Never requires assurance — narrowing a
   *  role's own permissions is the safe direction, symmetric with
   *  `revokeRoleFromUser()`'s own reasoning below. */
  async revokePermissionFromRole(actor: RbacAdminActor, roleKey: string, permissionKey: string): Promise<void> {
    await this.authorizer.assertCanManageRoles(actor);

    const role = await this.provider.getRoleByKey(roleKey);
    if (!role) {
      throw new RoleNotFoundError(roleKey);
    }
    const existing = await this.provider.getRolePermissionGrant(role.id, permissionKey);
    if (!existing) {
      throw new GrantNotFoundError(roleKey, permissionKey);
    }

    await this.provider.revokePermissionFromRole(role.id, permissionKey);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "permission_revoked",
      subjectKey: `${roleKey}:${permissionKey}`,
      before: { roleKey, permissionKey },
      after: null,
    });
  }

  // ── User ↔ role assignments ──────────────────────────────────────────

  async listUserRoleAssignments(userId: number): Promise<UserRoleAssignmentRecord[]> {
    return this.provider.listUserRoleAssignments(userId);
  }

  /** Grants `roleKey` to `userId` — the one genuinely sensitive mutation
   *  in this module (it is how a user acquires MORE access, up to and
   *  including a role carrying the global `"*"` wildcard). Requires
   *  `admin.role.assign` AND strong assurance on `actor`'s own session
   *  (Rule 13 — same posture `PolicyRegistry.transitionStatus()` applies
   *  to activating a policy). Throws `RoleNotFoundError`,
   *  `UserRoleAlreadyAssignedError`, or `RbacAdminInsufficientAssuranceError`. */
  async assignRoleToUser(actor: RbacAdminActor, userId: number, roleKey: string, reason: string | null): Promise<UserRoleAssignmentRecord> {
    await this.authorizer.assertCanAssignRoles(actor);
    if (!hasStrongAssurance(actor)) {
      throw new RbacAdminInsufficientAssuranceError();
    }

    const role = await this.provider.getRoleByKey(roleKey);
    if (!role) {
      throw new RoleNotFoundError(roleKey);
    }
    const existing = await this.provider.getUserRoleAssignment(userId, role.id);
    if (existing) {
      throw new UserRoleAlreadyAssignedError(userId, roleKey);
    }

    const created = await this.provider.assignRoleToUser(userId, role.id, actor.userId, reason);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "user_role_assigned",
      subjectKey: `${userId}:${roleKey}`,
      before: null,
      after: { userId, roleKey, reason },
    });
    return created;
  }

  /** Revokes `roleKey` from `userId`. Requires `admin.role.assign` but
   *  deliberately NO assurance check — reducing a user's access is never
   *  the dangerous half of this capability, and requiring step-up auth to
   *  react quickly to a real incident (e.g. revoking a compromised
   *  account's admin role) would work against Rule 13's own intent, not
   *  serve it. Throws `RoleNotFoundError` or
   *  `UserRoleAssignmentNotFoundError`. */
  async revokeRoleFromUser(actor: RbacAdminActor, userId: number, roleKey: string): Promise<void> {
    await this.authorizer.assertCanAssignRoles(actor);

    const role = await this.provider.getRoleByKey(roleKey);
    if (!role) {
      throw new RoleNotFoundError(roleKey);
    }
    const existing = await this.provider.getUserRoleAssignment(userId, role.id);
    if (!existing) {
      throw new UserRoleAssignmentNotFoundError(userId, roleKey);
    }

    await this.provider.revokeRoleFromUser(userId, role.id);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "user_role_revoked",
      subjectKey: `${userId}:${roleKey}`,
      before: { userId, roleKey },
      after: null,
    });
  }
}

/** Snapshot used for both halves (`before`/`after`) of a role-mutation
 *  audit row — captured from a plain returned/read object, never mutated
 *  in place by any provider (see ../registry/policy-registry.ts's own
 *  `toAuditSnapshot()` sibling for why this matters: capturing the
 *  snapshot BEFORE a subsequent provider call, not after, is what keeps
 *  `before`/`after` from ever accidentally aliasing the same object). */
function toRoleAuditSnapshot(role: RoleAdminRecord): Record<string, unknown> {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    parentRoleKey: role.parentRoleKey,
    isSystem: role.isSystem,
  };
}
