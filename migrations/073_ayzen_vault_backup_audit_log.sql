-- 073_ayzen_vault_backup_audit_log.sql
-- Vault Backup hardening, Round 6 — dedicated audit trail.
-- Run this once in Supabase SQL Editor. Run AFTER 072.
--
-- Rounds 1-5 hardened the backup subsystem's crypto and access control
-- (envelope encryption, key rotation, AAD ownership binding, KEK derivation,
-- delete protection, SSRF guard) but left almost no durable record of WHO
-- touched a backup's ciphertext or its security-relevant configuration and
-- WHEN. `user_activity` (lib/activity.ts's logActivity) is a generic,
-- app-wide feed shared by every feature in this codebase — it already
-- carries a handful of backup-adjacent rows (vault_snapshot_trashed,
-- vault_backup_scheduled_run, ...), but there's no single place scoped to
-- "everything that touched vault-backup security", nothing captures the
-- request's IP/user-agent, and — the sharpest gap — plain snapshot DOWNLOAD
-- (GET /vault/snapshots/:id/download, which hands back a raw decryptable-
-- offline envelope blob; see that route's own doc comment) was never
-- logged anywhere at all.
--
-- This table is the dedicated backup-security audit trail: one row per
-- event, queryable both by the owning user (their own history) and by an
-- admin (every user's, for incident response). It supplements
-- user_activity, it doesn't replace it — existing logActivity() calls for
-- backup events are left as-is.

CREATE TABLE IF NOT EXISTS vault_backup_audit_log (
  id SERIAL PRIMARY KEY,

  -- The user this event is ABOUT — whose backup/key/config was touched.
  -- Never NULL: every event type below concerns exactly one user's backup
  -- surface, even key-rotation events (namespace-wide, so owner_user_id is
  -- NULL only for those — see the CHECK below).
  owner_user_id INTEGER,

  -- The user (or "system" for an unattended cron) who performed the action.
  -- Usually equal to owner_user_id (a user managing their own backups);
  -- differs for admin actions (key rotation, an admin viewing the feed) or
  -- automated ones (scheduled sweep, auto key rotation, DR test cron).
  actor_user_id INTEGER,
  actor_kind TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin' | 'system'

  event_type TEXT NOT NULL,
  -- e.g. snapshot_downloaded, snapshot_restored, snapshot_deleted,
  -- snapshot_purged, schedule_webhook_changed, schedule_destination_changed,
  -- cloud_connected, cloud_disconnected, key_rotated, key_rotation_stale

  snapshot_id INTEGER,      -- set for snapshot-scoped events, else NULL
  key_version INTEGER,      -- set for key-rotation events, else NULL

  ip TEXT,
  user_agent TEXT,
  detail JSONB,             -- small, non-sensitive structured context only —
                             -- never ciphertext, keys, passwords, or tokens

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT vault_backup_audit_log_owner_or_namespace_ck
    CHECK (owner_user_id IS NOT NULL OR event_type IN ('key_rotated', 'key_rotation_stale'))
);

CREATE INDEX IF NOT EXISTS vault_backup_audit_log_owner_idx ON vault_backup_audit_log(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_backup_audit_log_event_idx ON vault_backup_audit_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_backup_audit_log_created_idx ON vault_backup_audit_log(created_at DESC);

-- Same discipline as migration 067 (encryption_keys): an audit trail that
-- can be deleted by application code isn't an audit trail. No UPDATE or
-- DELETE path is ever wired up in the app — this trigger makes that a DB-
-- enforced guarantee instead of just a convention, so a bug or a compromised
-- account with DB write access still can't quietly erase its own tracks.
CREATE OR REPLACE FUNCTION prevent_vault_backup_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vault_backup_audit_log rows are append-only and never deleted or edited. See migration 073.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_vault_backup_audit_log_delete ON vault_backup_audit_log;
CREATE TRIGGER trg_prevent_vault_backup_audit_log_delete
  BEFORE DELETE ON vault_backup_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_vault_backup_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_prevent_vault_backup_audit_log_update ON vault_backup_audit_log;
CREATE TRIGGER trg_prevent_vault_backup_audit_log_update
  BEFORE UPDATE ON vault_backup_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_vault_backup_audit_log_mutation();
