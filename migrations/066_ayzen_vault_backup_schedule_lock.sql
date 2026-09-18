-- 066_ayzen_vault_backup_schedule_lock.sql
-- Fixes: scheduled vault backup sweep had no overlap guard.
--
-- Applied by hand against Supabase (same convention already used for
-- migrations 055-065: not wired into index.ts's boot-time MIGRATIONS array).
-- Run AFTER 065.
--
-- Bug: sweepDueSchedules() (lib/vault-backup-schedule-cron.ts) selects every
-- row where enabled AND next_run_at <= now, then runs each one. nextRunAt is
-- only advanced once the FULL run (snapshot build + encrypt + store +
-- email/webhook/Drive/Dropbox delivery) finishes. If one run takes longer
-- than the cron interval (default 15 minutes) — e.g. a large mailbox/finance
-- export, or a slow delivery target — the *next* tick's SELECT still finds
-- the same row "due" (next_run_at hasn't moved yet) and starts a second,
-- overlapping run for the same user: duplicate snapshot, duplicate
-- email/webhook/cloud delivery.
--
-- Fix: a nullable running_since timestamp acts as a lock. The sweep claims a
-- row with an atomic
--   UPDATE ... SET running_since = now() WHERE id = ? AND running_since IS NULL
-- before running it, and clears it (running_since = NULL) in the same
-- update that sets lastRunAt/lastRunStatus/nextRunAt when the run finishes
-- (success or failure). A second sweep tick that races in will fail to claim
-- the row (0 rows updated) and skip it. A stale lock left behind by a
-- crashed process is also treated as claimable again after
-- VAULT_BACKUP_SCHEDULE_STALE_LOCK_MINUTES (default 60) minutes, so a hard
-- crash mid-run can't permanently wedge a user's schedule.

ALTER TABLE vault_backup_schedules
  ADD COLUMN IF NOT EXISTS running_since TIMESTAMP;
