-- 058_ayzen_vault_backup_coverage_expansion.sql
-- Feature 15d — Vault Backup Coverage Expansion: Native Mailbox, Projects
-- (Protocol Enrollments), Tasks, Finance, and User Profile.
--
-- Applied by hand against Supabase (same convention already used for
-- migrations 055-057: not wired into index.ts's boot-time MIGRATIONS array).
--
-- buildVaultSnapshotPayload() (routes/vault-snapshot.ts, via
-- lib/vault-snapshot-extra.ts) now bundles the user's native mailbox,
-- protocol/project enrollments, task submissions, finance ledger, and
-- account-config profile into every export/scheduled backup blob alongside
-- the existing Vault/Local/KYC/Game/Wallet data. These columns are just
-- denormalized counts for the "Stored Backups" list UI (same purpose as the
-- existing entries_count/wallets_count) — the actual data lives inside the
-- encrypted blob itself, same as everything else in this table.
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS mailbox_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS projects_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS tasks_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS finance_count INTEGER NOT NULL DEFAULT 0;
