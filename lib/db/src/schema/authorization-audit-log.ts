import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * schema/authorization-audit-log.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit).
 *
 * Dedicated, append-only durable store for every PDP decision (migration
 * 103) — the roadmap's own Phase 17 field list, made concrete. This is
 * DIFFERENT from `policy_admin_audit_log` (schema/policy-registry.ts,
 * Phase 07): that table records ADMINISTRATIVE mutations to the policy
 * registry itself (who created/versioned/activated a policy); THIS table
 * records the runtime OUTCOME of asking the PDP a WHO/WHAT/WHICH
 * authorization question — every `PolicyEngine.evaluate()` call, not just
 * ones that happen to touch the registry. The two audit trails answer
 * different questions and are never merged into one table, same as
 * `vault_backup_audit_log` (Round 6) and `user_activity` (schema/
 * activity-log.ts) already coexist as two separate, independently-scoped
 * audit surfaces rather than one shared one.
 *
 * Schema ONLY (Drizzle table def + insert-schema-equivalent typing) — same
 * `lib/db`-must-not-depend-on-`lib/policy` boundary `policy-registry.ts`'s
 * own header already establishes. All actual logic (deciding WHAT to
 * write) lives in `lib/policy/audit/*`; this file only defines WHERE it
 * lands.
 *
 * ── Append-only, DB-enforced (migration 103) ──────────────────────────────
 * Same discipline `vault_backup_audit_log` (migration 073) already
 * established: a BEFORE DELETE/UPDATE trigger raises an exception, so an
 * authorization audit trail that could be quietly edited or erased by
 * application code (a bug, or a compromised account with DB write access)
 * isn't one. No UPDATE or DELETE path is ever wired up in the app to begin
 * with — the trigger makes that a DB-level guarantee, not just a
 * convention.
 *
 * ── Why subject/resource/risk/assurance are typed columns, not one JSONB
 *    blob ────────────────────────────────────────────────────────────────
 * Unlike `policy_admin_audit_log`'s `before`/`after` (opaque
 * `PolicyRecord` snapshots with no fixed query shape — see that table's
 * own header), Phase 17's field list is fixed and roadmap-specified, and
 * every field on it is something an incident-response query needs to
 * filter/aggregate by directly ("every DENY for user 42", "every HIGH_RISK
 * decision this week", "every decision against policy X version 3") —
 * columns get real indexes; a JSONB blob would not.
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Matches every other table in this schema directory (see
 * `policy-registry.ts`'s own header) — `subjectUserId` is a plain indexed
 * integer, not `.references()`.
 */
export const authorizationAuditLogTable = pgTable(
  "authorization_audit_log",
  {
    id: serial("id").primaryKey(),

    /** App-generated (node:crypto randomUUID(), see
     *  lib/policy/audit/to-audit-entry.ts) — distinct from the DB's own
     *  serial `id`, so a decision can be referenced by an identifier that
     *  exists before the row is ever inserted (useful for a caller that
     *  wants to log/correlate before the write completes). */
    decisionId: text("decision_id").notNull(),
    requestId: text("request_id").notNull(),

    // ── Subject reference (WHO) ──────────────────────────────────────────
    subjectUserId: integer("subject_user_id"),
    subjectRole: text("subject_role"),
    subjectAuthType: text("subject_auth_type"),
    subjectOrganizationId: integer("subject_organization_id"),

    // ── WHAT / WHICH ──────────────────────────────────────────────────────
    product: text("product"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    action: text("action"),

    // ── Decision ──────────────────────────────────────────────────────────
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),

    policyId: text("policy_id"),
    policyVersion: integer("policy_version"),

    // ── Risk / assurance snapshot ────────────────────────────────────────
    risk: text("risk"),
    assuranceMethods: jsonb("assurance_methods"),
    requiredAssurance: text("required_assurance"),

    // ── Timing ────────────────────────────────────────────────────────────
    timestamp: timestamp("timestamp").notNull(),
    latencyMs: integer("latency_ms"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("authorization_audit_log_request_id_idx").on(table.requestId),
    index("authorization_audit_log_subject_user_id_idx").on(table.subjectUserId, table.createdAt),
    index("authorization_audit_log_decision_idx").on(table.decision, table.createdAt),
    index("authorization_audit_log_policy_id_idx").on(table.policyId),
    index("authorization_audit_log_created_at_idx").on(table.createdAt),
  ],
);

export type AuthorizationAuditLogRow = typeof authorizationAuditLogTable.$inferSelect;
export type NewAuthorizationAuditLogRow = typeof authorizationAuditLogTable.$inferInsert;
