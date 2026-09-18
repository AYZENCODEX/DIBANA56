-- 112_ayzen_mega_engine_scheduler_phase_b2.sql
-- AYZEN Mega Engine — Phase 8 blueprint, Part B2: Recurring/Cron Scheduler
-- (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md
--  §29 Recurring/Cron, §31 Misfire Handling, §32 Timezone, §57-B).
-- Run this once in Supabase SQL Editor. Run AFTER 111.
--
-- IDEMPOTENT — every statement is safe to re-run (ALTER ... IF NOT EXISTS),
-- matching every other migration in this directory.
--
-- B1's migration (111) already created `scheduled_job.cron` and
-- `.timezone` as reserved-but-unused placeholder columns specifically so
-- B2 would be "a behavior change on this SAME table, not a second
-- migration" for those two. That held for the columns B1 anticipated;
-- it did not anticipate `interval_ms` (§29's OTHER recurring flavor —
-- "every 30 minutes", clock-unaligned) or `misfire_policy` (§31), which
-- B1's blueprint reading didn't reserve space for. Those two are new
-- here. No new TABLE — still matches §37's three-table "Scheduler
-- tables" list exactly.
--
--   interval_ms     — §29 "Recurring": a fixed millisecond period,
--                      grid-anchored at the row's own created_at (no
--                      separate anchor column needed — job-store.ts's
--                      scheduleRecurring() relies on created_at already
--                      being there). BIGINT, not INTEGER: an INTEGER
--                      column of milliseconds overflows at ~24.8 days
--                      (2^31 ms), and "recurring" schedules with periods
--                      longer than that (weekly/monthly-ish jobs that a
--                      caller chose interval_ms over cron for) are a
--                      completely ordinary use of this column.
--   misfire_policy  — §31: RUN_ONCE | SKIP | CATCH_UP | RESCHEDULE.
--                      Defaults to RUN_ONCE (run the single most-overdue
--                      occurrence once, then resume the normal schedule)
--                      — the safest default per §31's own wording ("do
--                      not blindly execute six copies unless the job
--                      explicitly requests catch-up").
--
-- A job has EITHER cron+timezone OR interval_ms set, never both — B2's
-- job-store.ts (scheduleCron() vs scheduleRecurring()) enforces this at
-- the call site. No CHECK constraint added: matches this schema
-- directory's existing posture of application-level validation over DB
-- constraints for nullable/JSONB-adjacent shapes (see schema/relationships.ts).
--
-- Behavioral note (no schema impact, but explains why `status` never
-- settles into DEAD_LETTER/COMPLETED for these rows): unlike a one-time
-- job, a recurring/cron job's row is re-armed for its NEXT occurrence
-- after every dispatch — success, or exhausting max_attempts and being
-- written to scheduled_job_dead_letter for THAT occurrence — so a single
-- bad run can never permanently kill the schedule. See worker.ts's
-- dispatchRecurringJob() for the state machine. Only the existing (B1,
-- unchanged) cancelJob() stops a recurring job for good.

ALTER TABLE scheduled_job ADD COLUMN IF NOT EXISTS interval_ms BIGINT;
ALTER TABLE scheduled_job ADD COLUMN IF NOT EXISTS misfire_policy TEXT NOT NULL DEFAULT 'RUN_ONCE';

COMMENT ON COLUMN scheduled_job.cron IS 'IANA-style 5-field cron expression (minute hour dom month dow). Set together with timezone. §29/§32. Reserved by migration 111, activated by 112 (B2).';
COMMENT ON COLUMN scheduled_job.timezone IS 'IANA timezone identifier (e.g. Asia/Dhaka) the cron expression is evaluated in. §32 — never a hard-coded UTC offset. Reserved by migration 111, activated by 112 (B2).';
COMMENT ON COLUMN scheduled_job.interval_ms IS 'Alternative to cron: fixed millisecond interval, grid-anchored at created_at. §29 "Recurring". B2.';
COMMENT ON COLUMN scheduled_job.misfire_policy IS 'RUN_ONCE | SKIP | CATCH_UP | RESCHEDULE — §31. Only meaningful when cron or interval_ms is set. B2.';
