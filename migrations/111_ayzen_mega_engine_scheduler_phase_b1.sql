-- 111_ayzen_mega_engine_scheduler_phase_b1.sql
-- AYZEN Mega Engine — Phase 8 blueprint, Part B1: Scheduler core
-- (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md §27-30/§33/§37/§57-B).
-- Run this once in Supabase SQL Editor. Run AFTER 110.
--
-- IDEMPOTENT — every statement is safe to re-run (IF NOT EXISTS), matching
-- every other migration in this directory.
--
-- B1 scope: one-time + delayed jobs (§29's "One-time"/"Delayed" — a fixed
-- run_at), claim/lease execution (§30), attempt-history + dead letter.
-- `cron` and `timezone` columns exist already (so B2 — Recurring/Cron,
-- §29's "Recurring"/"Cron", §31 Misfire Handling, §32 Timezone — is a
-- behavior change on this SAME table, not a second migration) but are
-- unused by B1's own job-store API, which only ever writes `run_at`.
--
-- Three tables, matching §37's "Scheduler tables" list exactly:
--
--   scheduled_job            — the job row itself (§28's ScheduledJob type
--                               + §30's lease fields).
--   scheduled_job_attempt    — one row per execution attempt, for
--                               observability (§37 lists this as its own
--                               table rather than folding it into
--                               scheduled_job's own attempts counter —
--                               the counter is the fast "how many times
--                               has this failed" check the claim/backoff
--                               path uses, this table is the "what
--                               actually happened each time" audit trail
--                               an operator reads).
--   scheduled_job_dead_letter — where a job lands after max_attempts,
--                               same posture as event_dead_letter
--                               (migration 110): full payload retained,
--                               PENDING/REPLAYED/DISCARDED lifecycle,
--                               nothing deleted on expiry (§60).
--
-- No DB-level FOREIGN KEY constraints — matches this schema directory's
-- existing posture (see schema/relationships.ts's header): a job's
-- payload can reference any resource type across any domain module.

CREATE TABLE IF NOT EXISTS scheduled_job (
  id              TEXT PRIMARY KEY,                  -- caller-generated UUID
  job_type        TEXT NOT NULL,                      -- e.g. 'notification.retry' — see job-registry.ts's registerJobHandler()
  run_at          TIMESTAMP NOT NULL,                  -- when the job is next due; B1 sets this once, B2's recurring/cron jobs re-push it forward after each COMPLETED run instead of creating a new row
  cron            TEXT,                                -- reserved for B2 — unused by B1
  timezone        TEXT,                                -- reserved for B2 — unused by B1

  -- SCHEDULED | RUNNING | RETRYING | COMPLETED | FAILED | CANCELLED | DEAD_LETTER
  -- (§28 also lists READY as a distinct status; B1 does not store it as its
  -- own row state — a SCHEDULED/RETRYING row past its run_at IS "ready" by
  -- definition, exactly how event_outbox treats PENDING+due as directly
  -- claimable rather than promoting through a separate status first. See
  -- worker.ts's claim query.)
  status          TEXT NOT NULL DEFAULT 'SCHEDULED',

  payload         JSONB,
  correlation_id  TEXT,                                -- ties a job back to the event/request that scheduled it (§35: Event Bus -> Scheduler relationship)

  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  last_error      TEXT,

  locked_until    TIMESTAMP,                           -- lease expiry (§30) — a worker holds the lease until this instant, not indefinitely
  locked_by       TEXT,
  heartbeat_at    TIMESTAMP,

  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- Worker's claim query: due, unlocked rows ordered oldest-first.
CREATE INDEX IF NOT EXISTS idx_scheduled_job_claim
  ON scheduled_job(status, run_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_correlation
  ON scheduled_job(correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduled_job_attempt (
  id              SERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL,
  status          TEXT NOT NULL,                       -- SUCCEEDED | FAILED
  started_at      TIMESTAMP NOT NULL DEFAULT now(),
  finished_at     TIMESTAMP,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_attempt_job ON scheduled_job_attempt(job_id);

CREATE TABLE IF NOT EXISTS scheduled_job_dead_letter (
  id            SERIAL PRIMARY KEY,
  job_id        TEXT NOT NULL UNIQUE,
  job_type      TEXT NOT NULL,
  payload       JSONB,
  attempts      INTEGER NOT NULL,
  last_error    TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',        -- PENDING | REPLAYED | DISCARDED
  failed_at     TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_dead_letter_type ON scheduled_job_dead_letter(job_type);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_dead_letter_status ON scheduled_job_dead_letter(status);
