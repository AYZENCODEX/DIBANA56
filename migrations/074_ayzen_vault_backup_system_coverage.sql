-- migrations/074_ayzen_vault_backup_system_coverage.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Feature 15t — Vault Backup Coverage Expansion: Backup System Self-Coverage.
--
-- Every domain bundled into a vault snapshot so far (mailbox, projects,
-- tasks, finance, walletHub, activity, entityCoverage, emergencyAccess,
-- accountExtras, team, earning) is a slice of the user's own product data.
-- The backup SYSTEM's own per-user configuration — the automatic-backup
-- schedule they set up, which cloud accounts they connected for delivery,
-- their delivery/audit history, their Vault security posture, and any
-- project templates they've authored — was never itself part of the backup,
-- so a full disaster-recovery restore from an old .ayzenbak couldn't tell
-- you how your OWN backups were even configured. lib/vault-snapshot-extra.ts's
-- new gatherBackupSystemSnapshot() closes that gap. See its doc comment for
-- exactly what is (and, for secrets, deliberately is not) included.
--
-- Same denormalized-count purpose as every other *_count column on this
-- table: list views can show "X items backed up" without touching `blob`.
ALTER TABLE vault_snapshots
  ADD COLUMN IF NOT EXISTS backup_system_count INTEGER NOT NULL DEFAULT 0;
