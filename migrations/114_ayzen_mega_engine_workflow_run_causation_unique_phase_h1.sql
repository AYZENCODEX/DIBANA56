-- 114_ayzen_mega_engine_workflow_run_causation_unique_phase_h1.sql
-- AYZEN Mega Engine — Phase 8 blueprint, Part H1: Production Hardening
-- (§65 "H: Production hardening" — a one-line label, no bullet list the
--  way §57-E has one, same gap F1's own header already flagged for
--  Phase F; this phase's scope is instead drawn from the single most
--  literal, longest-carried-forward "still open" item that names its
--  own fix in advance).
-- Run this once in Supabase SQL Editor. Run AFTER 113.
--
-- IDEMPOTENT — CREATE UNIQUE INDEX IF NOT EXISTS, matching every other
-- migration in this directory.
--
-- lib/workflow/triggers.ts's own header, unchanged since Part D1,
-- documents `startedForEvent` (a process-local, in-memory Set keyed on
-- `${eventId}:${workflowId}`) as the guard against a redelivered
-- Event-Bus envelope (§9 — at-least-once delivery) starting a second,
-- duplicate run for the same business event — and names its own fix,
-- word for word: "a durable, cross-restart version of this guard is
-- exactly what a `workflow_run` row keyed on `(definition_id,
-- causation_id)` with a unique constraint would give for free."
-- lib/workflow/schedule-triggers.ts's `scheduledForEvent` guard (Part
-- D2, the "delayed" trigger kind) carries the identical TODO in its own
-- header, pointed at this same fix — but schedules a `scheduled_job`
-- row, not a `workflow_run` row, and `scheduled_job` has no `causation_id`
-- column to key a matching constraint off (only `correlation_id`, which
-- is NOT the right key here — see this phase's own CHANGES doc for why
-- reusing it would be wrong). That half stays open; this migration only
-- closes the `workflow_run` half, which already has a real, populated,
-- purpose-built `causation_id` column since migration 113.
--
-- Why a PARTIAL unique index, not a plain UNIQUE(definition_id,
-- causation_id): most workflow_run rows have causation_id = NULL (a
-- "manual"/"api"-triggered run, or a "schedule" trigger's cron-tick,
-- has nothing upstream causing it — see schedule-triggers.ts's own
-- WorkflowTriggerJobPayload.causationId being optional). Postgres
-- already treats NULL <> NULL for uniqueness purposes, so a plain
-- UNIQUE(definition_id, causation_id) would technically permit
-- unlimited NULL rows too — but scoping the index to
-- `WHERE causation_id IS NOT NULL` says the intent explicitly (this
-- constraint exists to dedupe causation, not to touch every other run)
-- and keeps the index smaller than indexing every NULL-causation row
-- for no purpose.
--
-- This deliberately does NOT touch scheduled_job (schedule-triggers.ts's
-- own guard, the delayed-trigger half of this same problem) — see this
-- phase's CHANGES doc "Still open" section for why that half needs its
-- own schema decision (a new causation_id column) rather than reusing
-- this migration's approach by analogy.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_run_definition_causation_idx
  ON workflow_run (definition_id, causation_id)
  WHERE causation_id IS NOT NULL;

COMMENT ON INDEX workflow_run_definition_causation_idx IS
  'Part H1 — durable cross-restart backstop for triggers.ts''s startedForEvent guard: at most one workflow_run per (definition_id, causation_id) when causation_id is set, so a redelivered event (or a restarted process that lost its in-memory dedupe set) can never start a second run for the same (workflow, causing-event) pair.';
