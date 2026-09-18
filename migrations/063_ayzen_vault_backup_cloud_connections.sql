-- Feature 15l — Cloud Backup Delivery (Google Drive / Dropbox).
-- One row per (user, provider): OAuth tokens for pushing a copy of the
-- vault snapshot to the user's own Drive/Dropbox, in addition to (or
-- instead of) the existing email/webhook delivery destinations.
-- access_token/refresh_token are stored through encryptField() (same
-- envelope-encryption machinery as every other Vault secret) — never
-- plaintext at rest.
-- Applied by hand against Supabase, same convention as migrations 055-062
-- (not wired into index.ts's boot-time MIGRATIONS array).

CREATE TABLE IF NOT EXISTS vault_backup_cloud_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL, -- 'google_drive' | 'dropbox'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMP,
  -- Display-only (e.g. the connected Google/Dropbox account's email) so the
  -- Automatic Backups card can show "Connected as you@gmail.com" without
  -- ever decrypting a token just to render a label.
  account_label TEXT,
  -- Google Drive: the folder id backups are uploaded into (created once on
  -- first connect, named "AYZEN Vault Backups"). Unused by Dropbox, which
  -- addresses uploads by path instead.
  folder_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_vault_backup_cloud_connections_user
  ON vault_backup_cloud_connections (user_id);
