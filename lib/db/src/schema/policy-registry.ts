import { pgTable, serial, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/policy-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * Two tables: `policies` (one immutable row per (policy_id, version) — see
 * `PolicyRecord`'s own header in
 * `artifacts/api-server/src/lib/policy/registry/types.ts` for exactly which
 * columns are and aren't mutable after insert) and
 * `policy_admin_audit_log` (append-only — one row per registry mutation,
 * written by `PolicyRegistry`, never read back by it). Schema ONLY (Drizzle
 * table defs + insert-schema validation) — every bit of actual logic
 * (lifecycle legality, authorization, maker-checker, assurance, audit
 * writing) lives in `lib/policy/registry/*`, not here. Same `lib/db`-must-
 * not-depend-on-`lib/policy` boundary `rbac.ts`/`resource-grants.ts`/
 * `relationships.ts` already establish.
 *
 * ── Why `rules` is TEXT, not JSONB ──────────────────────────────────────
 * `rules` stores the Phase 06 DSL SOURCE TEXT verbatim (e.g.
 * `subject.organizationId == resource.organizationId AND subject.assurance
 * >= L3`), never a pre-compiled `AbacCondition` tree — see
 * `registry/types.ts`'s `PolicyRecord.rules` doc: compiled once at
 * authoring time to validate it, and re-compiled again whenever something
 * actually loads an ACTIVE policy. Storing the compiled AST instead would
 * couple every row to today's exact `AbacCondition` shape, making a future
 * DSL-grammar change a data migration instead of just a code change.
 *
 * ── Why `before`/`after` on the audit table are JSONB, not typed columns ──
 * An audit row's `before`/`after` are `toAuditSnapshot(PolicyRecord)`
 * output — the full `PolicyRecord` minus `rules` (see policy-registry.ts's
 * own `toAuditSnapshot()` header for why `rules` itself is deliberately
 * excluded there: the DSL text is already durably readable off the
 * `policies` row this audit entry references, so duplicating it into every
 * audit row a policy's lifecycle passes through would bloat the log for no
 * additional information). A snapshot's exact shape is an
 * application-level concern (`registry/policy-registry.ts`), not this
 * schema's — JSONB stores it opaquely and `null` covers `createPolicy`'s
 * "no `before`" case cleanly (see `PolicyAdminAuditEntry`).
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Matches every other table in this schema directory. `createdBy` /
 * `approvedBy` / `actorId` are plain indexed integers, not `.references()`
 * — same referential-integrity posture `rbac.ts`/`resource-grants.ts`
 * already take.
 *
 * ── The partial unique index (migration 099) ──────────────────────────────
 * "At most one ACTIVE version per policyId" is `PolicyRegistry
 * .transitionStatus()`'s own application-level invariant (it auto-disables
 * any other ACTIVE version before activating a new one — see that method's
 * header) — this migration adds the same invariant as a DB-level backstop
 * (`CREATE UNIQUE INDEX ... WHERE status = 'ACTIVE'`), the same
 * belt-and-suspenders posture `role_permissions`'s own unique index takes
 * relative to its resolver's de-duplication. Drizzle's query builder has
 * no first-class partial-unique-index API, so this one index is declared
 * in the migration SQL only (see migration 099's own header) and is not
 * mirrored as a `pgTable` `uniqueIndex()` call here — every OTHER index
 * below IS declared both places, matching every prior schema file's
 * pattern.
 */

const POLICY_STATUSES = ["DRAFT", "TESTING", "APPROVED", "ACTIVE", "DISABLED", "ARCHIVED"] as const;
const POLICY_EFFECTS = ["allow", "deny"] as const;
const POLICY_RULE_KINDS = ["abac_dsl"] as const;
const POLICY_AUDIT_ACTIONS = ["policy_created", "policy_version_created", "policy_status_changed"] as const;

const POLICY_ID_RE = /^[a-z0-9_-]{1,128}$/;

// ── policies ────────────────────────────────────────────────────────────
export const policiesTable = pgTable(
  "policies",
  {
    id: serial("id").primaryKey(),
    policyId: text("policy_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    application: text("application").notNull(),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    ruleKind: text("rule_kind").notNull(),
    /** DSL source text — see file header for why TEXT, not JSONB. */
    rules: text("rules").notNull(),
    effect: text("effect").notNull(),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("DRAFT"),
    createdBy: integer("created_by").notNull(),
    approvedBy: integer("approved_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    approvedAt: timestamp("approved_at"),
  },
  (table) => [
    // Every version lookup (getPolicy, listVersions, getLatestVersionNumber)
    // filters by policyId first — see registry/types.ts's provider contract.
    index("policies_policy_id_idx").on(table.policyId),
    uniqueIndex("policies_policy_id_version_idx").on(table.policyId, table.version),
    // listActivePolicies({ application, resource }) — see
    // DrizzlePolicyRegistryProvider.listActivePolicies().
    index("policies_status_idx").on(table.status),
    index("policies_application_resource_idx").on(table.application, table.resource),
  ],
);

export const insertPolicySchema = createInsertSchema(policiesTable, {
  policyId: (schema) => schema.regex(POLICY_ID_RE, "policyId must be lowercase alphanumeric/-/_ (max 128 chars)"),
  ruleKind: (schema) => schema.refine((v) => (POLICY_RULE_KINDS as readonly string[]).includes(v), "unsupported ruleKind"),
  effect: (schema) => schema.refine((v) => (POLICY_EFFECTS as readonly string[]).includes(v), "effect must be 'allow' or 'deny'"),
  status: (schema) => schema.refine((v) => (POLICY_STATUSES as readonly string[]).includes(v), "invalid policy status"),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPolicy = z.infer<typeof insertPolicySchema>;
export type Policy = typeof policiesTable.$inferSelect;

// ── policy_admin_audit_log ────────────────────────────────────────────────
export const policyAdminAuditLogTable = pgTable(
  "policy_admin_audit_log",
  {
    id: serial("id").primaryKey(),
    /** Nullable only for parity with `PolicyAdminAuditEntry.actorId`'s own
     *  type (see registry/types.ts) — every real call site today always
     *  supplies a concrete `actor.userId`; no writer intentionally omits
     *  it. */
    actorId: integer("actor_id"),
    policyId: text("policy_id").notNull(),
    version: integer("version").notNull(),
    /** The `policies.id` row this entry describes — kept alongside
     *  `policyId`/`version` (not a substitute for them) so an audit row
     *  remains legible even if looked at without a join. */
    policyRowId: integer("policy_row_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("policy_admin_audit_log_policy_id_idx").on(table.policyId),
    index("policy_admin_audit_log_policy_row_id_idx").on(table.policyRowId),
    index("policy_admin_audit_log_actor_id_idx").on(table.actorId),
  ],
);

export const insertPolicyAdminAuditLogSchema = createInsertSchema(policyAdminAuditLogTable, {
  action: (schema) => schema.refine((v) => (POLICY_AUDIT_ACTIONS as readonly string[]).includes(v), "invalid audit action"),
}).omit({ id: true, createdAt: true });
export type InsertPolicyAdminAuditLog = z.infer<typeof insertPolicyAdminAuditLogSchema>;
export type PolicyAdminAuditLog = typeof policyAdminAuditLogTable.$inferSelect;
