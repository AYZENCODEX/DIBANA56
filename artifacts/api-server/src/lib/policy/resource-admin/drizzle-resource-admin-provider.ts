/**
 * lib/policy/resource-admin/drizzle-resource-admin-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * The real, `@workspace/db`-backed `ResourceAdminProvider` (see
 * ./types.ts). This is the only file in `lib/policy/resource-admin/*`
 * that imports `@workspace/db` — everything else (errors.ts,
 * authorizer.ts, resource-admin-registry.ts) is written against the
 * plain interfaces and stays DB-free, so it can be unit-tested without a
 * database (see scripts/src/test-resource-admin-registry.ts) — same
 * split every other Drizzle provider in this codebase already follows
 * (see ../rbac-admin/drizzle-rbac-admin-provider.ts's own header,
 * ../registry/drizzle-policy-registry-provider.ts's own header).
 *
 * Reuses the SAME `resource_grants` table Phase 03 (sub-phase 3B) already
 * created (Rule 2: do not replace/duplicate existing data) — no new
 * schema for it. The only NEW table this phase adds is
 * `resourceAdminAuditLogTable` (appended to
 * lib/db/src/schema/resource-grants.ts this same phase — see that file's
 * own comment for why it lives alongside `resourceGrantsTable` rather
 * than in a new schema file).
 */

import { db, resourceGrantsTable, resourceAdminAuditLogTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { NewResourceGrantInput, ResourceAdminAuditEntry, ResourceAdminProvider, ResourceGrantAdminRecord } from "./types";

function toResourceGrantAdminRecord(row: typeof resourceGrantsTable.$inferSelect): ResourceGrantAdminRecord {
  // The DB column is a plain TEXT (see resource-grants.ts's insert-schema
  // note) — narrow it here rather than widen ResourceGrantAdminRecord's
  // type, so a malformed row (neither "allow" nor "deny", which the
  // insert schema should have prevented) fails closed instead of being
  // trusted. Same posture ../resource/drizzle-resource-grant-provider.ts's
  // own `getResourceGrant()` already takes for the PDP's read path.
  const effect = row.effect === "allow" || row.effect === "deny" ? row.effect : "deny";
  return {
    id: row.id,
    subjectUserId: row.subjectUserId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    effect,
    grantedBy: row.grantedBy,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

export class DrizzleResourceAdminProvider implements ResourceAdminProvider {
  async listResourceGrants(): Promise<ResourceGrantAdminRecord[]> {
    const rows = await db.select().from(resourceGrantsTable).orderBy(resourceGrantsTable.createdAt);
    return rows.map(toResourceGrantAdminRecord);
  }

  async listGrantsForSubject(subjectUserId: number): Promise<ResourceGrantAdminRecord[]> {
    const rows = await db.select().from(resourceGrantsTable).where(eq(resourceGrantsTable.subjectUserId, subjectUserId));
    return rows.map(toResourceGrantAdminRecord);
  }

  async listGrantsForResource(resourceType: string, resourceId: string): Promise<ResourceGrantAdminRecord[]> {
    const rows = await db
      .select()
      .from(resourceGrantsTable)
      .where(and(eq(resourceGrantsTable.resourceType, resourceType), eq(resourceGrantsTable.resourceId, resourceId)));
    return rows.map(toResourceGrantAdminRecord);
  }

  async getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantAdminRecord | null> {
    const [row] = await db
      .select()
      .from(resourceGrantsTable)
      .where(
        and(
          eq(resourceGrantsTable.subjectUserId, subjectUserId),
          eq(resourceGrantsTable.resourceType, resourceType),
          eq(resourceGrantsTable.resourceId, resourceId),
          eq(resourceGrantsTable.action, action),
        ),
      );
    return row ? toResourceGrantAdminRecord(row) : null;
  }

  async createResourceGrant(input: NewResourceGrantInput, grantedBy: number | null): Promise<ResourceGrantAdminRecord> {
    const [row] = await db
      .insert(resourceGrantsTable)
      .values({
        subjectUserId: input.subjectUserId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        action: input.action,
        effect: input.effect,
        grantedBy,
        reason: input.reason ?? null,
      })
      .returning();
    return toResourceGrantAdminRecord(row);
  }

  async deleteResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<void> {
    await db
      .delete(resourceGrantsTable)
      .where(
        and(
          eq(resourceGrantsTable.subjectUserId, subjectUserId),
          eq(resourceGrantsTable.resourceType, resourceType),
          eq(resourceGrantsTable.resourceId, resourceId),
          eq(resourceGrantsTable.action, action),
        ),
      );
  }

  // ── Audit ───────────────────────────────────────────────────────────

  /** Same "log, never silently swallow, but also never allowed to unwind
   *  an already-committed mutation write" posture
   *  `DrizzleRbacAdminProvider.recordAudit()`'s own doc comment
   *  documents — an audit-write failure here is a real operational
   *  problem (Rule 10: "sensitive authorization decisions must be
   *  auditable"), so it is re-thrown, not swallowed;
   *  `resource-admin-registry.ts`'s own callers always await
   *  `recordAudit()` immediately after the write it describes, so a
   *  thrown failure here surfaces to the same caller that just made the
   *  mutation, not to some unrelated later request. */
  async recordAudit(entry: ResourceAdminAuditEntry): Promise<void> {
    await db.insert(resourceAdminAuditLogTable).values({
      actorId: entry.actorId,
      action: entry.action,
      subjectKey: entry.subjectKey,
      before: entry.before,
      after: entry.after,
    });
  }
}
