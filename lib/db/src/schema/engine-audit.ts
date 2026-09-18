import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const engineAuditLogTable = pgTable("engine_audit_log", {
  id: uuid("id").primaryKey(),
  action: text("action").notNull(),
  actorUserId: integer("actor_user_id"),
  organizationId: integer("organization_id"),
  subjectType: text("subject_type"),
  subjectId: text("subject_id"),
  eventId: text("event_id"),
  workflowRunId: text("workflow_run_id"),
  jobId: text("job_id"),
  traceId: text("trace_id"),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  traceIdx: index("engine_audit_log_trace_idx").on(t.traceId, t.createdAt),
  subjectIdx: index("engine_audit_log_subject_idx").on(t.subjectType, t.subjectId, t.createdAt),
  actionIdx: index("engine_audit_log_action_idx").on(t.action, t.createdAt),
}));

export type EngineAuditLogRow = typeof engineAuditLogTable.$inferSelect;