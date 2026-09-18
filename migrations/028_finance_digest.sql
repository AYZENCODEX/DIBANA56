-- 028_finance_digest.sql
-- Adds the Finance module's own daily-digest cadence tracker (Telegram +
-- email rollup of due/overdue entries, entries recorded in the last 24h,
-- and a net worth snapshot — see lib/finance-notify.ts, lib/finance-digest-
-- cron.ts). Kept as a separate column from users.last_digest_sent_at (the
-- Vault health digest's own tracker, migrations/015_digest_frequency.sql)
-- so the two digests never share a "did we already send today" flag and
-- can run on independent schedules.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS finance_last_digest_sent_at timestamp;

-- Idempotent (also folded into the startup-migration array in index.ts so
-- fresh/imported DBs pick it up automatically on boot, same convention as
-- every other migration in this project).
