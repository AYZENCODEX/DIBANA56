import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/rbac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02: RBAC data model.
 *
 * Four tables, exactly the ones the roadmap's Phase 02 section names:
 * `roles`, `permissions`, `role_permissions`, `user_roles`. This file is
 * schema ONLY (Drizzle table defs + insert-schema validation) — the actual
 * permission-resolution logic (wildcard matching, role-inheritance
 * traversal, the `PolicyRule` that plugs these tables into
 * `lib/policy/policy-engine.ts`) lives in
 * `artifacts/api-server/src/lib/policy/rbac/*`, not here. `lib/db` is a
 * shared package `scripts` and `api-server` both depend on — it must not
 * depend on either of them back, so no policy-engine imports in this file.
 *
 * ── How this coexists with the EXISTING single `users.role` column ────────
 * AYZEN already has a working, single-string role on every user
 * (`usersTable.role` — "user" | "dev" | "admin" today, checked directly by
 * `requireAdmin`/`requireDev`/`requireRoles` in `middlewares/auth.ts`).
 * Per roadmap Rule 4 ("Reuse existing auth, role, ... data") and Rule 18
 * ("Do not convert mock functionality into production functionality
 * without real backend support"), Phase 02 does NOT migrate that column
 * away or require backfilling a `user_roles` row for every existing user.
 * Instead:
 *   - `roles` is seeded (migration 096) with exactly three SYSTEM rows
 *     whose `key` matches the three legacy strings AYZEN already uses today
 *     — "user", "dev", "admin" — plus a `parent_role_key` chain
 *     (admin → dev → user) mirroring the `dev`-or-`admin` /
 *     `admin`-only checks `middlewares/auth.ts` already enforces.
 *   - `subject.role` (the existing, already-DB-verified string from
 *     `getUserFromToken()` — see `lib/policy/types.ts`'s `Subject`) is
 *     treated as an IMPLICIT membership in the matching system role. No
 *     `user_roles` row is required for a user's base legacy role to work.
 *   - `user_roles` is for the NEW capability this phase actually adds:
 *     granting a user one or more EXTRA/custom roles on top of their
 *     legacy role, without changing `users.role` at all. Empty today (no
 *     seed rows, no writer yet — that's a future admin-console phase), but
 *     the table and its resolution path both work end-to-end (see the
 *     Phase 02 rbac rule's own tests).
 * See `artifacts/api-server/src/lib/policy/rbac/legacy-role-map.ts` for the
 * exact mapping function this decision produces.
 *
 * ── Permission naming & wildcards ──────────────────────────────────────────
 * Roadmap-specified shape: `product.resource.action`, e.g. `sylo.vault.read`,
 * `ryft.payment.approve`, `admin.user.manage`. `role_permissions.permission_key`
 * stores a GRANT PATTERN, which is either:
 *   - a concrete 3-segment permission (`sylo.vault.read`), or
 *   - a pattern with `*` ONLY as its trailing segment (`sylo.vault.*`,
 *     `sylo.*`, or the single-segment global `*`) — "carefully constrained
 *     wildcards" per the roadmap: a wildcard can only widen from the END
 *     (broaden which resources/actions within an already-named product, or
 *     grant everything), never appear in the middle or at the start
 *     (`*.vault.read`, `sylo.*.read`) where it could silently reach across
 *     products/resources the pattern's author never named.
 * The AUTHORITATIVE validator + matcher for this shape is
 * `lib/policy/rbac/permission-matcher.ts` (`isValidGrantPattern` /
 * `permissionMatches`) — that is what the RBAC `PolicyRule` actually
 * evaluates against at request time, and it fails closed (treats a
 * malformed pattern as matching nothing) regardless of what made it into
 * the DB. The zod check below is a shallow, duplicated-on-purpose SECOND
 * line of defense at the data-entry boundary (basic character-set/shape
 * hygiene only, not full wildcard-position validation) — `lib/db` cannot
 * import from `lib/policy` (see file header above), so the two checks are
 * intentionally not shared code. Keep both in sync if the grammar ever
 * changes; a mismatch fails safe either way because the matcher, not this
 * schema, is what a real evaluation actually consults.
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Matches every other table in this schema directory (see `api-keys.ts`,
 * `emergency-access.ts`, etc.) — `userId`/`roleId` are plain indexed
 * integers, not `.references()`. Referential integrity here is an
 * application-level concern (the RBAC resolver treats an orphaned
 * `role_permissions.role_id` or `user_roles.role_id` as "that role no
 * longer exists" and skips it — see role-resolver.ts — rather than
 * crashing), consistent with the rest of this codebase.
 */

// ── Grant-pattern shallow validator (see file header) ─────────────────────
// product / resource / action segments: lowercase letters, digits, dashes,
// underscores. The trailing segment may additionally be a bare "*". This
// intentionally accepts some strings the strict matcher would still reject
// (e.g. it does not check *position* beyond "wildcard segments only at the
// end"), which is fine — it is a shape check, not the authorization-time
// authority.
const SEGMENT = "[a-z0-9_-]+";
const GRANT_PATTERN_RE = new RegExp(
  `^(\\*|${SEGMENT}(\\.(${SEGMENT}|\\*)){0,2})$`,
);

function isPlausibleGrantPatternShape(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (!GRANT_PATTERN_RE.test(value)) return false;
  // Reject a wildcard anywhere except the final segment.
  const segments = value.split(".");
  const wildcardIndex = segments.indexOf("*");
  return wildcardIndex === -1 || wildcardIndex === segments.length - 1;
}

const ROLE_KEY_RE = /^[a-z0-9_-]{1,64}$/;

// ── roles ───────────────────────────────────────────────────────────────
export const rolesTable = pgTable(
  "roles",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    /** References another row's `key` (not `id`) so seed data (migration
     *  096) can be written declaratively without a two-pass insert to
     *  discover generated ids. No DB-level FK — see file header. */
    parentRoleKey: text("parent_role_key"),
    /** System roles ("user"/"dev"/"admin" today — see file header) are
     *  seeded by a migration, not created through any future admin UI, and
     *  are not deletable/renamable there either once that UI exists
     *  (enforced by that future phase, not this table). */
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("roles_key_idx").on(table.key)],
);

export const insertRoleSchema = createInsertSchema(rolesTable, {
  key: (schema) => schema.regex(ROLE_KEY_RE, "role key must be lowercase alphanumeric/-/_ (max 64 chars)"),
  parentRoleKey: (schema) => schema.regex(ROLE_KEY_RE).nullish(),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof rolesTable.$inferSelect;

// ── permissions ────────────────────────────────────────────────────────
// Catalog/documentation of concrete permission keys AYZEN code actually
// checks for (informational — see file header: a role_permissions grant is
// allowed to reference a wildcard pattern that covers permissions not
// (yet) listed here, since the catalog cannot enumerate every future
// concrete permission a wildcard already legitimately covers).
export const permissionsTable = pgTable(
  "permissions",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull().unique(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("permissions_key_idx").on(table.key)],
);

export const insertPermissionSchema = createInsertSchema(permissionsTable, {
  key: (schema) =>
    schema.regex(
      /^[a-z0-9_-]+(\.[a-z0-9_-]+){2}$/,
      "permission key must be a concrete product.resource.action string (no wildcards in the catalog)",
    ),
}).omit({ id: true, createdAt: true });
export type InsertPermission = z.infer<typeof insertPermissionSchema>;
export type Permission = typeof permissionsTable.$inferSelect;

// ── role_permissions ──────────────────────────────────────────────────
export const rolePermissionsTable = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: integer("role_id").notNull(),
    /** A grant PATTERN (concrete or trailing-wildcard) — see file header.
     *  Deliberately a denormalized string, not an FK to `permissions.id`:
     *  a wildcard grant does not correspond to any single catalog row. */
    permissionKey: text("permission_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("role_permissions_role_id_idx").on(table.roleId),
    uniqueIndex("role_permissions_role_id_permission_key_idx").on(table.roleId, table.permissionKey),
  ],
);

export const insertRolePermissionSchema = createInsertSchema(rolePermissionsTable, {
  permissionKey: (schema) => schema.refine(isPlausibleGrantPatternShape, "permissionKey is not a plausible grant pattern"),
}).omit({ id: true, createdAt: true });
export type InsertRolePermission = z.infer<typeof insertRolePermissionSchema>;
export type RolePermission = typeof rolePermissionsTable.$inferSelect;

// ── user_roles ─────────────────────────────────────────────────────────
export const userRolesTable = pgTable(
  "user_roles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    roleId: integer("role_id").notNull(),
    /** Admin/user id that granted this — nullable because Phase 02 ships no
     *  writer yet (a future admin-console phase is the first real caller);
     *  left nullable rather than a fake system-user id. */
    grantedBy: integer("granted_by"),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("user_roles_user_id_idx").on(table.userId),
    index("user_roles_role_id_idx").on(table.roleId),
    uniqueIndex("user_roles_user_id_role_id_idx").on(table.userId, table.roleId),
  ],
);

export const insertUserRoleSchema = createInsertSchema(userRolesTable).omit({ id: true, createdAt: true });
export type InsertUserRole = z.infer<typeof insertUserRoleSchema>;
export type UserRole = typeof userRolesTable.$inferSelect;

// ── rbac_admin_audit_log ───────────────────────────────────────────────
// AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
// Console — Roles, Permissions & Assignments sections).
//
// One append-only audit stream for every RBAC-admin mutation kind (role
// create/update/delete, permission-catalog additions, role<->permission
// grants, user<->role assignments) — see
// `artifacts/api-server/src/lib/policy/rbac-admin/types.ts`'s own header
// for why one shared table (not one per mutation kind) is the right shape
// here: an operator reviewing "who changed access, and when" wants all
// four interleaved by time. Same `before`/`after` JSONB + nullable
// `actor_id` shape `policyAdminAuditLogTable` above already establishes,
// for the identical reasons (see that table's own comments).
const RBAC_ADMIN_AUDIT_ACTIONS = [
  "role_created",
  "role_updated",
  "role_deleted",
  "permission_created",
  "permission_granted",
  "permission_revoked",
  "user_role_assigned",
  "user_role_revoked",
] as const;

export const rbacAdminAuditLogTable = pgTable(
  "rbac_admin_audit_log",
  {
    id: serial("id").primaryKey(),
    /** Nullable only for parity with `RbacAdminAuditEntry.actorId`'s own
     *  type — every real call site today always supplies a concrete
     *  `actor.userId`. */
    actorId: integer("actor_id"),
    action: text("action").notNull(),
    /** Human-legible identifier for whatever this entry describes — a
     *  role key, a permission key, or a `"<userId>:<roleKey>"` pair. Not
     *  an FK to any single table (a role and a permission share this
     *  audit stream, so no one foreign key could target both) — see
     *  rbac-admin/types.ts's own `RbacAdminAuditEntry` doc comment. */
    subjectKey: text("subject_key").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("rbac_admin_audit_log_subject_key_idx").on(table.subjectKey),
    index("rbac_admin_audit_log_actor_id_idx").on(table.actorId),
    index("rbac_admin_audit_log_action_idx").on(table.action),
  ],
);

export const insertRbacAdminAuditLogSchema = createInsertSchema(rbacAdminAuditLogTable, {
  action: (schema) => schema.refine((v) => (RBAC_ADMIN_AUDIT_ACTIONS as readonly string[]).includes(v), "invalid audit action"),
}).omit({ id: true, createdAt: true });
export type InsertRbacAdminAuditLog = z.infer<typeof insertRbacAdminAuditLogSchema>;
export type RbacAdminAuditLog = typeof rbacAdminAuditLogTable.$inferSelect;
