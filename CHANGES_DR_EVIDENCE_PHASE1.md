# DR Evidence Collector — Phase 1 (Backup Integrity stage only)

This zip is your FULL codebase (everything already merged, now with DR
Evidence Collector Phase 1 on top) — extract and overwrite your project,
nothing left to hand-patch.

See `dr-evidence-collector-design.md` for the full multi-phase design this
is Phase 1 of. Per that design (§8), Phase 1 deliberately does the least
risky slice first: no restore, no isolated schema — just proving, on
demand, that a stored scheduled backup still checksums and decrypts
correctly, and recording that as evidence.

## The idea

`routes/vault-snapshot.ts` already has `verifyStoredChecksum()` and
`lib/vault-backup-envelope.ts` already has `envelopeDecryptBackup()` — both
built for the manual download/restore-preview paths. Phase 1 adds no new
crypto; it just calls those same two functions on demand against the most
recent envelope-mode (scheduled) snapshot and writes the pass/fail result
to a new `dr_test_reports` table, so "we verified our backups" is
demonstrable evidence instead of an assumption.

Per the design doc's scope boundary (§0): this only ever tests
**envelope-mode** snapshots. Password-mode backups need a user-typed
password nothing automated has access to — that stays a manual,
owner-triggered check, untouched here.

## New

- **`dr_test_reports` table** (migration 068, `lib/db/src/schema/dr-test-reports.ts`)
  — one row per DR test run: `test_id` (human-readable, e.g. `DR-2026-0001`),
  `triggered_by`, `snapshot_id`, `encryption_mode`, `key_version`,
  `backup_checksum`, `checksum_result`/`decryption_result`/`overall_result`,
  `failure_stage`/`failure_reason`, timestamps. Deliberately a SUBSET of the
  full table in the design doc's §3 — restore-related columns
  (`isolated_schema_name`, `restore_result`, `records_expected/restored`,
  `rto_ms`) are Phase 2's job, and the hash chain
  (`report_hash`/`prev_report_hash`/`runner_version`) is Phase 3's, each to
  arrive via its own later `ALTER TABLE` migration rather than being
  pre-added now. Never stores plaintext/decrypted content — only counts,
  timestamps, pass/fail, and checksum values, same discipline as
  `vault_snapshots` / `buildRestoreDiff()`.
- **`lib/dr-test-runner.ts`** — `runDrTest({ triggeredBy, adminUserId })`:
  picks the latest envelope-mode `vault_snapshots` row, runs
  `verifyStoredChecksum()` then (if that passed) `envelopeDecryptBackup()`,
  and inserts the evidence row. The decrypted plaintext is discarded
  immediately after confirming the call succeeded — never logged, returned,
  or persisted. Never throws: every failure mode (no snapshot to test,
  checksum mismatch, decryption failure) is captured as a `fail` report
  instead of an unhandled exception, since a thrown error would mean the
  one failure that matters most goes unrecorded.
- **`POST /admin/dr-tests/run-now`** — triggers one Phase-1 run synchronously
  and returns the resulting report. `requireAdmin` + `sensitiveWriteLimiter`
  (it decrypts a real backup, even though the plaintext never leaves the
  function). This is the *only* way a report gets created right now — the
  node-cron scheduler that would call `runDrTest()` automatically is a
  Phase 3 item.
- **`GET /admin/dr-tests`** — lists past reports, most recent first
  (`?limit=`, capped at 100, default 20).
- **`GET /admin/dr-tests/:id`** — single report detail, e.g. to inspect a
  failure's `failureStage`/`failureReason`.

## Changed

- **`routes/vault-snapshot.ts`** — `verifyStoredChecksum()` is now exported
  (was module-private) so `lib/dr-test-runner.ts` can reuse it instead of
  duplicating the checksum logic. No behavior change to any existing caller.

## Not done here (Phase 2/3)

- **No restore.** Phase 1 never touches `applyRestoreDiff()` or creates any
  schema — it only confirms a snapshot decrypts. Actually restoring into an
  isolated `dr_test_<run_id>` schema, record-count verification, and RTO
  measurement are Phase 2 (design doc §1, §2, §5).
- **No scheduler.** Nothing calls `runDrTest()` on a timer yet — every
  report today comes from an admin hitting `POST /admin/dr-tests/run-now`.
  The `node-cron` sweep (same pattern as
  `lib/vault-backup-schedule-cron.ts`) is Phase 3, and `triggered_by` will
  start seeing `"scheduled"` values once it exists.
- **No dashboard page.** `GET /admin/dr-tests` and `GET /admin/dr-tests/:id`
  are plain JSON today — a `pages/admin/dr-health.tsx` UI (design doc §7) is
  Phase 3.
- **No alerting.** A failed run is only visible by checking the report
  (or the server logs / `logBus`) — the `notificationsTable` + `sendEmail`
  failure alert described in the design doc §6 is Phase 3.
- **No hash chain.** `report_hash`/`prev_report_hash` don't exist on this
  table yet — Phase 3, alongside the scheduler and dashboard.
- The three open questions in the design doc §9 (full vs. trimmed
  migrations set for Phase 2's isolated schema; `dr_test_reports` retention
  policy; per-user vs. representative-sample testing for multi-user vaults)
  are all still open — none of them affect Phase 1, since it never restores
  or touches per-user data beyond reading one `vault_snapshots` row.

## Before running

- **Migration 068** must be applied by hand against Supabase before this
  deploys (same convention as migrations 055–067 — not wired into
  `index.ts`'s boot-time `MIGRATIONS` array). Run it after 067.
- No new env var. Reuses `VAULT_MASTER_KEY`/`VAULT_FIELD_ENCRYPTION_KEY`
  (already required for scheduled backups to exist at all) via the existing
  `envelopeDecryptBackup()`.
- If no envelope-mode snapshot exists yet (e.g. a fresh install with no
  automatic backup schedule ever run), `POST /admin/dr-tests/run-now` still
  succeeds as an HTTP call and records a `fail` report with
  `failure_stage = "no_snapshot"` — this itself is useful evidence ("DR
  testing has nothing to verify yet"), not an error.
