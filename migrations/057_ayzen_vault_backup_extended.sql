-- 056_ayzen_vault_backup_extended.sql
-- Feature 15c — Automatic Schedules, Full-Table Restore, Off-Vault Delivery,
-- Integrity Verification. See lib/db/src/schema/vault-backup-schedules.ts,
-- vault-backup-deliveries.ts, and the extended vault-snapshots.ts.
--
-- Applied by hand against Supabase (same convention already used for
-- migration 055 and the mailbox migrations 036-045: not wired into
-- index.ts's boot-time MIGRATIONS array).

-- ── Extend vault_snapshots with integrity + provenance metadata ────────────
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS checksum TEXT;
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS encryption_mode TEXT NOT NULL DEFAULT 'password';
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS encryption_version INTEGER;

-- ── Automatic backup schedule (one row per user) ───────────────────────────
CREATE TABLE IF NOT EXISTS vault_backup_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  day_of_week INTEGER NOT NULL DEFAULT 0,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  hour_of_day INTEGER NOT NULL DEFAULT 3,
  include_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  destination TEXT NOT NULL DEFAULT 'store',
  destination_email TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  last_run_at TIMESTAMP,
  last_run_status TEXT,
  last_run_error TEXT,
  next_run_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Powers the cron's "which schedules are due" scan.
CREATE INDEX IF NOT EXISTS vault_backup_schedules_due_idx
  ON vault_backup_schedules (next_run_at) WHERE enabled = TRUE;

-- ── Off-vault delivery audit log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_backup_deliveries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  destination TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vault_backup_deliveries_user_created_idx
  ON vault_backup_deliveries (user_id, created_at DESC);
