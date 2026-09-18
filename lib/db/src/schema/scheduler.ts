import { pgTable, text, integer, bigint, timestamp, jsonb, serial, index } from "drizzle-orm/pg-core";

/**
 * schema/scheduler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Parts B1 + B2: Scheduler core +
 * Recurring/Cron. See migrations/111_ayzen_mega_engine_scheduler_phase_b1.sql
 * and migrations/112_ayzen_mega_engine_scheduler_phase_b2.sql for the full
 * reasoning; this is the Drizzle mirror of those tables/columns. Schema
 * only — engine logic lives in artifacts/api-server/src/lib/scheduler/*,
 * same boundary schema/event-bus.ts documents for its own subsystem.
 */

export const scheduledJobTable = pgTable("scheduled_job", {
  id: text("id").primaryKey(),
  jobType: text("job_type").notNull(),
  runAt: timestamp("run_at").notNull(),
  cron: text("cron"), // §29/§32 — set together with timezone for a cron-recurring job (B2)
  timezone: text("timezone"), // IANA identifier the cron expression is evaluated in (B2)
  intervalMs: bigint("interval_ms", { mode: "number" }), // §29 "Recurring" — fixed-period alternative to cron, grid-anchored at createdAt (B2)
  misfirePolicy: text("misfire_policy").notNull().default("RUN_ONCE"), // §31 — RUN_ONCE | SKIP | CATCH_UP | RESCHEDULE, only meaningful when cron or intervalMs is set (B2)

  // SCHEDULED | PAUSED | RUNNING | RETRYING | COMPLETED | FAILED | CANCELLED | DEAD_LETTER
  // Plain TEXT, not a Postgres enum — same reasoning as event_outbox.status.
  // A recurring/cron job cycles SCHEDULED <-> RUNNING <-> RETRYING forever
  // (or until cancelJob()) and never settles into COMPLETED/DEAD_LETTER the
  // way a one-time job does — see worker.ts's dispatchRecurringJob().
  status: text("status").notNull().default("SCHEDULED"),
  pauseReason: text("pause_reason"),

  payload: jsonb("payload").$type<Record<string, unknown>>(),
  idempotencyKey: text("idempotency_key"),
  traceId: text("trace_id"),
  correlationId: text("correlation_id"),
  // Part H3 (migration 115) — the event id that caused this job to be
  // scheduled, when applicable. See that migration's own header for the
  // partial unique index (job_type, causation_id) enforced on top of
  // this column in raw SQL, not mirrored via this builder's own
  // `.where()` chain — same "no other table in this schema directory
  // uses a partial index yet, don't guess at the builder shape with no
  // tsc available" posture workflow.ts's own H1 comment already
  // documents for its sibling constraint.
  causationId: text("causation_id"),

  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lastError: text("last_error"),

  lockedUntil: timestamp("locked_until"),
  lockedBy: text("locked_by"),
  heartbeatAt: timestamp("heartbeat_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  claimIdx: index("idx_scheduled_job_claim").on(t.status, t.runAt),
  correlationIdx: index("idx_scheduled_job_correlation").on(t.correlationId),
}));

export type ScheduledJobRow = typeof scheduledJobTable.$inferSelect;
export type NewScheduledJobRow = typeof scheduledJobTable.$inferInsert;

export const scheduledJobAttemptTable = pgTable("scheduled_job_attempt", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull(), // SUCCEEDED | FAILED
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  error: text("error"),
}, (t) => ({
  jobIdx: index("idx_scheduled_job_attempt_job").on(t.jobId),
}));

export type ScheduledJobAttemptRow = typeof scheduledJobAttemptTable.$inferSelect;

export const scheduledJobDeadLetterTable = pgTable("scheduled_job_dead_letter", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  jobType: text("job_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error"),
  status: text("status").notNull().default("PENDING"), // PENDING | REPLAYED | DISCARDED
  failedAt: timestamp("failed_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (t) => ({
  typeIdx: index("idx_scheduled_job_dead_letter_type").on(t.jobType),
  statusIdx: index("idx_scheduled_job_dead_letter_status").on(t.status),
}));

export type ScheduledJobDeadLetterRow = typeof scheduledJobDeadLetterTable.$inferSelect;
