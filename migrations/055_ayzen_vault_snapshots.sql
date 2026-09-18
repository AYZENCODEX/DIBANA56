-- 055_ayzen_vault_snapshots.sql
-- Stored Vault Backups (Feature 15b) — see lib/db/src/schema/vault-snapshots.ts.
--
-- Until now, POST /vault/snapshot/export (Feature 15) only ever streamed its
-- encrypted blob straight to the browser as a download — nothing persisted
-- server-side, so there was no actual "backup store" in the vault, just an
-- export button. This table is that store: every export also gets a row
-- here, so the Snapshot Backup page can list, re-download, restore-from, or
-- delete past backups directly.
CREATE TABLE IF NOT EXISTS vault_snapshots (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT,
  blob TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  includes_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  entries_count INTEGER NOT NULL DEFAULT 0,
  wallets_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Powers "list my backups, newest first" (Snapshot Backup page) without a
-- table scan.
CREATE INDEX IF NOT EXISTS vault_snapshots_user_created_idx
  ON vault_snapshots (user_id, created_at DESC);
