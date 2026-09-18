-- migrations/077_ayzen_vault_backup_external_mail_cache.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Feature 15x — Vault Backup Coverage Expansion: External Mail Sync Cache.
--
-- Feature 15u backed up WHICH external IMAP/SMTP mailboxes a user connected
-- (email_accounts — host/port/credentials). It never backed up the actual
-- synced content sitting in `mail_messages`: the header cache from
-- lib/mail-sync.ts's inbox sync plus any message bodies the user has opened
-- and lazily cached (routes/email-accounts.ts's fetch-body handler). A
-- restore that reconnects your Gmail but shows an empty inbox until the
-- next sync isn't full coverage of what the Email Manager page was showing.
-- See gatherExternalMailSnapshot's doc comment in lib/vault-snapshot-extra.ts
-- for why this is reference-only (a cache of a system of record living
-- outside AYZEN — re-syncing, not restoring, is the correct recovery path).
--
-- Same denormalized-count purpose as every other *_count column on this
-- table: list views can show "X items backed up" without touching `blob`.
ALTER TABLE vault_snapshots
  ADD COLUMN IF NOT EXISTS external_mail_count INTEGER NOT NULL DEFAULT 0;
