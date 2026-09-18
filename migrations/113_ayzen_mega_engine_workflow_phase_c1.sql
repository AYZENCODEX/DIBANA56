-- 113_ayzen_mega_engine_workflow_phase_c1.sql
-- AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core
-- (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md
--  §15-19 Workflow Engine/Definition/State Machine/Durable State/Context,
--  §26 Workflow Idempotency, §37 Database Tables).
-- Run this once in Supabase SQL Editor. Run AFTER 112.
--
-- IDEMPOTENT — every statement uses IF NOT EXISTS, matching every other
-- migration in this directory.
--
-- §37 lists five workflow tables: workflow_definition, workflow_run,
-- workflow_step_run, workflow_checkpoint, workflow_variable. All five are
-- created here as Part C1 — unlike the scheduler split (B1 shipped
-- one-time/delayed only, B2 added recurring/cron on the SAME table), the
-- workflow tables don't have an analogous "columns B1 didn't need yet"
-- seam: a run needs somewhere to record its context (workflow_run), its
-- steps (workflow_step_run), its resumption state (workflow_checkpoint)
-- and its variables (workflow_variable) from the first row ever written,
-- so there is no natural way to ship a subset of these five and grow the
-- rest in a later migration the way B2 grew scheduled_job's column set.
-- What IS deferred to Part C2 is engine logic, not schema: §20 Conditions,
-- §21 Action registry/dispatch, §22 Policy Engine integration, §24
-- Waiting/scheduler-wakeup, §25 Compensation execution. This migration
-- only lays the durable state those pieces will read and write.
--
-- No DB-level FOREIGN KEY constraints, and surrogate SERIAL primary keys
-- with a plain indexed identity column instead of a composite PK —
-- matches this schema directory's existing posture across the board
-- (see schema/relationships.ts's and schema/resource-grants.ts's own
-- headers for the same reasoning): an orphaned child row is an
-- application-level concern the provider/engine is free to surface,
-- consistent with every other table here, and a surrogate key keeps
-- every table's shape uniform (`id SERIAL PRIMARY KEY` or `id TEXT
-- PRIMARY KEY`, same as scheduler.ts/event-bus.ts) rather than
-- introducing this migration's own one-off composite-PK/FK convention.
--
-- workflow_definition — §16. Unlike event-bus's event-registry.ts (in-
-- memory, code-owned — see that file's own header for why), a workflow
-- DEFINITION is data: §16's own example literally has `version: number`
-- as a struct field, and workflows are expected to be authored/edited
-- (by an admin UI, in V1's case) rather than shipped only as code.
-- `workflow_id` + `version` together identify one definition;
-- `workflow_id` alone identifies the workflow across its version
-- history (UNIQUE(workflow_id, version) below, not a composite PK — see
-- this migration's header). `steps` and `trigger` are stored as JSONB
-- rather than normalized out — same posture as event_outbox's
-- `payload`/`metadata` (schema/relationships.ts's existing precedent):
-- application-level validation (workflow/definition-store.ts's
-- validateDefinition()) over DB constraints for this JSONB-shaped data.
--
-- workflow_run — §17/§18/§19. One row per execution of a definition.
-- `context` is JSONB holding §19's *safe* context fields only (userId,
-- organizationId, resourceId, correlationId, input) — never secrets;
-- §19's "do not persist raw passwords/tokens/keys" is enforced at the
-- application layer (workflow/context.ts), not here, same posture as
-- workflow_definition's JSONB columns above. `next_resume_at` is §24's
-- WAITING mechanism: a run parked in WAITING sets this instead of a
-- worker holding a sleep(), and Part D wires the scheduler to wake it
-- (schedule trigger §23's own listed use case) — the column exists from
-- C1 so C2/D don't need a further ALTER TABLE.
--
-- workflow_step_run — §18/§26. One row per (run, step, attempt) — the
-- three-part idempotency key §26 describes (`workflowRunId:stepId:attempt`)
-- is exactly this table's natural key, enforced below via a UNIQUE
-- constraint so a redelivered/retried dispatch can never double-insert a
-- step attempt's row (the workflow-engine analogue of
-- event_processed's (event_id, consumer) unique constraint, §38).
--
-- workflow_checkpoint — §18. Engine-internal resumption state (e.g. "which
-- step is next", loop/branch bookkeeping) — deliberately separate from
-- workflow_step_run's per-attempt execution record, because a checkpoint
-- can exist without a step currently running (a run WAITING between
-- steps still needs to know where to resume). Append-only: each new
-- checkpoint is a new row, not an UPDATE, so a crash mid-resume can
-- always fall back to the last row written rather than a half-applied
-- UPDATE.
--
-- workflow_variable — §18/§19's "step outputs" / "safe variables" that
-- flow between steps, kept separate from workflow_run.context (which is
-- the run's fixed identity/trigger data, not its mutable working state).
-- One row per (run, key) via UPDATE-in-place (unlike workflow_checkpoint),
-- since a variable's whole point is "the current value for this key",
-- not its history.

CREATE TABLE IF NOT EXISTS workflow_definition (
  id                SERIAL PRIMARY KEY,
  workflow_id       TEXT NOT NULL,
  version           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  trigger           JSONB NOT NULL,
  steps             JSONB NOT NULL,
  max_runtime_ms    BIGINT,
  metadata          JSONB,
  -- ACTIVE | DEPRECATED — §6's event-registry.ts deprecation posture,
  -- mirrored here: an old version stays queryable (existing runs still
  -- reference it) but new startRun() calls resolve to the newest ACTIVE
  -- version for a given workflow_id, not a DEPRECATED one.
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflow_definition_lookup ON workflow_definition (workflow_id, status);

CREATE TABLE IF NOT EXISTS workflow_run (
  id                    TEXT PRIMARY KEY,
  definition_id         TEXT NOT NULL,
  definition_version    INTEGER NOT NULL,
  -- §17's full lifecycle: PENDING | RUNNING | WAITING | COMPLETED | FAILED
  -- | CANCELLED | TIMED_OUT | COMPENSATING | COMPENSATED | DEAD_LETTER.
  -- Plain TEXT, not a Postgres enum — same reasoning as every other
  -- status column in this schema (see scheduler.ts / event-bus.ts).
  status                TEXT NOT NULL DEFAULT 'PENDING',
  current_step_id       TEXT,
  -- §19 safe context only — see this migration's header comment.
  context               JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id        TEXT,
  causation_id          TEXT,
  max_runtime_ms        BIGINT,
  last_error            TEXT,
  started_at            TIMESTAMP,
  completed_at          TIMESTAMP,
  -- §24 Waiting — set when status = WAITING; the scheduler wakes the run
  -- at this instant (Part D wiring). NULL whenever not WAITING.
  next_resume_at        TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_status ON workflow_run (status);
CREATE INDEX IF NOT EXISTS idx_workflow_run_wake ON workflow_run (status, next_resume_at);
CREATE INDEX IF NOT EXISTS idx_workflow_run_correlation ON workflow_run (correlation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_definition ON workflow_run (definition_id);

CREATE TABLE IF NOT EXISTS workflow_step_run (
  id                SERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL,
  step_id           TEXT NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  -- PENDING | RUNNING | COMPLETED | FAILED | SKIPPED | COMPENSATING | COMPENSATED
  status            TEXT NOT NULL DEFAULT 'PENDING',
  input             JSONB,
  output            JSONB,
  error             TEXT,
  -- §26 — `${runId}:${stepId}:${attempt}` by default (see workflow/
  -- types.ts's buildIdempotencyKey()); a step MAY supply its own instead
  -- when its action needs a coarser key than per-attempt.
  idempotency_key   TEXT NOT NULL,
  started_at        TIMESTAMP,
  finished_at       TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_workflow_step_run_run ON workflow_step_run (run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_step_run_idempotency ON workflow_step_run (idempotency_key);

CREATE TABLE IF NOT EXISTS workflow_checkpoint (
  id            SERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL,
  step_id       TEXT,
  state         JSONB NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoint_run ON workflow_checkpoint (run_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_variable (
  id            SERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (run_id, key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_variable_run ON workflow_variable (run_id);

COMMENT ON TABLE workflow_definition IS 'Part C1 — §16. workflow_id+version identifies one definition; workflow_id alone identifies the workflow across versions.';
COMMENT ON TABLE workflow_run IS 'Part C1 — §17/§18/§19. One row per execution of a definition.';
COMMENT ON TABLE workflow_step_run IS 'Part C1 — §18/§26. One row per (run, step, attempt); UNIQUE(run_id, step_id, attempt) backstops idempotent re-dispatch.';
COMMENT ON TABLE workflow_checkpoint IS 'Part C1 — §18. Append-only engine-internal resumption state.';
COMMENT ON TABLE workflow_variable IS 'Part C1 — §18/§19. Mutable per-run key/value working state (step outputs, safe variables), distinct from workflow_run.context.';
