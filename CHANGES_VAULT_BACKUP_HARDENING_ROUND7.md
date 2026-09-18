# CHANGES — Vault Backup Hardening, Round 7

One addition this round: alerting on top of Round 6's audit trail. Round 6
made sure every backup-security event got *recorded*; nothing consumed
that record proactively, so a real incident would still sit silent until
someone happened to check `/vault/backup/audit-log` or
`/admin/vault-backup/key-status`. This round closes that for the two
events where silence is most costly.

## 1. Anomalous-IP alert on backup download/restore

**The gap:** if a session token were ever stolen and used only to pull
backups — never to log in fresh — Round 6 would log it (`snapshot_downloaded`
/ `snapshot_restored`, with IP), but nothing would tell the account owner
it happened. They'd only find out by going to look.

**The fix:** `lib/vault-backup-audit.ts`'s new `isAnomalousBackupIp(userId, ip)`
— checked before every download/restore, against that account's own history
of `snapshot_downloaded`/`snapshot_restored` events (not login history; see
below). If the IP has never done either of those things on this account
before, `lib/vault-backup-alerts.ts`'s `alertOwnerOfAnomalousBackupAccess()`
emails the account owner. A first-ever download/restore is never flagged —
same "no baseline yet, don't block/alert on it" rule
`lib/login-security.ts`'s existing `isAnomalousIp()` already uses for
logins.

**Why a separate baseline from login's `isAnomalousIp()`, not a reuse of
it:** they answer different questions. Login's version asks "has this
account ever signed *in* from here." This asks "has this account's backup
*data* ever left the server to here before" — an IP a user has genuinely
logged in from before but never used to touch backup data is still worth
flagging, since the threat model here (a stolen, still-valid session token
used narrowly for backup exfiltration) doesn't require a fresh login at
all.

**Ordering matters:** the check runs and is awaited *before* the current
event's `logBackupAudit()` write, so a download never counts as evidence
for its own anomaly check. The audit write and the alert email are both
still fire-and-forget from the route's perspective — neither delays the
actual download/restore response.

## 2. Admin alert on stale key rotation

**The gap:** Round 6's automatic rotation cron already recorded a
`key_rotation_stale` audit event when an automatic rotation attempt
failed, but — same as everywhere else this round is about — recording
isn't noticing. An admin would only find out by checking.

**The fix:** `lib/vault-backup-key-rotation-cron.ts` now also calls
`lib/vault-backup-alerts.ts`'s `alertAdminsOfStaleKeyRotation()` on that
same failure path — every admin gets an email with the key version, how
overdue it is, and the underlying error. Deliberately mirrors
`lib/dr-test-cron.ts`'s existing `alertAdminsOfFailure()` rather than
inventing a new pattern: same "fetch every admin, best-effort per-address
send, one bounce never blocks the rest" discipline. Explicitly reassures
the reader that this is not a data-availability problem — scheduled
backups keep working fine under the current (just overdue) key while the
underlying issue gets fixed.

**New**
- `artifacts/api-server/src/lib/vault-backup-alerts.ts` —
  `alertOwnerOfAnomalousBackupAccess()`, `alertAdminsOfStaleKeyRotation()`.

**Changed**
- `artifacts/api-server/src/lib/vault-backup-audit.ts` — new
  `isAnomalousBackupIp()`.
- `artifacts/api-server/src/routes/vault-snapshot.ts` — both
  `GET /vault/snapshots/:id/download` and `POST /vault/snapshot/restore`
  check `isAnomalousBackupIp()` before logging, and fire the owner alert
  when flagged.
- `artifacts/api-server/src/lib/vault-backup-key-rotation-cron.ts` — calls
  `alertAdminsOfStaleKeyRotation()` alongside the existing
  `key_rotation_stale` audit write.

## Verification

- Bracket/paren/comment-aware structural balance check run against every
  new and modified file in this round — all balanced.
- Confirmed no circular import between `lib/login-security.ts` and
  `routes/vault-snapshot.ts` (only `getClientIp` is imported, a pure
  function with no dependency back into the vault-backup modules).
- Not possible in this sandbox (no DB/network/SMTP access): confirming an
  actual alert email is delivered end-to-end on a live deployment, and
  confirming `isAnomalousBackupIp()`'s query plan uses the
  `vault_backup_audit_log_owner_idx` index from migration 073 rather than
  a sequential scan at scale.
