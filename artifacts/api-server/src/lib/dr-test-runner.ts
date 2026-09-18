/**
 * lib/dr-test-runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DR Evidence Collector — Phase 1 (Backup Integrity) + Phase 2
 * (Schema-Isolated Restore). See dr-evidence-collector-design.md for the
 * full multi-phase design this is Phase 1+2 of.
 *
 * Runs, in order, every check that doesn't need a user-typed password:
 *   1. Checksum verify — verifyStoredChecksum() (routes/vault-snapshot.ts),
 *      already used by the download/restore-preview paths, just called here
 *      as an evidence-generating step instead of inline in a request.
 *   2. Decrypt — envelopeDecryptBackup() (lib/vault-backup-envelope.ts). The
 *      decrypted plaintext is parsed to JSON so restore (step 3) can run
 *      against it, but is NEVER logged, returned, or persisted anywhere
 *      beyond this function's own local variables — dropped as soon as the
 *      run finishes (pass or fail).
 *   3. Restore into an isolated schema (Phase 2, lib/dr-test-db.ts) —
 *      createIsolatedSchema() stands up a throwaway dr_test_<run_id>
 *      schema with the full production table set, applyRestoreDiff() (with
 *      a dbOverride pointed at that schema) restores the decrypted
 *      snapshot into it, and a table-by-table record-count comparison
 *      (snapshot array lengths vs. isolated-schema SELECT COUNT(*))
 *      confirms nothing silently got lost. The schema is ALWAYS dropped in
 *      a `finally`, whether or not everything before it succeeded.
 *
 * Per dr-evidence-collector-design.md §0, this only ever tests envelope-mode
 * (scheduled) snapshots. Password-mode backups need a user-typed password
 * nothing automated has access to — that stays a manual, owner-triggered
 * check, untouched here.
 *
 * The node-cron scheduler + admin dashboard + alerting + hash chain
 * (Phase 3) are deliberately NOT part of this module — see the design
 * doc's phased rollout plan (§8). This module is called today only by an
 * admin's manual "Run DR Test" action (routes/dr-tests.ts).
 */
import { db, vaultSnapshotsTable, drTestReportsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { verifyStoredChecksum } from "../routes/vault-snapshot";
import { envelopeDecryptBackup } from "./vault-backup-envelope";
import { applyRestoreDiff, RESTORE_TABLE_SQL_NAMES, type RestoreTableKey } from "./vault-snapshot-restore";
import { createIsolatedSchema, dropIsolatedSchema, countRows, type IsolatedSchema } from "./dr-test-db";
import { logActivity } from "./activity";
import { logger } from "./logger";
import { logBus } from "./log-bus";

export type DrTestReport = typeof drTestReportsTable.$inferSelect;

const RESTORE_TABLE_KEYS = Object.keys(RESTORE_TABLE_SQL_NAMES) as RestoreTableKey[];

/**
 * Builds a human-readable evidence ID like "DR-2026-0001" — sequential
 * within the current calendar year (counts existing rows for that year, not
 * a DB sequence, since this only needs to be readable/roughly-ordered
 * evidence, not a strict guarantee — a race between two simultaneous manual
 * triggers is vanishingly unlikely and harmless even if it happened, since
 * test_id's only job is human readability; the real primary key is `id`).
 */
async function generateTestId(): Promise<string> {
  const year = new Date().getFullYear();
  const result: any = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM dr_test_reports
    WHERE test_id LIKE ${`DR-${year}-%`}
  `);
  const rows: any[] = result.rows ?? result;
  const seq = (Number(rows[0]?.count) || 0) + 1;
  return `DR-${year}-${String(seq).padStart(4, "0")}`;
}

/** Picks the snapshot an automated DR test runs against — see design doc §2 and open question #3. */
async function selectSnapshotToTest(): Promise<typeof vaultSnapshotsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(vaultSnapshotsTable)
    .where(eq(vaultSnapshotsTable.encryptionMode, "envelope"))
    .orderBy(desc(vaultSnapshotsTable.createdAt))
    .limit(1);
  return row ?? null;
}

/** Table-by-table row counts for every RestoreTableKey the snapshot JSON carries — used both as the "expected" side of the verification-suite comparison and (against the isolated schema, via countRows()) the "restored" side. */
function countSnapshotRows(snapshot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of RESTORE_TABLE_KEYS) {
    const arr = snapshot?.[key];
    counts[key] = Array.isArray(arr) ? arr.length : 0;
  }
  return counts;
}

async function countIsolatedSchemaRows(iso: Pick<IsolatedSchema, "client">): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const key of RESTORE_TABLE_KEYS) {
    counts[key] = await countRows(iso, RESTORE_TABLE_SQL_NAMES[key]);
  }
  return counts;
}

/** True only if every table's restored count matches its expected count exactly — a mismatch in either direction (fewer rows landed, or somehow more) fails verification. */
function countsMatch(expected: Record<string, number>, restored: Record<string, number>): boolean {
  return RESTORE_TABLE_KEYS.every((key) => expected[key] === restored[key]);
}

export interface RunDrTestInput {
  triggeredBy?: "manual" | "scheduled";
  // Admin user id, for the activity-log audit trail only — never written to
  // dr_test_reports itself (that table is evidence about the backup, not
  // about who clicked the button).
  adminUserId?: number | null;
}

/**
 * Runs one DR test end to end (checksum → decrypt → isolated-schema restore
 * → record-count verification → cleanup) and stores the evidence row.
 * Never throws — every failure mode (no snapshot to test, checksum
 * mismatch, decryption failure, isolated-schema/restore/verification
 * failure) is captured as a "fail" report instead, since a thrown error
 * would mean no evidence got recorded for the very failure that matters
 * most.
 */
export async function runDrTest(input: RunDrTestInput = {}): Promise<DrTestReport> {
  const triggeredBy = input.triggeredBy ?? "manual";
  const startedAt = new Date();
  const testId = await generateTestId();

  const snapshot = await selectSnapshotToTest();
  if (!snapshot) {
    const [report] = await db.insert(drTestReportsTable).values({
      testId,
      triggeredBy,
      snapshotId: 0,
      encryptionMode: "envelope",
      startedAt,
      completedAt: new Date(),
      overallResult: "fail",
      failureStage: "no_snapshot",
      failureReason: "No envelope-mode (scheduled) vault snapshot exists yet to test.",
    }).returning();
    logBus.warn(`DR test ${testId}: no envelope-mode snapshot available to test`);
    return report;
  }

  let checksumResult: "pass" | "fail" = "pass";
  let decryptionResult: "pass" | "fail" | null = null;
  let restoreResult: "pass" | "fail" | "skipped" | null = null;
  let failureStage: string | null = null;
  let failureReason: string | null = null;
  let isolatedSchemaName: string | null = null;
  let recordsExpected: Record<string, number> | null = null;
  let recordsRestored: Record<string, number> | null = null;
  let rtoMs: number | null = null;

  try {
    verifyStoredChecksum(snapshot);
  } catch (err: any) {
    checksumResult = "fail";
    failureStage = "checksum";
    failureReason = err?.message ?? "Checksum verification failed";
  }

  let decryptedSnapshot: any = null;

  if (checksumResult === "pass") {
    try {
      const plaintext = await envelopeDecryptBackup(snapshot.blob, snapshot.userId);
      // Parsed only into a local variable for restore (step 3) below —
      // never logged, returned, or persisted. Dropped when this function
      // returns, same as Phase 1.
      decryptedSnapshot = JSON.parse(plaintext);
      decryptionResult = "pass";
    } catch (err: any) {
      decryptionResult = "fail";
      failureStage = "decryption";
      failureReason = err?.message ?? "Decryption failed";
    }
  }

  // ── Phase 2: restore into an isolated schema + verify record counts ────
  if (decryptionResult === "pass") {
    const restoreStartedAt = Date.now();
    let iso: IsolatedSchema | null = null;
    try {
      iso = await createIsolatedSchema(testId);
      isolatedSchemaName = iso.schemaName;

      if (iso.migrationErrors.length > 0) {
        restoreResult = "fail";
        failureStage = "schema";
        failureReason = `${iso.migrationErrors.length} migration statement(s) failed while standing up the isolated schema (first: ${iso.migrationErrors[0].message})`;
      } else {
        const userIdForRestore = Number(decryptedSnapshot?.userId ?? snapshot.userId);
        await applyRestoreDiff(userIdForRestore, decryptedSnapshot, { dbOverride: iso.db });

        recordsExpected = countSnapshotRows(decryptedSnapshot);
        recordsRestored = await countIsolatedSchemaRows(iso);

        if (countsMatch(recordsExpected, recordsRestored)) {
          restoreResult = "pass";
        } else {
          restoreResult = "fail";
          failureStage = "verification";
          failureReason = "Restored record counts did not match the snapshot's own counts for at least one table — see recordsExpected/recordsRestored.";
        }
      }
    } catch (err: any) {
      restoreResult = "fail";
      failureStage = failureStage ?? "restore";
      failureReason = failureReason ?? (err?.message ?? "Restore into isolated schema failed");
    } finally {
      rtoMs = Date.now() - restoreStartedAt;
      if (iso) {
        const cleanup = await dropIsolatedSchema(iso);
        if (!cleanup.ok) {
          // Cleanup failing doesn't change the pass/fail verdict already
          // decided above (the restore itself may well have succeeded) —
          // but it's real evidence an admin should see, so it's folded
          // into failureReason rather than silently swallowed, without
          // overwriting a more specific restore/verification failure that
          // may already be set.
          failureReason = failureReason
            ? `${failureReason} (additionally, isolated-schema cleanup failed: ${cleanup.error})`
            : `Restore succeeded, but isolated-schema cleanup failed: ${cleanup.error}`;
        }
      }
    }
  } else if (checksumResult === "pass") {
    // Decryption failed — restore was never attempted.
    restoreResult = "skipped";
  }

  const overallResult =
    checksumResult === "pass" && decryptionResult === "pass" && restoreResult === "pass"
      ? "pass" : "fail";
  const completedAt = new Date();

  const [report] = await db.insert(drTestReportsTable).values({
    testId,
    triggeredBy,
    snapshotId: snapshot.id,
    encryptionMode: "envelope",
    keyVersion: snapshot.encryptionVersion ?? null,
    backupChecksum: snapshot.checksum,
    startedAt,
    completedAt,
    checksumResult,
    decryptionResult,
    isolatedSchemaName,
    restoreResult,
    recordsExpected: recordsExpected as any,
    recordsRestored: recordsRestored as any,
    rtoMs,
    overallResult,
    failureStage,
    failureReason,
  }).returning();

  if (input.adminUserId) {
    await logActivity(input.adminUserId, "dr_test_run", "dr_test_report", report.id, testId, {
      overallResult, snapshotId: snapshot.id, triggeredBy, rtoMs,
    });
  }

  if (overallResult === "pass") {
    logBus.system(`DR test ${testId} passed (snapshot #${snapshot.id}, restore verified in ${rtoMs}ms)`);
  } else {
    logger.warn({ testId, snapshotId: snapshot.id, failureStage, failureReason }, "DR test failed");
    logBus.error(`DR test ${testId} FAILED at ${failureStage}: ${failureReason}`);
  }

  return report;
}
