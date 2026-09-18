import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/**
 * schema/dr-test-reports.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DR Evidence Collector — Phase 1 (Backup Integrity) + Phase 2 (Schema-
 * Isolated Restore). See dr-evidence-collector-design.md for the full
 * multi-phase design this table is drawn from (§3 Data Model).
 *
 * Phase 1 only ran the two checks that need no restore and no isolated
 * schema at all — verifyStoredChecksum() and envelopeDecryptBackup(), both
 * already implemented for the manual/scheduled backup paths — and recorded
 * the result here as evidence.
 *
 * Phase 2 (migration 069, hand-applied via `drizzle-kit push` — see
 * CHANGES_DR_EVIDENCE_PHASE2.md) ALTERs in the restore-related columns
 * below: isolated_schema_name / restore_result / records_expected /
 * records_restored / rto_ms, matching how this codebase grows other tables
 * incrementally (see vault_snapshots' *Count columns across migrations
 * 056-065) rather than pre-adding columns nothing wrote to yet. Everything
 * ABOVE the "Phase 2" comment marker below is unchanged from Phase 1.
 * report_hash/prev_report_hash/runner_version (the hash chain) are still
 * Phase 3's job.
 *
 * Like vault_snapshots and every other backup-adjacent table in this app,
 * this table NEVER stores plaintext/decrypted content — envelopeDecryptBackup()
 * is called only to prove it *can* succeed, and applyRestoreDiff() restores
 * into a throwaway schema that's dropped before this row is even written;
 * only counts, timestamps, pass/fail, and checksum/schema-name values are
 * recorded, matching the discipline already documented on vault_snapshots /
 * buildRestoreDiff().
 */
export const drTestReportsTable = pgTable("dr_test_reports", {
  id: serial("id").primaryKey(),

  // Human-readable evidence ID, e.g. "DR-2026-0001" — see
  // lib/dr-test-runner.ts's generateTestId(). Unique so a report can be
  // referenced/cited without leaking the internal serial id.
  testId: text("test_id").notNull().unique(),

  // "manual" (POST /admin/dr-tests/run-now) | "scheduled" (the weekly
  // lib/dr-test-cron.ts sweep).
  triggeredBy: text("triggered_by").notNull().default("manual"),

  // Which vault_snapshots row was tested. No DB-level FK constraint — same
  // convention the rest of this codebase uses for cross-table references
  // (see userId columns throughout); enforced at the application layer only.
  snapshotId: integer("snapshot_id").notNull(),

  // Always "envelope" for now — see dr-evidence-collector-design.md §0: an
  // automated DR test can only ever run against envelope-mode snapshots,
  // since password-mode backups need a user-typed password nothing
  // automated has access to.
  encryptionMode: text("encryption_mode").notNull().default("envelope"),

  // Which vault-backup-envelope.ts DEK version decrypted this snapshot.
  // Null if the run failed before decryption told us (e.g. checksum failed
  // first, so decryption was never attempted).
  keyVersion: integer("key_version"),

  // The vault_snapshots.checksum value being verified, copied here so a
  // report is self-contained evidence even if the underlying snapshot row
  // is later pruned by pruneOldSnapshots().
  backupChecksum: text("backup_checksum"),

  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),

  // "pass" | "fail" | "skipped" (skipped only if a prior stage already
  // failed — see runDrTest()'s short-circuit).
  checksumResult: text("checksum_result"),
  decryptionResult: text("decryption_result"),

  // ── Phase 2 (migration 069) ──────────────────────────────────────────
  // The dr_test_<run_id> schema this run restored into. Kept even after
  // the schema itself is dropped (see lib/dr-test-db.ts's
  // dropIsolatedSchema(), always called in a `finally`) — an audit trail
  // of exactly which throwaway schema a given report's numbers came from,
  // and useful to spot an orphaned schema that failed to clean up (its
  // name would appear here with no matching live schema in pg_namespace).
  isolatedSchemaName: text("isolated_schema_name"),
  // "pass" | "fail" | "skipped" (skipped if checksum/decryption already
  // failed, so restore was never attempted — see runDrTest()'s
  // short-circuit, same pattern checksumResult/decryptionResult use).
  restoreResult: text("restore_result"),
  // Table-by-table row counts, keyed by RestoreTableKey (see
  // lib/vault-snapshot-restore.ts): how many rows the snapshot JSON
  // contained for each restorable table, vs. how many actually landed in
  // the isolated schema after applyRestoreDiff(). Compared by
  // lib/dr-test-runner.ts to catch a restore that "succeeded" (no thrown
  // exception) but silently dropped or duplicated rows.
  recordsExpected: jsonb("records_expected"),
  recordsRestored: jsonb("records_restored"),
  // Milliseconds from decrypt-success to restore-and-verification-complete
  // (i.e. how long it actually took to bring this backup back to a
  // queryable state) — see dr-evidence-collector-design.md §5 on using
  // real measured runs as the RTO baseline instead of an assumed target.
  rtoMs: integer("rto_ms"),

  // Overall verdict for this run: "pass" only if every stage that ran
  // (checksum, decryption, and — once Phase 2 restore runs — schema
  // creation, restore, and record-count verification) passed.
  overallResult: text("overall_result").notNull(),

  // Which stage failed, when overallResult = "fail": "no_snapshot" |
  // "checksum" | "decryption" | "schema" | "restore" | "verification".
  // Null on pass.
  failureStage: text("failure_stage"),
  failureReason: text("failure_reason"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDrTestReportSchema = createInsertSchema(drTestReportsTable).omit({
  id: true, createdAt: true,
});
