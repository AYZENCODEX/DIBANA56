import { pgTable, text, integer, bigint, timestamp, jsonb, serial, index, unique } from "drizzle-orm/pg-core";

/**
 * schema/workflow.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core.
 * See migrations/113_ayzen_mega_engine_workflow_phase_c1.sql for the full
 * reasoning; this is the Drizzle mirror of those five tables. Schema
 * only — engine logic lives in artifacts/api-server/src/lib/workflow/*,
 * same `lib/db` must-not-depend-on-engine-logic boundary every other
 * schema file in this directory documents for its own subsystem.
 *
 * No `.references()` and no composite primary keys, matching every other
 * table in this schema directory (see relationships.ts/resource-grants.ts)
 * — a surrogate `id` plus a plain indexed/uniqued identity column, not a
 * one-off convention for just these five tables.
 */

export const workflowDefinitionTable = pgTable("workflow_definition", {
  id: serial("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  // §16 WorkflowTrigger / WorkflowStepDefinition[] — see lib/workflow/
  // types.ts. JSONB, application-validated (definition-store.ts's
  // validateDefinition()) rather than normalized out — same posture as
  // event_outbox.payload.
  trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
  steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull(),
  maxRuntimeMs: bigint("max_runtime_ms", { mode: "number" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  // ACTIVE | DEPRECATED — see migration 113's header.
  status: text("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  workflowVersionUnique: unique().on(t.workflowId, t.version),
  lookupIdx: index("idx_workflow_definition_lookup").on(t.workflowId, t.status),
}));

export type WorkflowDefinitionRow = typeof workflowDefinitionTable.$inferSelect;
export type NewWorkflowDefinitionRow = typeof workflowDefinitionTable.$inferInsert;

export const workflowRunTable = pgTable("workflow_run", {
  id: text("id").primaryKey(),
  definitionId: text("definition_id").notNull(),
  definitionVersion: integer("definition_version").notNull(),

  // PENDING | RUNNING | WAITING | COMPLETED | FAILED | CANCELLED |
  // TIMED_OUT | COMPENSATING | COMPENSATED | DEAD_LETTER — §17. Plain
  // TEXT, not a Postgres enum, same reasoning as scheduled_job.status.
  status: text("status").notNull().default("PENDING"),
  currentStepId: text("current_step_id"),

  // §19 — safe context only (userId/organizationId/resourceId/
  // correlationId/input). Never secrets — enforced by lib/workflow/
  // context.ts, not by this schema.
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  traceId: text("trace_id"),
  correlationId: text("correlation_id"),
  // Part H1 (migration 114) — a PARTIAL unique index on
  // (definition_id, causation_id) WHERE causation_id IS NOT NULL lives
  // directly in that migration's raw SQL, not mirrored via this
  // builder's own `.on()`/`.where()` chain: no other table in this
  // schema directory uses a partial index (grep confirms), and adding
  // the first one here without an existing convention to match risks
  // getting the drizzle-orm `.where()` builder shape wrong with no
  // `tsc` available in this session to catch it (this file's own
  // top-of-directory posture, shared with relationships.ts/
  // resource-grants.ts, already tolerates constraints that exist in SQL
  // without a literal Drizzle-side mirror). The constraint is enforced
  // by Postgres regardless; run-store.ts's startRun() only needs to
  // catch the resulting 23505, not read the index definition back
  // through this ORM layer.
  causationId: text("causation_id"),

  maxRuntimeMs: bigint("max_runtime_ms", { mode: "number" }),
  lastError: text("last_error"),
  cancellationReason: text("cancellation_reason"),
  cancellationActorUserId: integer("cancellation_actor_user_id"),

  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  // §24 Waiting — set while status = WAITING; NULL otherwise. Part D
  // wires the scheduler to wake a run here.
  nextResumeAt: timestamp("next_resume_at"),
  compensationState: jsonb("compensation_state").$type<Record<string, unknown>>(),
  compensationAttempts: integer("compensation_attempts").notNull().default(0),
  maxCompensationAttempts: integer("max_compensation_attempts").notNull().default(3),
  // J8 — a durable execution lease prevents duplicate workflow loops after
  // concurrent wakeups. The lease expires on worker loss and is renewed by
  // the execution loop while the owner is alive.
  executionOwner: text("execution_owner"),
  executionLeaseUntil: timestamp("execution_lease_until"),
  executionVersion: integer("execution_version").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("idx_workflow_run_status").on(t.status),
  wakeIdx: index("idx_workflow_run_wake").on(t.status, t.nextResumeAt),
  correlationIdx: index("idx_workflow_run_correlation").on(t.correlationId),
  definitionIdx: index("idx_workflow_run_definition").on(t.definitionId),
  executionLeaseIdx: index("idx_workflow_run_execution_lease").on(t.executionLeaseUntil),
}));

export type WorkflowRunRow = typeof workflowRunTable.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRunTable.$inferInsert;

export const workflowStepRunTable = pgTable("workflow_step_run", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  stepId: text("step_id").notNull(),
  attempt: integer("attempt").notNull().default(1),

  // PENDING | RUNNING | COMPLETED | FAILED | SKIPPED | COMPENSATING | COMPENSATED
  status: text("status").notNull().default("PENDING"),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  error: text("error"),

  // §26 — `${runId}:${stepId}:${attempt}` by default; see types.ts's
  // buildIdempotencyKey().
  idempotencyKey: text("idempotency_key").notNull(),

  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  runStepAttemptUnique: unique().on(t.runId, t.stepId, t.attempt),
  runIdx: index("idx_workflow_step_run_run").on(t.runId),
  idempotencyIdx: index("idx_workflow_step_run_idempotency").on(t.idempotencyKey),
}));

export type WorkflowStepRunRow = typeof workflowStepRunTable.$inferSelect;
export type NewWorkflowStepRunRow = typeof workflowStepRunTable.$inferInsert;

export const workflowCheckpointTable = pgTable("workflow_checkpoint", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  stepId: text("step_id"),
  // Engine-internal resumption state — append-only, see migration 113.
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  runIdx: index("idx_workflow_checkpoint_run").on(t.runId, t.createdAt),
}));

export type WorkflowCheckpointRow = typeof workflowCheckpointTable.$inferSelect;

export const workflowVariableTable = pgTable("workflow_variable", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  runKeyUnique: unique().on(t.runId, t.key),
  runIdx: index("idx_workflow_variable_run").on(t.runId),
}));

export type WorkflowVariableRow = typeof workflowVariableTable.$inferSelect;
