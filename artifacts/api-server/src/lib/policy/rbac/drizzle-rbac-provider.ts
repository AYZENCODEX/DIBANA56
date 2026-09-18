/**
 * lib/policy/rbac/drizzle-rbac-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * The real, `@workspace/db`-backed `RbacProvider` (see rbac/types.ts for
 * the interface every method here implements). This is the only file in
 * `lib/policy/rbac/*` that imports `@workspace/db` — everything else
 * (permission-matcher.ts, role-resolver.ts, rbac-rule.ts) is written
 * against the plain `RbacProvider` interface and stays DB-free, so it can
 * be unit-tested without a database (see
 * scripts/src/test-policy-rbac.ts) and so a future alternate provider
 * (e.g. a cached decorator, once roadmap Rule "introduce caching only
 * after correctness" is satisfied) can wrap or replace this one without
 * touching the resolver or the rule.
 *
 * Nothing in the app constructs `DrizzleRbacProvider` yet — like every
 * Phase 01 file, this is additive, unwired surface area (see the Phase 02
 * CHANGES doc's "not done" section). It cannot be executed against a real
 * database in this sandbox either (no network — see that doc's Known
 * Limitations); it is included, reviewed, and typed now so a future pass
 * only has to wire it up, not design it.
 */

import { db, rolesTable, rolePermissionsTable, userRolesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { RbacProvider, RoleRecord } from "./types";

export class DrizzleRbacProvider implements RbacProvider {
  async getUserRoleKeys(userId: number): Promise<string[]> {
    const rows = await db
      .select({ key: rolesTable.key })
      .from(userRolesTable)
      .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
      .where(eq(userRolesTable.userId, userId));
    return rows.map((r: { key: string }) => r.key);
  }

  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    const [role] = await db.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.key, roleKey));
    if (!role) return []; // unknown role — see types.ts's RbacProvider contract
    const rows = await db
      .select({ permissionKey: rolePermissionsTable.permissionKey })
      .from(rolePermissionsTable)
      .where(eq(rolePermissionsTable.roleId, role.id));
    return rows.map((r: { permissionKey: string }) => r.permissionKey);
  }

  async getRole(roleKey: string): Promise<RoleRecord | null> {
    const [role] = await db
      .select({ key: rolesTable.key, parentRoleKey: rolesTable.parentRoleKey })
      .from(rolesTable)
      .where(eq(rolesTable.key, roleKey));
    if (!role) return null;
    return { key: role.key, parentRoleKey: role.parentRoleKey };
  }
}
