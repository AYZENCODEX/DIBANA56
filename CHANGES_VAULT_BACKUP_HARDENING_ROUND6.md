# CHANGES — Vault Backup Hardening, Round 6

Two fixes this round, both about closing the gap between "the crypto is
sound" (Rounds 1, 3, 4 — envelope encryption, KEK derivation, AAD ownership
binding) and "we'd actually notice if it were misused" — which nothing
before this round addressed:

1. **Dedicated backup-security audit trail** — a raw, offline-decryptable
   backup blob could leave the server via `GET /vault/snapshots/:id/download`
   with **zero record anywhere** that it happened. Several other
   security-relevant events (a webhook destination changing, a cloud
   connection being made/revoked) were equally unlogged.
2. **Automatic DEK rotation** — `rotateBackupEnvelopeKey()` (Round 1) and
   its admin trigger (a later round's `routes/vault-backup-key.ts`) both
   existed, but rotation only ever happened if an admin remembered to click
   a button. Nothing enforced any cadence.

## 1. Dedicated backup-security audit trail

**The gap:** `user_activity` (`lib/activity.ts`'s `logActivity`) is a
generic, app-wide feed shared by every feature in this codebase — useful,
but not queryable as "everything that touched vault-backup security," and
several of the sharpest events wrote nothing to it at all. Specifically:

- `GET /vault/snapshots/:id/download` hands back a raw `"ENV2:..."` or
  password-mode blob — per that route's own doc comment, this exists so
  "an automatic backup can still be moved off-vault by hand." That's
  exactly the kind of event an incident responder needs a timestamp and IP
  for, and it was logged nowhere.
- `PUT /vault/backup/schedule` changing a webhook destination — the same
  surface Round 5's SSRF guard protects — left no record of what the
  destination was before, or who changed it.
- Connecting/disconnecting a Google Drive or Dropbox delivery target
  (`routes/vault-backup-cloud.ts`) was unlogged.

**The fix:** a new, append-only `vault_backup_audit_log` table
(`lib/vault-backup-audit.ts`'s `logBackupAudit()`), written to — best-effort,
non-blocking, same discipline as every other activity logger in this
codebase — at:

- `snapshot_downloaded` — `GET /vault/snapshots/:id/download` (new; this is
  the event that motivated the whole table)
- `snapshot_restored`, `snapshot_trashed`, `snapshot_untrashed`,
  `snapshot_purged` — already had `user_activity` rows; now also here
- `schedule_destination_changed`, `schedule_webhook_changed` — new, on
  `PUT /vault/backup/schedule`
- `cloud_connected`, `cloud_disconnected` — new, on
  `routes/vault-backup-cloud.ts`
- `key_rotated` (manual and automatic — see part 2) and `key_rotation_stale`
  (an automatic rotation attempt that failed)

Every row captures `ownerUserId`, `actorUserId`/`actorKind` (`user` /
`admin` / `system` — so an admin's action or an unattended cron run is
distinguishable from the account owner's own), `ip`/`userAgent` (via
`req`), and a small `detail` JSON blob. **`detail` is deliberately never
allowed to carry ciphertext, key material, passwords, tokens, or a raw
webhook URL** — a changed webhook target is logged through `redactUrl()`
(host + path only, query string and any embedded credentials stripped)
specifically because a webhook URL is a plausible place to carry an auth
token, and this table is meant to be safely readable by any admin doing
incident response.

Two new endpoints expose it:
- `GET /vault/backup/audit-log` — a user's own history (auth required,
  scoped to their own `ownerUserId`)
- `GET /admin/vault-backup/audit-log?userId=&limit=` — admin-only, every
  user's events, optionally filtered to one account

**Append-only is DB-enforced, not just convention** — migration 073 adds
`BEFORE UPDATE`/`BEFORE DELETE` triggers on `vault_backup_audit_log` that
unconditionally raise, the same pattern migration 067 already established
for `encryption_keys`. No application code path updates or deletes a row in
this table today; the trigger means that stays true even if a future bug
(or a compromised account with DB write access) tries.

## 2. Automatic DEK rotation

**The gap:** rotation was purely reactive. `routes/vault-backup-key.ts`'s
`POST /admin/vault-backup/rotate-key` worked correctly, but a real
deployment could go years with the same active key if no admin happened to
click it — there was no visibility into key age either, so there wasn't
even a way to notice the drift short of querying the DB by hand.

**The fix:** `lib/vault-backup-key-rotation-cron.ts`, same `node-cron`
pattern as `lib/dr-test-cron.ts` and `lib/vault-backup-schedule-cron.ts`.
Once a day (`VAULT_BACKUP_KEY_ROTATION_CRON`, default `0 4 * * *`), checks
the active `vault-backup` DEK's age; if it's `>= VAULT_BACKUP_KEY_ROTATION_DAYS`
(default 90), rotates automatically and logs a `key_rotated` audit event
with `actorKind: "system"`. If the rotation attempt itself fails, logs
`key_rotation_stale` instead and leaves the (now-overdue) key in place —
scheduled backups keep working fine under the current key in the meantime,
this only affects *when a new key starts getting used*, never data
availability.

Rotation's own safety properties are completely unchanged from Round 1: it
only affects new backups going forward, old DEK versions are kept forever
(migration 067's delete guard), so this cron introduces no new risk beyond
"rotation now happens even if nobody clicks a button" — which is the
point.

`GET /admin/vault-backup/key-status` now also returns `activeKeyAgeDays`,
`rotationThresholdDays`, and a `stale` flag (same threshold the cron
checks against), so an admin can see a key is approaching rotation before
the cron would even act on it, not just after.

**Behavior change to be aware of:** if `VAULT_BACKUP_KEY_ROTATION_DAYS` is
unset, the active `vault-backup` DEK will now rotate automatically after
90 days of any deployment running this code, where previously it never
rotated on its own. Set `VAULT_BACKUP_KEY_ROTATION_DAYS=0` (or any
non-positive value) to disable automatic rotation entirely and keep the
previous manual-only behavior; `VAULT_BACKUP_KEY_ROTATION_CRON` can be set
to a stricter/looser cadence than "check daily" if desired. Manual rotation
via the existing admin route is unaffected either way.

**New**
- `migrations/073_ayzen_vault_backup_audit_log.sql` — `vault_backup_audit_log`
  table, append-only (UPDATE/DELETE both trigger-blocked).
- `lib/db/src/schema/vault-backup-audit-log.ts` — Drizzle schema, exported
  from `lib/db/src/schema/index.ts`.
- `artifacts/api-server/src/lib/vault-backup-audit.ts` — `logBackupAudit()`
  write helper, `redactUrl()`, and `listOwnBackupAuditLog()` /
  `listBackupAuditLogAdmin()` read helpers.
- `artifacts/api-server/src/lib/vault-backup-key-rotation-cron.ts` —
  `startVaultBackupKeyRotationCron()`, wired into `index.ts`'s startup
  sequence alongside the other backup-adjacent crons.

**Changed**
- `artifacts/api-server/src/routes/vault-snapshot.ts` — logs
  `snapshot_downloaded` (new), and mirrors the existing `restored` /
  `trashed` / `untrashed` / `purged` events into the new audit table
  alongside their existing `logActivity()` calls.
- `artifacts/api-server/src/routes/vault-backup-schedule.ts` — logs
  `schedule_destination_changed` / `schedule_webhook_changed` on save; new
  `GET /vault/backup/audit-log`.
- `artifacts/api-server/src/routes/vault-backup-cloud.ts` — logs
  `cloud_connected` / `cloud_disconnected`.
- `artifacts/api-server/src/routes/vault-backup-key.ts` — `POST
  /admin/vault-backup/rotate-key` now also writes a `key_rotated` audit
  event; `GET /admin/vault-backup/key-status` returns key-age/staleness;
  new `GET /admin/vault-backup/audit-log`.
- `artifacts/api-server/src/index.ts` — starts the new rotation cron.

## Verification

- Bracket/paren/comment-aware structural balance check run against every
  new and modified file in this round — all balanced.
- Not possible in this sandbox (no DB/network access to the real app):
  applying migration 073 against live Supabase and confirming the
  UPDATE/DELETE triggers actually fire; confirming a live rotation cron
  tick correctly no-ops when the active key is within its window and
  correctly rotates + logs when it's past it; end-to-end confirmation that
  `GET /vault/backup/audit-log` and the admin equivalent return the
  expected rows against a running Postgres instance.
