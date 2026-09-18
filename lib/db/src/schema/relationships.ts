import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/relationships.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC). Data model
 * backing `lib/policy/rebac/*`. Schema ONLY (Drizzle table def + insert-schema
 * validation) — the resolver/rule logic lives in
 * `artifacts/api-server/src/lib/policy/rebac/*`, not here. Same
 * `lib/db`-must-not-depend-on-`lib/policy` boundary `rbac.ts` and
 * `resource-grants.ts` already document.
 *
 * ── One generic table for every relation kind, every relation target ─────
 * The roadmap's Phase 04 examples span three different kinds of target —
 * `user → member → organization`, `user → manager → team`,
 * `user → viewer → vault` — which is exactly the same "any resource type,
 * any resource id" shape `resource_grants` (Phase 3B) already generalizes
 * over. Rather than one table per target kind (an `organization_members`
 * table, a `team_managers` table, a `vault_viewers` table, ...), this is a
 * single `(subject, relation, resource_type, resource_id)` fact table —
 * same reasoning `resource-grants.ts`'s header gives for not splitting
 * "allow" and "deny" into two tables: one shape, one lookup, one provider
 * method, no per-target-kind schema churn every time a new relation target
 * shows up (a future product's own resource type needs zero new tables to
 * participate — it just writes rows with its own `resource_type`).
 *
 * ── Why a subject can hold MORE THAN ONE relation on the same resource ────
 * Unlike `resource_grants` (where a single `(subject, resource, action)`
 * tuple can only ever mean one `effect`), relation membership is naturally
 * multi-valued — the same person can be both a `member` of an organization
 * and its `manager`, or both an `editor` and an `approver` on the same
 * resource. So the unique constraint below covers the FULL four-column
 * tuple (including `relation`), not just `(subject, resource_type,
 * resource_id)` — a second row for a *different* relation on the same
 * resource is a normal, expected fact, not a conflict.
 *
 * ── Why `relation` is a plain TEXT column, not a Postgres ENUM ────────────
 * Matches this schema directory's existing posture (`resource_grants.effect`
 * is TEXT too, not an enum) — a Postgres native enum requires an `ALTER
 * TYPE` migration to add a value later, which is exactly the kind of
 * schema friction Rule 16 ("do not implement future phases prematurely")
 * argues against paying up front. The roadmap's seven relation kinds
 * (owner/member/manager/viewer/editor/approver/auditor) are validated at
 * the data-entry boundary below (zod refine) and, authoritatively, by
 * `lib/policy/rebac/types.ts`'s `RELATION_KINDS` at read/evaluation time
 * (see that file's header for why the check is deliberately duplicated
 * rather than shared — same `lib/db` cannot import `lib/policy` boundary
 * `rbac.ts` documents for its own grant-pattern validator).
 *
 * ── Why `resource_id` is TEXT, not INTEGER ────────────────────────────────
 * Same reasoning as `resource-grants.ts`: `ResourceRef.id` is
 * `string | number`, and a relation target is not guaranteed to be an
 * integer-keyed row for every present or future resource type this engine
 * might ever authorize against.
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Matches every other table in this schema directory — `subject_user_id`/
 * `granted_by` are plain indexed integers, not `.references()`. An
 * orphaned relationship (subject no longer exists) is an application-level
 * concern the provider is free to return as-is, consistent with `rbac.ts`
 * and `resource-grants.ts`.
 *
 * ── Why there is no `expiresAt` column yet ────────────────────────────────
 * Same reasoning `resource-grants.ts` gives for the same omission: nothing
 * in the roadmap's Phase 04 section asks for time-boxed relationships, and
 * no writer exists yet to populate one. Time-boxed grants generally are
 * Phase 11's ("Temporary / Expiring Access") job, not this phase's — adding
 * an unused nullable column now would be speculative schema (Rule 16).
 */

const RELATION_RE = /^[a-z_]{1,32}$/;

export const relationshipsTable = pgTable(
  "relationships",
  {
    id: serial("id").primaryKey(),
    subjectUserId: integer("subject_user_id").notNull(),
    /** One of `RELATION_KINDS` (lib/policy/rebac/types.ts) — validated here
     *  only as a shallow shape check (lowercase/underscore, max 32 chars);
     *  see file header for why the authoritative check lives in
     *  lib/policy instead. */
    relation: text("relation").notNull(),
    /** e.g. "ayzen.organization", "ayzen.team", "sylo.vault_item" — same
     *  family as `ResourceRef.type` / `resource_grants.resource_type`. */
    resourceType: text("resource_type").notNull(),
    /** Always stored as TEXT — see file header. */
    resourceId: text("resource_id").notNull(),
    /** Admin/user id that created this relationship — nullable because no
     *  writer exists yet (a future admin-console/org-management-feature
     *  concern, matching `resource_grants.granted_by`'s same posture). */
    grantedBy: integer("granted_by"),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("relationships_subject_idx").on(table.subjectUserId),
    index("relationships_resource_idx").on(table.resourceType, table.resourceId),
    // Composite (subject, resourceType, resourceId) is the resolver's one
    // real read pattern ("every relation this subject holds on exactly
    // this resource") — this unique index's leading three columns serve
    // that lookup directly; `relation` as the trailing column is what
    // makes the tuple unique (see file header on multi-valued relations).
    uniqueIndex("relationships_subject_resource_relation_idx").on(
      table.subjectUserId,
      table.resourceType,
      table.resourceId,
      table.relation,
    ),
  ],
);

export const insertRelationshipSchema = createInsertSchema(relationshipsTable, {
  relation: (schema) => schema.regex(RELATION_RE, "relation must be lowercase letters/underscores (max 32 chars)"),
}).omit({ id: true, createdAt: true });
export type InsertRelationship = z.infer<typeof insertRelationshipSchema>;
export type Relationship = typeof relationshipsTable.$inferSelect;
