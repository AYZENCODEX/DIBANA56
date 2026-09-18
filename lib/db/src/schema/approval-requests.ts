import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/approval-requests.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 12 (Approval Engine).
 *
 * Two tables, same split `policy-registry.ts` (Phase 07) already
 * established: `approval_requests` (one mutable row per request — mutable,
 * unlike `policies`/`resource_grants`/`temporary_access_grants`, because a
 * request's whole POINT is to change state over its lifetime: PENDING →
 * APPROVED/REJECTED/EXPIRED/CANCELLED) and `approval_audit_log`
 * (append-only — one row per state change, written by `ApprovalEngine`,
 * never read back by it). Schema ONLY — every bit of actual logic
 * (self-decision guard, expiry, audit writing) lives in
 * `lib/policy/approval/*`, not here. Same `lib/db`-must-not-depend-on-
 * `lib/policy` boundary every other schema file in this directory
 * establishes.
 *
 * ── Why this is a MUTABLE row, unlike every other Phase 03/11 grant table ──
 * `resource_grants`/`temporary_access_grants` are written once and read
 * many times — a grant either exists or it doesn't. An approval request is
 * inherently a WORKFLOW: created PENDING, then exactly one of
 * APPROVED/REJECTED/EXPIRED/CANCELLED happens to it, once. Versioning it
 * the way `policies` are (a new immutable row per state change) would mean
 * "which row is the current one" becomes its own query — `ApprovalEngine`
 * instead updates `state`/`decidedBy`/`decidedAt`/`decisionReason` in place
 * on the one row, exactly the same "narrow, explicit set of mutable
 * columns" discipline `policies.status`/`approvedBy`/`approvedAt` already
 * uses (see `registry/types.ts`'s `PolicyRecord` header) — every OTHER
 * column here is fixed at insert time.
 *
 * ── `resource_id` is nullable ────────────────────────────────────────────
 * Not every approval-gated action targets one concrete resource (e.g. an
 * org-wide or system-wide action) — same "not every action has a
 * resource id" posture `ResourceRef.id` (lib/policy/types.ts) already
 * takes as optional.
 *
 * ── No `scope: "resource_type"` breadth like `temporary_access_grants` ────
 * Phase 11's `temporary_access_grants` deliberately supports a
 * resource-type-wide grant because short-lived BROAD access (e.g. "every
 * vault item, any org, for 2 hours") is exactly what makes a temporary
 * grant useful. An approval request is the opposite shape: ONE named
 * initiator asking for ONE specific, accountable action — broadening it to
 * "every resource of this type" would blur exactly what a human approver
 * is being asked to sign off on. `resourceType` + `resourceId` (when
 * present) + `action` is therefore always an exact-match tuple here, same
 * granularity `resource_grants` uses, never `temporary_access_grants`'
 * broader `scope` concept.
 *
 * ── `organization_id` is carried, not matched against ──────────────────────
 * Present only for audit/context (so an audit-log reader can see which org
 * an approval concerned without a join) — `approval-gate-rule.ts`
 * deliberately does not filter by it (see that file's header): unlike
 * Phase 11's org-narrowed `resource_type` grants, an approval request
 * already names one exact resource (or none), so an org filter would be
 * redundant with the resource it already names.
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Matches every other table in this schema directory.
 */

const APPROVAL_STATES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"] as const;
const APPROVAL_AUDIT_ACTIONS = ["approval_requested", "approval_decided", "approval_cancelled", "approval_expired"] as const;

// ── approval_requests ──────────────────────────────────────────────────────
export const approvalRequestsTable = pgTable(
  "approval_requests",
  {
    id: serial("id").primaryKey(),
    /** WHO is asking for the sensitive operation to proceed. May never
     *  also be the `decidedBy` on the same row — enforced at the
     *  application layer (`ApprovalEngine`'s self-decision guard), not by a
     *  DB constraint (there is no portable single-table CHECK that can
     *  compare "this column" against "a column that gets written later, in
     *  a separate UPDATE" — same reasoning
     *  `temporary_access_grants.ts`'s header gives for leaving some
     *  invariants to the application layer). */
    initiatorUserId: integer("initiator_user_id").notNull(),
    resourceType: text("resource_type").notNull(),
    /** Nullable — see file header. Always TEXT, same reasoning
     *  `resource-grants.ts`/`temporary-access-grants.ts` already give. */
    resourceId: text("resource_id"),
    action: text("action").notNull(),
    /** Carried for audit/context only — see file header. */
    organizationId: integer("organization_id"),
    /** The initiator's justification — required (roadmap's own Phase 12
     *  field list names `reason` as part of the grant's required shape,
     *  same posture Phase 11's `grantedBy` required-ness note takes). */
    reason: text("reason").notNull(),
    state: text("state").notNull().default("PENDING"),
    /** Request stops being decidable at (inclusive of) this instant — same
     *  half-open-interval semantics `temporary_access_grants.expires_at`
     *  already documents ("at expiresAt exactly" already counts as
     *  expired), applied here to a workflow's *decision window* instead of
     *  an *access window*. */
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Who actually approved/rejected — NULL while PENDING (and stays NULL
     *  forever for a row that ends EXPIRED/CANCELLED, since nobody ever
     *  decided it). */
    decidedBy: integer("decided_by"),
    decidedAt: timestamp("decided_at"),
    decisionReason: text("decision_reason"),
  },
  (table) => [
    // approval-gate-rule.ts's live-approval lookup filters by exactly
    // these four columns plus state='APPROVED' (see
    // DrizzleApprovalRequestProvider.findApprovedRequest()).
    index("approval_requests_lookup_idx").on(table.initiatorUserId, table.resourceType, table.resourceId, table.action),
    index("approval_requests_state_idx").on(table.state),
    // Supports a future cleanup/reminder job walking soon-to-expire or
    // already-expired PENDING rows — same "ready for a future job, nothing
    // in this phase queries it yet" posture
    // `temporary_access_grants_expires_idx` already takes.
    index("approval_requests_expires_idx").on(table.expiresAt),
  ],
);

export const insertApprovalRequestSchema = createInsertSchema(approvalRequestsTable, {
  state: (schema) => schema.refine((v) => (APPROVAL_STATES as readonly string[]).includes(v), "invalid approval state"),
}).omit({ id: true, createdAt: true });
export type InsertApprovalRequest = z.infer<typeof insertApprovalRequestSchema>;
export type ApprovalRequestRow = typeof approvalRequestsTable.$inferSelect;

// ── approval_audit_log ──────────────────────────────────────────────────────
export const approvalAuditLogTable = pgTable(
  "approval_audit_log",
  {
    id: serial("id").primaryKey(),
    /** Nullable only for parity with `ApprovalAuditEntry.actorId`'s own
     *  type (see `lib/policy/approval/types.ts`) — the one entry written
     *  by a system-driven lazy-expiry transition (`approval_expired`, see
     *  `ApprovalEngine`'s header) has no human actor to attribute. */
    actorId: integer("actor_id"),
    requestId: integer("request_id").notNull(),
    action: text("action").notNull(),
    /** JSONB, same reasoning `policy_admin_audit_log.before`/`after`
     *  already documents — an application-level snapshot shape, not this
     *  schema's concern. */
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("approval_audit_log_request_id_idx").on(table.requestId),
    index("approval_audit_log_actor_id_idx").on(table.actorId),
  ],
);

export const insertApprovalAuditLogSchema = createInsertSchema(approvalAuditLogTable, {
  action: (schema) => schema.refine((v) => (APPROVAL_AUDIT_ACTIONS as readonly string[]).includes(v), "invalid approval audit action"),
}).omit({ id: true, createdAt: true });
export type InsertApprovalAuditLog = z.infer<typeof insertApprovalAuditLogSchema>;
export type ApprovalAuditLogRow = typeof approvalAuditLogTable.$inferSelect;
