-- 072_ayzen_vault_snapshots_soft_delete.sql
-- Run this once in Supabase SQL Editor. Run AFTER 071.
--
-- Vault Backup hardening — Snapshot Delete Protection.
--
-- Until now, DELETE /vault/snapshots/:id (routes/vault-snapshot.ts) hard-
-- deleted the row immediately: one compromised session, one accidental
-- click, or one malicious actor with a stolen auth token could wipe out a
-- user's entire stored-backup history in seconds — the exact "backup that
-- isn't there when you need it" failure mode strong encryption alone can't
-- prevent. pruneOldSnapshots() (the automatic MAX_STORED_SNAPSHOTS/quota
-- prune that runs after every export) had the same hard-delete behavior.
--
-- This migration gives vault_snapshots the same recycle-bin pattern already
-- used for vault_entries (see lib/vault-trash-purge.ts / routes/vault.ts's
-- DELETE /vault/:id + POST /vault/:id/restore): a soft-deleted row is kept,
-- recoverable, until a retention-window sweep purges it for real.
--
-- The BEFORE DELETE trigger below is the actual enforcement — mirroring
-- migration 067's encryption_keys guard, but conditional rather than
-- unconditional, since this table DOES need real deletes eventually (the
-- trash-purge sweep). It only allows a hard DELETE once a row has been
-- sitting in the trash for at least 3 days — comfortably shorter than the
-- app's own VAULT_SNAPSHOT_TRASH_RETENTION_DAYS (default 14) purge window,
-- so the sweep never trips it, but long enough that no single request
-- (soft-delete immediately followed by a hard-delete attempt) can bypass
-- the recovery window in one session.

ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS vault_snapshots_deleted_at_idx ON vault_snapshots(deleted_at);

CREATE OR REPLACE FUNCTION prevent_premature_vault_snapshot_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.deleted_at IS NULL THEN
    RAISE EXCEPTION 'vault_snapshots row % must be soft-deleted (deleted_at set) before it can be removed — use DELETE /vault/snapshots/:id first. See migration 072.', OLD.id;
  ELSIF OLD.deleted_at > NOW() - INTERVAL '3 days' THEN
    RAISE EXCEPTION 'vault_snapshots row % was trashed less than 3 days ago (deleted_at=%) — too soon to hard-delete. See migration 072.', OLD.id, OLD.deleted_at;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_premature_vault_snapshot_delete ON vault_snapshots;
CREATE TRIGGER trg_prevent_premature_vault_snapshot_delete
  BEFORE DELETE ON vault_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_premature_vault_snapshot_delete();
