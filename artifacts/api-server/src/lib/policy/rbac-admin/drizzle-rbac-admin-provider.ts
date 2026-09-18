/**
 * lib/policy/rbac-admin/drizzle-rbac-admin-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * The real, `@workspace/db`-backed `RbacAdminProvider` (see ./types.ts).
 * This is the only file in `lib/policy/rbac-admin/*` that imports
 * `@workspace/db` — everything else (errors.ts, authorizer.ts,
 * rbac-admin-registry.ts) is written against the plain interfaces and
 * stays DB-free, so it can be unit-tested without a database (see
 * scripts/src/test-rbac-admin-registry.ts) — same split every other
 * Drizzle provider in this codebase already follows (see
 * ../rbac/drizzle-rbac-provider.ts's own header, ../registry/
 * drizzle-policy-registry-provider.ts's own header).
 *
 * Reuses the SAME four tables Phase 02 already created
 * (`rolesTable`/`permissionsTable`/`rolePermissionsTable`/`userRolesTable`)
 * — no new schema for any of the four (Rule 2: do not replace/duplicate
 * existing data). The only NEW table this phase adds is
 * `rbacAdminAuditLogTable` (appended to lib/db/src/schema/rbac.ts this
 * same phase — see that file's own comment for why it lives alongside
 * the four RBAC tables rather than in a new schema file).
 */

import { db, rolesTable, permissionsTable, rolePermissionsTable, userRolesTable, rbacAdminAuditLogTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type {
  NewPermissionCatalogInput,
  NewRoleInput,
  PermissionCatalogRecord,
  RbacAdminAuditEntry,
  RbacAdminProvider,
  RoleAdminRecord,
  RolePermissionGrantRecord,
  RoleUpdateInput,
  UserRoleAssignmentRecord,
} from "./types";

function toRoleAdminRecord(row: typeof rolesTable.$inferSelect): RoleAdminRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    parentRoleKey: row.parentRoleKey,
    isSystem: row.isSystem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPermissionCatalogRecord(row: typeof permissionsTable.$inferSelect): PermissionCatalogRecord {
  return { id: row.id, key: row.key, description: row.description, createdAt: row.createdAt };
}

function toRolePermissionGrantRecord(row: typeof rolePermissionsTable.$inferSelect): RolePermissionGrantRecord {
  return { id: row.id, roleId: row.roleId, permissionKey: row.permissionKey, createdAt: row.createdAt };
}

export class DrizzleRbacAdminProvider implements RbacAdminProvider {
  // ── Roles ───────────────────────────────────────────────────────────

  async listRoles(): Promise<RoleAdminRecord[]> {
    const rows = await db.select().from(rolesTable).orderBy(rolesTable.key);
    return rows.map(toRoleAdminRecord);
  }

  async getRoleByKey(key: string): Promise<RoleAdminRecord | null> {
    const [row] = await db.select().from(rolesTable).where(eq(rolesTable.key, key));
    return row ? toRoleAdminRecord(row) : null;
  }

  async createRole(input: NewRoleInput): Promise<RoleAdminRecord> {
    const [row] = await db
      .insert(rolesTable)
      .values({
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        parentRoleKey: input.parentRoleKey ?? null,
        isSystem: false,
      })
      .returning();
    return toRoleAdminRecord(row);
  }

  async updateRole(key: string, patch: RoleUpdateInput): Promise<RoleAdminRecord> {
    const values: Partial<typeof rolesTable.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.parentRoleKey !== undefined) values.parentRoleKey = patch.parentRoleKey;
    const [row] = await db.update(rolesTable).set(values).where(eq(rolesTable.key, key)).returning();
    return toRoleAdminRecord(row);
  }

  async deleteRole(key: string): Promise<void> {
    const [role] = await db.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.key, key));
    if (role) {
      // Delete the role's OWN direct grants first — see
      // rbac-admin-registry.ts's `deleteRole()` doc comment for why this
      // (and only this) cascade is done here, deliberately, rather than
      // relying on a DB-level FK cascade (this schema has none — see
      // lib/db/src/schema/rbac.ts's header).
      await db.delete(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, role.id));
    }
    await db.delete(rolesTable).where(eq(rolesTable.key, key));
  }

  async hasChildRoles(key: string): Promise<boolean> {
    const [row] = await db.select({ key: rolesTable.key }).from(rolesTable).where(eq(rolesTable.parentRoleKey, key)).limit(1);
    return !!row;
  }

  async hasUserAssignments(roleId: number): Promise<boolean> {
    const [row] = await db.select({ id: userRolesTable.id }).from(userRolesTable).where(eq(userRolesTable.roleId, roleId)).limit(1);
    return !!row;
  }

  // ── Permission catalog ──────────────────────────────────────────────

  async listPermissionCatalog(): Promise<PermissionCatalogRecord[]> {
    const rows = await db.select().from(permissionsTable).orderBy(permissionsTable.key);
    return rows.map(toPermissionCatalogRecord);
  }

  async getPermissionByKey(key: string): Promise<PermissionCatalogRecord | null> {
    const [row] = await db.select().from(permissionsTable).where(eq(permissionsTable.key, key));
    return row ? toPermissionCatalogRecord(row) : null;
  }

  async createPermissionCatalogEntry(input: NewPermissionCatalogInput): Promise<PermissionCatalogRecord> {
    const [row] = await db
      .insert(permissionsTable)
      .values({ key: input.key, description: input.description ?? null })
      .returning();
    return toPermissionCatalogRecord(row);
  }

  // ── Role → permission grants ────────────────────────────────────────

  async listRolePermissionGrants(roleId: number): Promise<RolePermissionGrantRecord[]> {
    const rows = await db.select().from(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, roleId));
    return rows.map(toRolePermissionGrantRecord);
  }

  async getRolePermissionGrant(roleId: number, permissionKey: string): Promise<RolePermissionGrantRecord | null> {
    const [row] = await db
      .select()
      .from(rolePermissionsTable)
      .where(and(eq(rolePermissionsTable.roleId, roleId), eq(rolePermissionsTable.permissionKey, permissionKey)));
    return row ? toRolePermissionGrantRecord(row) : null;
  }

  async grantPermissionToRole(roleId: number, permissionKey: string): Promise<RolePermissionGrantRecord> {
    const [row] = await db.insert(rolePermissionsTable).values({ roleId, permissionKey }).returning();
    return toRolePermissionGrantRecord(row);
  }

  async revokePermissionFromRole(roleId: number, permissionKey: string): Promise<void> {
    await db
      .delete(rolePermissionsTable)
      .where(and(eq(rolePermissionsTable.roleId, roleId), eq(rolePermissionsTable.permissionKey, permissionKey)));
  }

  // ── User ↔ role assignments ──────────────────────────────────────────

  /** Joined with `roles` so every `UserRoleAssignmentRecord` already
   *  carries `roleKey` — see ./types.ts's own doc comment for why an
   *  operator should never have to separately resolve `roleId` back to a
   *  role. */
  async listUserRoleAssignments(userId: number): Promise<UserRoleAssignmentRecord[]> {
    const rows = await db
      .select({
        id: userRolesTable.id,
        userId: userRolesTable.userId,
        roleId: userRolesTable.roleId,
        roleKey: rolesTable.key,
        grantedBy: userRolesTable.grantedBy,
        reason: userRolesTable.reason,
        createdAt: userRolesTable.createdAt,
      })
      .from(userRolesTable)
      .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .where(eq(userRolesTable.userId, userId));
    return rows;
  }

  async getUserRoleAssignment(userId: number, roleId: number): Promise<UserRoleAssignmentRecord | null> {
    const [row] = await db
      .select({
        id: userRolesTable.id,
        userId: userRolesTable.userId,
        roleId: userRolesTable.roleId,
        roleKey: rolesTable.key,
        grantedBy: userRolesTable.grantedBy,
        reason: userRolesTable.reason,
        createdAt: userRolesTable.createdAt,
      })
      .from(userRolesTable)
      .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .where(and(eq(userRolesTable.userId, userId), eq(userRolesTable.roleId, roleId)));
    return row ?? null;
  }

  async assignRoleToUser(userId: number, roleId: number, grantedBy: number | null, reason: string | null): Promise<UserRoleAssignmentRecord> {
    const [inserted] = await db
      .insert(userRolesTable)
      .values({ userId, roleId, grantedBy, reason })
      .returning();
    const [role] = await db.select({ key: rolesTable.key }).from(rolesTable).where(eq(rolesTable.id, roleId));
    return {
      id: inserted.id,
      userId: inserted.userId,
      roleId: inserted.roleId,
      roleKey: role?.key ?? "",
      grantedBy: inserted.grantedBy,
      reason: inserted.reason,
      createdAt: inserted.createdAt,
    };
  }

  async revokeRoleFromUser(userId: number, roleId: number): Promise<void> {
    await db.delete(userRolesTable).where(and(eq(userRolesTable.userId, userId), eq(userRolesTable.roleId, roleId)));
  }

  // ── Audit ───────────────────────────────────────────────────────────

  /** Same "log, never silently swallow, but also never allowed to unwind
   *  an already-committed mutation write" posture
   *  `DrizzlePolicyRegistryProvider`'s own audit writer documents — an
   *  audit-write failure here is a real operational problem (Rule 10:
   *  "sensitive authorization decisions must be auditable"), so it is
   *  re-thrown, not swallowed; `rbac-admin-registry.ts`'s own callers
   *  always await `recordAudit()` immediately after the write it
   *  describes, so a thrown failure here surfaces to the same caller that
   *  just made the mutation, not to some unrelated later request. */
  async recordAudit(entry: RbacAdminAuditEntry): Promise<void> {
    await db.insert(rbacAdminAuditLogTable).values({
      actorId: entry.actorId,
      action: entry.action,
      subjectKey: entry.subjectKey,
      before: entry.before,
      after: entry.after,
    });
  }
}
