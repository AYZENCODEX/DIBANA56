# CHANGES — Vault Backup Hardening, Round 2

Two independent hardenings on top of the already-shipped envelope
encryption / key rotation / DR Evidence Collector Phase 1+2:

1. **Snapshot Delete Protection** — closes the gap where anyone with a
   valid session (a stolen token, a compromised browser, or just a
   mis-click) could instantly and permanently wipe a user's entire stored
   backup history via `DELETE /vault/snapshots/:id`.
2. **DR Evidence Collector Phase 3 (cron + alerting)** — the automated
   restore test (`runDrTest()`, already fully built) now actually runs on
   a schedule instead of only when an admin remembers to click "Run DR
   Test", and emails every admin if it fails.

## 1. Snapshot Delete Protection

**New**
- `migrations/072_ayzen_vault_snapshots_soft_delete.sql` — adds
  `vault_snapshots.deleted_at` + a `BEFORE DELETE` trigger that refuses to
  hard-delete a row unless it's already soft-deleted AND has been sitting
  in the trash for at least 3 days. Hand-applied against Supabase, same
  convention as migrations 055–071 (not wired into `index.ts`'s boot-time
  `MIGRATIONS` array).
- `lib/vault-snapshot-trash-purge.ts` / `lib/vault-snapshot-trash-cron.ts`
  — the retention sweep (default 14 days, `VAULT_SNAPSHOT_TRASH_RETENTION_DAYS`)
  that actually hard-deletes a trashed backup once its window is up,
  scheduled daily at 03:30 (`VAULT_SNAPSHOT_TRASH_PURGE_CRON`). Same split
  and same pattern as the existing `vault-trash-purge.ts` /
  `vault-trash-cron.ts` for vault entries.

**Changed** (`routes/vault-snapshot.ts`)
- `DELETE /vault/snapshots/:id` now soft-deletes (sets `deleted_at`)
  instead of removing the row.
- `pruneOldSnapshots()` (the automatic MAX_STORED_SNAPSHOTS/quota prune
  that runs after every export) also soft-deletes instead of hard-deleting
  — an export that pushes a user over their limit trashes the oldest
  backup rather than destroying it outright.
- `GET /vault/snapshots`, `GET /vault/snapshots/storage`,
  `GET /vault/snapshots/:id/download`, and the stored-snapshot lookup
  inside restore-preview/restore all now exclude trashed rows.
- **New:** `GET /vault/snapshots/trash` (list, with computed `purgeAt`),
  `POST /vault/snapshots/:id/restore` (undo a trash), `DELETE
  /vault/snapshots/trash/:id` (skip the wait and purge one now — still
  subject to the migration's 3-day trigger floor).

**Not changed:** `vault_backup_cloud_connections` (Drive/Dropbox) and
email/webhook delivery are unaffected — this only protects the
server-stored `vault_snapshots` rows themselves, which is where the actual
one-click-destroys-everything risk lived.

## 2. DR Evidence Collector — Phase 3 (cron + alerting)

**New**
- `lib/dr-test-cron.ts` — runs `runDrTest({ triggeredBy: "scheduled" })`
  weekly (default Sunday 05:00, `DR_TEST_CRON`), the same checksum →
  decrypt → isolated-schema-restore → record-count-verification pipeline
  Phase 1+2 already built. On `overallResult === "fail"`, emails every
  `role = "admin"` user a summary (failure stage, reason, which snapshot)
  — best-effort per admin, one failed send never blocks the others or the
  already-persisted `dr_test_reports` row.

**Changed**
- `index.ts` — wires up `startVaultSnapshotTrashCron()` and
  `startDrTestCron()` alongside the other cron starters.
- `routes/dr-tests.ts` / `lib/db/src/schema/dr-test-reports.ts` — comments
  updated; `POST /admin/dr-tests/run-now` is no longer the only way a
  report gets created, just the on-demand one.

**Still open** (per `dr-evidence-collector-design.md`'s phased plan): an
admin dashboard page, and the report hash chain. Neither existed before
this change either — only the scheduler + alerting gap this round closes.

## Env vars this adds (all optional, sane defaults)

| Var | Default | Purpose |
|---|---|---|
| `VAULT_SNAPSHOT_TRASH_RETENTION_DAYS` | `14` | How long a trashed backup stays recoverable |
| `VAULT_SNAPSHOT_TRASH_PURGE_CRON` | `30 3 * * *` | When the purge sweep runs |
| `DR_TEST_CRON` | `0 5 * * 0` | When the automated restore test runs |

## Verification not possible in this sandbox (no DB/network access)

- Apply migration 072 against a real Supabase instance and confirm the
  trigger fires correctly (both branches: no `deleted_at` yet, and
  `deleted_at` too recent).
- `pnpm --filter @workspace/api-server tsc --noEmit` against the real
  workspace dependencies — only brace/paren balance was checked here.
- Confirm `sendEmail()` actually delivers the DR-failure alert in a real
  environment with `RESEND_API_KEY` (or whichever provider `lib/email.ts`
  is configured for) set.
