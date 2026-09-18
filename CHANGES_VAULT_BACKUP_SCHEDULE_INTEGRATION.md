# CHANGES — Feature 15c: Automatic Vault Backups (Integration)

Integrates the automatic/scheduled vault backup pieces (schedule cron, route,
server-managed envelope encryption, off-vault delivery) plus the Feature 15c
restore-preview/merge feature into the main AYZEN codebase. Previously these
existed only as standalone files that hadn't been wired into the running app.

## What changed

**Backend**
- `routes/vault-snapshot.ts` — refactored to export `buildVaultSnapshotPayload()`
  and `storeSnapshotRow()`, which `lib/vault-backup-schedule-cron.ts` needs but
  which didn't previously exist as reusable exports. Added envelope-mode
  decryption support to restore/restore-preview (so a scheduled/automatic
  backup can be restored without a password). Merged in the restore-preview
  and merge-restore routes.
- Added `lib/vault-backup-schedule-cron.ts`, `lib/vault-backup-envelope.ts`,
  `lib/vault-backup-delivery.ts`, `lib/vault-snapshot-restore.ts`.
- Added `routes/vault-backup-schedule.ts`, registered in `routes/index.ts`.
- `index.ts` — now loads the backup envelope key manager at boot and starts
  the schedule cron.
- Applied migration `056_ayzen_vault_backup_extended.sql` (adds
  `checksum` / `source` / `encryption_mode` / `encryption_version` to
  `vault_snapshots`; creates `vault_backup_schedules` and
  `vault_backup_deliveries`).
- `lib/db/src/schema/vault-snapshots.ts` — updated with the new columns.
- Added `lib/db/src/schema/vault-backup-schedules.ts` and
  `vault-backup-deliveries.ts`, exported from `schema/index.ts`.

**Frontend**
- `pages/user/vault-snapshot.tsx` — added an "Automatic Backups" card
  (frequency/day/hour, destination, attachments toggle, save/run-now,
  last-run status, recent deliveries) and merged in the restore-preview UI.
  Stored-backup rows now show an "automatic" badge and skip the password
  prompt for envelope-encrypted (scheduled) backups.
- `lib/vault-snapshot-api.ts` — added typed client functions for the
  schedule endpoints (`getVaultBackupSchedule`, `saveVaultBackupSchedule`,
  `runVaultBackupScheduleNow`, `listVaultBackupDeliveries`).

## Required env vars
- `VAULT_MASTER_KEY` (or `VAULT_FIELD_ENCRYPTION_KEY` as fallback), ≥32 chars
  — wraps the backup envelope DEK. Without it, scheduled backups fail at
  boot-time key-manager load (logged, non-fatal — manual password-protected
  exports are unaffected) and again at run time.
- `VAULT_BACKUP_SCHEDULE_CRON` (optional) — cron expression for the sweep
  interval; defaults to every 15 minutes.

## Verified against the real codebase (not just internal consistency)
- `encryptPhrase`/`decryptPhrase` in `lib/wallet-crypto.ts` — exist as assumed.
- `sendEmail()` attachment support in `lib/email.ts` — exists as assumed.
- `encryption_keys` table shape (`namespace`, `version`, `wrapped_dek`,
  `active`) — matches what `vault-backup-envelope.ts` expects.
- Raw-SQL table column sets (`local_accounts`, `kyc_entries`, `game_entries`)
  used by the restore merge's per-table exclusion lists — checked against
  the actual migrations.

## Known gap
No UI exists yet for browsing `vault_backup_deliveries` beyond the last 5
shown inline on the Automatic Backups card — fine for now, but a dedicated
history view would help once delivery volume grows.
