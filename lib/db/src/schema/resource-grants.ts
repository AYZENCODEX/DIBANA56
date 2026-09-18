import { pgTable, serial, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/resource-grants.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3B: data model backing `lib/policy/resource/
 * explicit-grant-rule.ts`. This file is schema ONLY (Drizzle table def +
 * insert-schema validation) — the actual rule/matching logic lives in
 * `artifacts/api-server/src/lib/policy/resource/*`, not here. Same
 * `lib/db`-must-not-depend-on-`lib/policy` boundary `rbac.ts` documents.
 *
 * ── One table for both "explicit grants" and "resource-level deny" ───────
 * The roadmap's Phase 03 list names these as two separate line items
 * ("explicit grants", "resource-level deny"), but both are really the same
 * statement shape: "for this (subject, resource, action) tuple, the answer
 * is X" — only `effect` differs ("allow" vs "deny"). Splitting that into
 * two tables (an allow-grants table and a separate deny-list table) would
 * mean two lookups per request and two places a future admin/sharing UI
 * has to write to, for no additional expressiveness — a row can only ever
 * mean one or the other for a given tuple anyway (enforced below by the
 * unique index on the full tuple, so a second row can't quietly contradict
 * the first). One table, one `effect` column, one provider method
 * (`ResourceGrantProvider.getResourceGrant`) — see explicit-grant-rule.ts's
 * header for how the rule consumes this.
 *
 * ── Why `resource_id` is TEXT, not INTEGER ────────────────────────────────
 * `ResourceRef.id` (lib/policy/types.ts) is typed `string | number` because
 * different resource types in this codebase key themselves differently
 * (numeric serial ids for most tables, but not guaranteed for every future
 * resource type this engine might ever authorize against). Storing it as
 * TEXT and having the rule `String(resource.id)` before lookup (see
 * explicit-grant-rule.ts) keeps this table resource-type-agnostic instead
 * of assuming every resource is integer-keyed forever.
 *
 * ── Why there is no `expiresAt` column yet ────────────────────────────────
 * Nothing in the roadmap's Phase 03 list asks for time-boxed grants, and no
 * caller exists yet to populate one (see file header of
 * drizzle-resource-grant-provider.ts — nothing constructs that provider
 * yet either). Adding an unused nullable column now would be speculative
 * schema per Rule 16 ("do not implement future phases prematurely"); a
 * future sharing/admin-console phase that actually needs expiring shares
 * can add it then.
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Matches every other table in this schema directory (see `rbac.ts`,
 * `api-keys.ts`, etc.) — `subjectUserId`/`grantedBy` are plain indexed
 * integers, not `.references()`. An orphaned grant (subject or granter no
 * longer exists) is an application-level concern the provider is free to
 * just return as-is (the rule doesn't care whether the subject row still
 * exists — only whether the tuple was granted), consistent with the rest
 * of this codebase's referential-integrity posture.
 */

export const resourceGrantsTable = pgTable(
  "resource_grants",
  {
    id: serial("id").primaryKey(),
    subjectUserId: integer("subject_user_id").notNull(),
    /** e.g. "sylo.vault_item", "ryft.payment" — same family as
     *  `ResourceRef.type`. */
    resourceType: text("resource_type").notNull(),
    /** Always stored as TEXT — see file header. */
    resourceId: text("resource_id").notNull(),
    /** e.g. "sylo.vault.read" — same family as `AuthorizationRequest.action`.
     *  Compared as an exact string by the rule; this table does not
     *  understand wildcards (see explicit-grant-rule.ts's header). */
    action: text("action").notNull(),
    /** "allow" | "deny" — validated at the data-entry boundary below;
     *  the provider (drizzle-resource-grant-provider.ts) treats any other
     *  value as a malformed row and fails closed (returns null) rather
     *  than trusting it. */
    effect: text("effect").notNull(),
    /** Admin/user id that created this grant — nullable because no writer
     *  exists yet (a future admin-console/sharing-feature concern, see
     *  the Phase 3B CHANGES doc's "not done" section). */
    grantedBy: integer("granted_by"),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("resource_grants_subject_idx").on(table.subjectUserId),
    index("resource_grants_resource_idx").on(table.resourceType, table.resourceId),
    uniqueIndex("resource_grants_subject_resource_action_idx").on(
      table.subjectUserId,
      table.resourceType,
      table.resourceId,
      table.action,
    ),
  ],
);

export const insertResourceGrantSchema = createInsertSchema(resourceGrantsTable, {
  effect: (schema) => schema.refine((v) => v === "allow" || v === "deny", "effect must be \"allow\" or \"deny\""),
}).omit({ id: true, createdAt: true });
export type InsertResourceGrant = z.infer<typeof insertResourceGrantSchema>;
export type ResourceGrant = typeof resourceGrantsTable.$inferSelect;

// ── resource_admin_audit_log ─────────────────────────────────────────────
// AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
// Console — Resources section).
//
// Append-only audit stream for every mutation
// `artifacts/api-server/src/lib/policy/resource-admin/*` makes to
// `resource_grants` — same `before`/`after` JSONB + nullable `actor_id`
// shape `rbacAdminAuditLogTable` (schema/rbac.ts) and
// `policyAdminAuditLogTable` (schema/policy-registry.ts) already
// establish, for the identical reasons (see those tables' own comments).
// A dedicated table rather than reusing either of those: this stream
// describes mutations to a DIFFERENT table (`resource_grants`, not
// `roles`/`role_permissions`/`user_roles` or `policies`), and an operator
// reviewing "who changed an explicit resource grant, and when" has no
// reason to want it interleaved with RBAC-admin or Policy-Registry-admin
// history — same one-stream-per-admin-surface precedent both of those
// tables' own headers already establish relative to each other.
const RESOURCE_ADMIN_AUDIT_ACTIONS = ["resource_grant_created", "resource_grant_revoked"] as const;

export const resourceAdminAuditLogTable = pgTable(
  "resource_admin_audit_log",
  {
    id: serial("id").primaryKey(),
    /** Nullable only for parity with `ResourceAdminAuditEntry.actorId`'s
     *  own type — every real call site today always supplies a concrete
     *  `actor.userId`. */
    actorId: integer("actor_id"),
    action: text("action").notNull(),
    /** `"<subjectUserId>:<resourceType>:<resourceId>:<action>"` — the
     *  full tuple `resource_grants`' own unique index keys on (see that
     *  table's header), stringified once so the whole tuple is legible in
     *  one column without a join back to a row that a revoke has already
     *  deleted. Not an FK — see resource-grants.ts's own header for why
     *  this schema takes no DB-level FK constraints anywhere. */
    subjectKey: text("subject_key").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("resource_admin_audit_log_subject_key_idx").on(table.subjectKey),
    index("resource_admin_audit_log_actor_id_idx").on(table.actorId),
    index("resource_admin_audit_log_action_idx").on(table.action),
  ],
);

export const insertResourceAdminAuditLogSchema = createInsertSchema(resourceAdminAuditLogTable, {
  action: (schema) => schema.refine((v) => (RESOURCE_ADMIN_AUDIT_ACTIONS as readonly string[]).includes(v), "invalid audit action"),
}).omit({ id: true, createdAt: true });
export type InsertResourceAdminAuditLog = z.infer<typeof insertResourceAdminAuditLogSchema>;
export type ResourceAdminAuditLog = typeof resourceAdminAuditLogTable.$inferSelect;
