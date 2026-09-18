# DR Evidence Collector — Phase 2 (Schema-Isolated Restore)

This zip is your FULL codebase (everything already merged, now with DR
Evidence Collector Phase 1 **and** Phase 2 on top) — extract and overwrite
your project, nothing left to hand-patch.

See `dr-evidence-collector-design.md` for the full multi-phase design this
is Phase 2 of. Per that design (§1, §2, §8), Phase 2 is "the real heavy
part": actually restoring a decrypted backup into a throwaway, isolated
Postgres schema and verifying record counts — not just proving it decrypts
(that was Phase 1).

## The idea

A DR test is only real evidence of *recoverability* once it proves a
backup can be turned back into a working database, not just that it
decrypts. Phase 2 adds that: after Phase 1's checksum + decrypt succeed,
the runner now stands up a brand-new `dr_test_<run_id>` Postgres schema,
restores the decrypted snapshot into it using the exact same
`applyRestoreDiff()` merge logic the real `POST /vault/snapshot/restore`
route uses, compares the snapshot's own per-table row counts against what
actually landed in the isolated schema, and — always, even on failure —
drops the schema again before the request returns. Nothing here ever
touches a real user's rows; the isolated schema is empty before the
restore and gone by the time the evidence row is written.

Per the design doc's scope boundary (§0), this is still envelope-mode
only — unchanged from Phase 1.

## New

- **`lib/schema-migrations.ts`** — the `MIGRATIONS` array that used to live
  as a 2,500-line local `const` inside `index.ts` is now its own module,
  exported. Pure extraction, no statement text changed, no behavior change
  to `index.ts`'s boot-time migration run (`waitForDbThenMigrate()` now
  imports it instead of declaring it inline). This is what makes Phase 2
  possible without a second, hand-maintained copy of every `CREATE TABLE`
  statement: since none of them schema-qualify their table names (see the
  design doc §1's "code advantage" callout), replaying this same array
  against a session with `search_path` pointed at an isolated schema
  recreates the whole table set there automatically.
- **`lib/dr-test-db.ts`** — the new isolated-schema infrastructure:
  - `createIsolatedSchema(testId)` — opens a **dedicated, non-pooled**
    `pg.Client` (not the app's `Pool` — `SET search_path` is
    session-scoped, and a pool would recycle that connection into an
    unrelated query later; see the file's header for the full reasoning),
    `CREATE SCHEMA dr_test_<timestamp>_<random>`, sets `search_path` on
    that session, and replays `MIGRATIONS` against it (same per-statement
    try/catch/log pattern `waitForDbThenMigrate()` already uses). Returns
    a drizzle instance bound to that same connection — this is the
    `dbOverride` the runner passes into `applyRestoreDiff()`.
  - `dropIsolatedSchema(iso)` — `DROP SCHEMA ... CASCADE` + closes the
    dedicated connection. Never throws (a cleanup failure is logged and
    reported back to the caller instead); designed to sit in a `finally`
    so a schema is never orphaned even when the restore itself failed
    partway through.
  - `countRows(iso, sqlTable)` — one `SELECT COUNT(*)` against the
    isolated schema's search_path, used for the record-count verification
    step.
  - `generateSchemaName()` — timestamp + random suffix, always a
    Postgres-identifier-safe name; every place that interpolates it into
    raw SQL re-validates the shape first as defense-in-depth, even though
    it's never derived from request input.

## Changed

- **`lib/vault-snapshot-restore.ts`** — `applyRestoreDiff(userId, snapshot,
  opts?)` now takes an optional `{ dbOverride }`. Every helper that used
  to close over the module-level `db` import
  (`existingVaultKeys`/`existingWalletKeys`/`existingRawKeys`/
  `existingTemplateKeys`/`existingMessageKeys`/`existingDataEntityKeys`)
  now takes that same handle as a parameter, defaulting to production
  `db` — so **every existing call site (the real restore route) is
  unchanged**, and only the DR runner's new call passes an override. Also
  exports `RESTORE_TABLE_SQL_NAMES` (`RestoreTableKey` → physical
  snake_case table name) so the runner's count-verification step doesn't
  need its own copy of that mapping.
- **`lib/dr-test-runner.ts`** — `runDrTest()` now runs a third stage after
  checksum + decrypt: restore into an isolated schema, then compare
  table-by-table row counts (`Array.isArray(snapshot[key]).length` vs.
  `countRows()` against the isolated schema) for every `RestoreTableKey`.
  A count mismatch on any single table fails the run at the
  `"verification"` stage — this is deliberately the same check that would
  catch `applyRestoreDiff()`'s own per-row insert errors (it collects and
  continues past bad rows rather than throwing), which a bare
  "did it throw?" check would miss. RTO (`rtoMs`) is measured from just
  after decrypt succeeds to just after verification completes — i.e. the
  actual time to bring a backup back to a queryable state — per the
  design doc §5's recommendation to baseline off real measured runs. The
  isolated schema is dropped in a `finally`, always, regardless of which
  stage failed.
- **`routes/dr-tests.ts`** — doc comments updated to describe the Phase 2
  flow. No route signature or response shape changed beyond what the
  richer `DrTestReport` (see below) already adds automatically — `POST
  /admin/dr-tests/run-now` still triggers one run synchronously and
  returns the report; `GET /admin/dr-tests` / `GET /admin/dr-tests/:id`
  are unchanged.
- **`lib/db/src/index.ts`** — `buildPoolConfig()` is now exported (was
  module-private), so `lib/dr-test-db.ts` can open its dedicated
  connection with the exact same `DATABASE_URL`/SSL/Supabase-pooler-port
  handling instead of re-deriving it. No behavior change to the existing
  `pool`/`db` exports.
- **`lib/db/src/schema/dr-test-reports.ts`** (migration 069) — `ALTER
  TABLE`-equivalent additions: `isolated_schema_name`, `restore_result`,
  `records_expected` (jsonb, keyed by `RestoreTableKey`),
  `records_restored` (jsonb, same keys), `rto_ms`. Everything from Phase 1
  is unchanged; `failure_stage` can now additionally be `"schema"`,
  `"restore"`, or `"verification"` (was only `"no_snapshot"` |
  `"checksum"` | `"decryption"`).

## Not done here (Phase 3)

- **No scheduler.** Nothing calls `runDrTest()` on a timer yet — every
  report today still comes from an admin hitting `POST
  /admin/dr-tests/run-now`. The `node-cron` sweep (same pattern as
  `lib/vault-backup-schedule-cron.ts`) is Phase 3, and `triggered_by` will
  start seeing `"scheduled"` values once it exists.
- **No dashboard page.** `GET /admin/dr-tests` and `GET /admin/dr-tests/:id`
  are still plain JSON — a `pages/admin/dr-health.tsx` UI (design doc §7)
  is Phase 3.
- **No alerting.** A failed run (at any stage — checksum, decryption,
  schema, restore, or verification) is only visible by checking the
  report (or the server logs / `logBus`) — the `notificationsTable` +
  `sendEmail` failure alert described in the design doc §6 is Phase 3.
- **No hash chain.** `report_hash`/`prev_report_hash`/`runner_version`
  still don't exist on `dr_test_reports` — Phase 3, alongside the
  scheduler and dashboard.
- Design doc §9's open question #1 (full vs. trimmed `MIGRATIONS` set for
  the isolated schema) is now effectively answered by this phase's actual
  implementation choice: **full**, unmodified — see `lib/dr-test-db.ts`'s
  header for why that's both the simplest and most realistic option, at
  the cost of each DR test being a little slower than a trimmed subset
  would be. Open questions #2 (`dr_test_reports` retention policy) and #3
  (per-user vs. representative-sample testing for multi-user vaults) are
  both still genuinely open — neither is resolved by this phase, since
  Phase 2 still only ever tests the single latest envelope-mode snapshot
  (same selection policy as Phase 1).

## Before running

- **Migration 069** must be applied by hand against Supabase before this
  deploys (`drizzle-kit push` from `lib/db`, same convention as migrations
  055–068 — not wired into `index.ts`'s boot-time `MIGRATIONS` array). Run
  it after 068.
- **No new env var.** The isolated-schema connection reuses
  `DATABASE_URL` via the now-exported `buildPoolConfig()` — same
  credentials, same SSL/pooler handling as every other connection this app
  opens.
- **Database privileges:** the `DATABASE_URL` role this app connects as
  must be allowed to `CREATE SCHEMA` / `DROP SCHEMA ... CASCADE` in
  addition to its existing table-level privileges. On a typical Supabase
  project the default connection role already has this; a locked-down
  custom role may need it granted explicitly before the first Phase 2 run
  (it will otherwise fail cleanly at the `"schema"` stage with the
  underlying Postgres permission error in `failureReason`, not silently).
- **A slower `run-now`.** Because a DR test now actually restores (not
  just decrypts), `POST /admin/dr-tests/run-now` takes noticeably longer
  than it did under Phase 1 — the full `MIGRATIONS` array runs against a
  fresh schema before restore even starts. This is expected; `rtoMs` on
  the resulting report is the actual number to look at, not a cause for
  concern on its own.
- If no envelope-mode snapshot exists yet, behavior is unchanged from
  Phase 1: `POST /admin/dr-tests/run-now` still succeeds as an HTTP call
  and records a `fail` report with `failure_stage = "no_snapshot"`.
