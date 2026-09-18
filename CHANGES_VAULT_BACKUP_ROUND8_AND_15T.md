# CHANGES — Vault Backup Hardening Round 8, and Feature 15t

Two independent additions, from two separate asks:

1. **"Did today's backup happen or not — tell me on Telegram, email, and
   the website."** The schedule cron already ran daily/weekly/monthly and
   recorded `lastRunStatus`/`lastRunAt`/`lastRunError` — but nothing
   proactively told the account owner. You only found out by opening the
   Snapshot Backup page.
2. **"Massively extend the vault backup format."** Every existing domain in
   a backup (mailbox, projects, finance, wallet hub, activity, entity
   coverage, emergency access, account extras, team, earning) is a slice of
   *product* data. The backup **system's own configuration** — your
   schedule, connected cloud accounts, delivery history, security posture —
   was never itself included.

## 1. Round 8 — routine backup-outcome alerts

**The gap:** Rounds 6/7 only ever alerted on something going *wrong*
(anomalous IP access, stale key rotation). A normal day's scheduled backup
— success or failure — never told anyone anything. "Did my backup happen
today" required opening the app and reading a small status line.

**The fix — `lib/vault-backup-alerts.ts`:**

- **`alertUserOfScheduledBackupResult(userId, outcome)`** — fired from
  `runVaultBackupSchedule()` (`lib/vault-backup-schedule-cron.ts`) after
  *every* run, success or failure, over all three channels this app already
  uses together for Finance (`lib/finance-notify.ts`'s pattern): the
  notification bell (website), Telegram (if the account has one linked),
  and email (always — every account has one). Success messages include a
  one-line summary (`N entities, N wallets`); failure messages include the
  error and a reassurance that no existing data was lost, plus a pointer to
  the manual "Run Now" button.
- If the backup itself stored fine but its off-vault delivery (email/
  webhook/cloud) failed, the alert reports that as a failure too — a silent
  "half-succeeded" state would otherwise look identical to a full success
  on the notification/Telegram/email side even though `lastRunError` was
  already showing it on the page.

**Also new — the missed-backup watchdog**, for the failure mode the alert
above *can't* cover: the cron process itself stops ticking (server down,
`VAULT_BACKUP_SCHEDULE_CRON` misconfigured) so no run — successful or
failed — is ever attempted. That's not "a backup failed", it's "nothing
happened at all", and without a separate check it's indistinguishable from
"nothing to report":

- `sweepMissedSchedules()` (`lib/vault-backup-schedule-cron.ts`) runs on its
  own, coarser cadence (`VAULT_BACKUP_WATCHDOG_CRON`, default every 30
  minutes) and flags any enabled schedule whose `nextRunAt` is more than
  `VAULT_BACKUP_WATCHDOG_GRACE_MINUTES` (default 45m) overdue with no
  in-flight run (`runningSince` still null) — i.e. genuinely never even
  attempted, not just slow.
- Fires **`alertUserOfMissedBackup(userId, missedSinceMinutes)`** — same
  three channels — then advances `nextRunAt` and sets
  `lastRunStatus = "missed"` so the schedule self-heals back onto its
  normal cadence and the watchdog doesn't re-alert on every subsequent
  tick for the same miss.
- The grace window is deliberately wider than the main 15-minute sweep
  interval so a single slow tick or brief restart is never mistaken for a
  genuine outage — this is for real multi-tick silence, not jitter.
- Registered alongside the existing cron in `index.ts`:
  `startVaultBackupMissedWatchdog()`.
- Frontend (`pages/user/vault-snapshot.tsx`): the Automatic Backups status
  panel now has a distinct amber "Last scheduled run was missed" line
  (`AlertTriangle` icon) instead of folding it into the existing
  success/failure display, since a miss has no `lastRunAt` of its own to
  show.

Migration: none needed — reuses the existing `lastRunStatus` text column,
just with a third value.

## 2. Feature 15t — Backup System Self-Coverage (migration 074)

**The gap:** an old `.ayzenbak` could rebuild your entities, wallets,
mailbox, finance, everything — except how your *backups themselves* were
configured. A full disaster-recovery restore couldn't tell you whether you
even had automatic backups turned on, what your delivery destination was,
or what your Vault security posture looked like.

**The fix — `lib/vault-snapshot-extra.ts`'s new
`gatherBackupSystemSnapshot()`**, bundled into every export/scheduled
backup as a new `backupSystem` key, counted via the new
`backup_system_count` column (migration 074):

- **`schedule`** — the user's `vault_backup_schedules` row: frequency, day/
  hour, destination, last-run history.
- **`cloudConnections`** — `vault_backup_cloud_connections` rows: provider,
  account label, folder id.
- **`deliveries`** — off-vault delivery audit log (`vault_backup_deliveries`),
  capped to the most recent 500.
- **`auditLog`** — this user's own slice of `vault_backup_audit_log`
  (`ownerUserId = userId`), capped to the most recent 500.
- **`vaultSecurityPosture`** — a **boolean-only** summary of
  `vault_security`: `hasVaultPin` / `hasEntityPin` / `hasVaultPassword` /
  `vaultTwoFaEnabled` / `authStepPolicy`.
- **`projectTemplates`** — `ayzen_project_templates` rows this user
  authored.

**Secrets deliberately excluded, not just "not auto-restored" like the
rest of this file:**

- `vault_backup_schedules.webhook_secret` — an HMAC signing key. Backing it
  up would mean anyone who ever obtained *one* backup blob (which can
  itself be emailed/webhooked/cloud-delivered — the blob leaving the
  server is the normal case, not a breach) could forge delivery payloads
  for every future backup.
- `vault_backup_cloud_connections.access_token` /
  `refresh_token` — live OAuth credentials for the user's own Google
  Drive/Dropbox. Backing these up would mean a stolen backup blob grants
  access to a *different* account's cloud storage, not just this app.
- `vault_security`'s PIN/password hashes and the Vault 2FA secret — a
  4-digit PIN hash is brute-forceable offline in well under a second
  (10,000 possibilities), so unlike a normal account-password hash, storing
  it anywhere a decrypted backup blob could later expose it is a genuine
  credential leak, not defense-in-depth. Only booleans ("is a PIN set")
  are included — enough to audit your own security posture, never enough
  to reconstruct the credential.

Reference-only, **not** wired into the merge-restore mechanism — same
treatment as `finance`/`profile`/`activity`/`team` elsewhere in this file:
re-inserting an old schedule or cloud-connection row could silently
resurrect a stale delivery destination (an ex-employee's email, a rotated
webhook) without the user explicitly choosing to. That's a Settings
decision, not something a restore should do for you.

**Touched:** `migrations/074_ayzen_vault_backup_system_coverage.sql`,
`lib/db/src/schema/vault-snapshots.ts`,
`lib/db/src/schema/vault-backup-schedules.ts` (comment only),
`artifacts/api-server/src/lib/vault-snapshot-extra.ts`,
`artifacts/api-server/src/routes/vault-snapshot.ts`,
`artifacts/api-server/src/lib/vault-backup-schedule-cron.ts`,
`artifacts/api-server/src/lib/vault-backup-alerts.ts`,
`artifacts/api-server/src/index.ts`,
`artifacts/ayzen/src/lib/vault-snapshot-api.ts`,
`artifacts/ayzen/src/pages/user/vault-snapshot.tsx`.
