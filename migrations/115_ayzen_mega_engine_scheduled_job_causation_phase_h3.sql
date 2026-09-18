-- 115_ayzen_mega_engine_scheduled_job_causation_phase_h3.sql
-- AYZEN Mega Engine — Phase 8 blueprint, Part H3: Production Hardening
-- (§65 "H: Production hardening" — continuing H1's fix for the sibling
--  gap H1's own CHANGES doc left explicitly open).
-- Run this once in Supabase SQL Editor. Run AFTER 114.
--
-- IDEMPOTENT — ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT
-- EXISTS, matching every other migration in this directory.
--
-- H1 (migration 114) closed lib/workflow/triggers.ts's in-memory
-- `startedForEvent` redelivery guard with a durable UNIQUE(definition_id,
-- causation_id) index on workflow_run, because that table already had a
-- purpose-built causation_id column (migration 113) AND definition_id
-- as a real column to distinguish one workflow from another sharing the
-- same causing event (§23's fan-out: one eventType can trigger several
-- DIFFERENT workflow definitions — triggers.ts's own header names this
-- explicitly). H1's own CHANGES doc named the identical, still-open
-- sibling gap in lib/workflow/schedule-triggers.ts's `scheduledForEvent`
-- guard (the "delayed" trigger kind, Part D2) and explained why it
-- couldn't be closed the same way: that guard's target is a
-- scheduled_job row, and scheduled_job (migrations 111/112) has no
-- causation_id column at all — only correlation_id, which is already
-- populated with the ANCHOR EVENT's own correlationId and would be the
-- WRONG key (several distinct anchor events on one causal chain can
-- share a correlationId).
--
-- This migration adds the causation_id column H1 said was missing.
--
-- What it does NOT do, and why: a plain UNIQUE(job_type, causation_id)
-- — the naive analogue of H1's workflow_run index — would be WRONG
-- here, not just imprecise. Every delayed-trigger job shares the SAME
-- job_type (WORKFLOW_DELAYED_TRIGGER_JOB_TYPE = 'workflow.trigger.delayed'
-- — schedule-triggers.ts's own registerWorkflowTriggerJobHandlers()
-- registers exactly ONE handler for it, "one handler, N payload-carried
-- targets", the file's own header explains); scheduled_job has no
-- `definition_id`/`workflow_id` COLUMN the way workflow_run does — the
-- target workflow only lives inside `payload.workflowId` (JSONB). §23's
-- same fan-out triggers.ts's header names for the immediate "event"
-- trigger kind applies identically here: two DIFFERENT delayed-trigger
-- workflow definitions can share one `relativeToEventType`, meaning ONE
-- anchor event legitimately needs to schedule TWO delayed jobs (one per
-- workflow) — both sharing `job_type` AND `causation_id`. A plain
-- UNIQUE(job_type, causation_id) would let only the first of those two
-- jobs be scheduled and silently swallow the second as a "duplicate" it
-- is not.
--
-- The correct key is therefore (causation_id, target workflow) — the
-- exact pair schedule-triggers.ts's own in-memory `scheduledForEvent`
-- guard already uses (`${eventId}:${workflowId}`). Since scheduled_job
-- has no workflow-id column, this is a Postgres EXPRESSION index over
-- `payload ->> 'workflowId'` — a deliberate, narrow exception to this
-- schema directory's usual "application-level validation over DB
-- constraints for JSONB-shaped data" posture (migration 113's own
-- header states that posture for workflow_run/workflow_definition;
-- scheduled_job.payload is the same kind of unvalidated-at-the-DB JSONB
-- blob for every OTHER job type). That general posture is unchanged for
-- every other job type; this index's own WHERE clause scopes it to
-- exactly ONE job_type — 'workflow.trigger.delayed' — so it constrains
-- nothing about any other job's payload shape, and a future job type
-- that wants the same guarantee makes its own equally-scoped index
-- rather than this one silently growing to assume every payload has a
-- `workflowId` key.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_delayed_trigger_causation_idx
  ON scheduled_job (causation_id, (payload ->> 'workflowId'))
  WHERE causation_id IS NOT NULL AND job_type = 'workflow.trigger.delayed';

COMMENT ON COLUMN scheduled_job.causation_id IS
  'Part H3 — the event id that caused this job to be scheduled, when applicable (e.g. a "delayed" workflow trigger reacting to its relativeToEventType anchor event). NULL for jobs with no single causing event (recurring/cron schedules, "schedule"-trigger jobs, scheduler-internal wakeups like workflow.resume).';

COMMENT ON INDEX scheduled_job_delayed_trigger_causation_idx IS
  'Part H3 — durable cross-restart backstop for schedule-triggers.ts''s scheduledForEvent guard, scoped to job_type = workflow.trigger.delayed only. Keyed on (causation_id, payload->>workflowId) rather than (job_type, causation_id) alone, because every delayed-trigger job shares one job_type and a single anchor event can legitimately fan out to several different target workflows (see this migration''s own header for why a plain (job_type, causation_id) index would silently drop the second workflow''s job).';
