/**
 * lib/vault-snapshot-trash-purge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Backup hardening — Snapshot Delete Protection.
 *
 * DELETE /vault/snapshots/:id (routes/vault-snapshot.ts) soft-deletes by
 * setting deleted_at instead of removing the row, so a stored backup stays
 * recoverable via POST /vault/snapshots/:id/restore. pruneOldSnapshots()
 * (the automatic MAX_STORED_SNAPSHOTS/quota prune that runs after every
 * export) does the same — an over-quota snapshot goes to the trash, not
 * straight to the void.
 *
 * This module is what actually finishes the job: once a trashed snapshot
 * has sat past VAULT_SNAPSHOT_TRASH_RETENTION_DAYS (default 14 — shorter
 * than vault_entries' 30-day trash, since these are backups of that data,
 * not the only copy of it), it's hard-deleted for real. Migration 072's
 * BEFORE DELETE trigger only allows that once deleted_at is at least 3 days
 * old, so this sweep's default window comfortably clears it.
 *
 * Same split as lib/vault-trash-purge.ts / lib/vault-trash-cron.ts: purge
 * logic lives here, cron wiring lives in vault-snapshot-trash-cron.ts, so
 * this stays callable on its own (e.g. an admin "run now" action) without
 * importing the scheduler.
 */
import { db, vaultSnapshotsTable } from "@workspace/db";
import { eq, and, isNotNull, lt } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";

export const VAULT_SNAPSHOT_TRASH_RETENTION_DAYS = Number(process.env.VAULT_SNAPSHOT_TRASH_RETENTION_DAYS ?? 14);

/**
 * Hard-deletes every vault_snapshots row whose deleted_at is older than the
 * retention window, across all users. Returns how many were purged.
 */
export async function purgeExpiredVaultSnapshotTrash(): Promise<number> {
  const cutoff = new Date(Date.now() - VAULT_SNAPSHOT_TRASH_RETENTION_DAYS * 86400000);

  const expired = await db
    .select({ id: vaultSnapshotsTable.id, userId: vaultSnapshotsTable.userId })
    .from(vaultSnapshotsTable)
    .where(and(isNotNull(vaultSnapshotsTable.deletedAt), lt(vaultSnapshotsTable.deletedAt, cutoff)));

  let purged = 0;
  for (const row of expired) {
    try {
      await db.delete(vaultSnapshotsTable).where(eq(vaultSnapshotsTable.id, row.id));
      purged++;
    } catch (err: any) {
      // The migration-072 trigger throws if deleted_at somehow isn't old
      // enough yet (shouldn't happen given the cutoff query above, but a
      // clock skew or a race with a very recent manual restore+re-delete
      // could in principle hit it) — log and let the next sweep retry,
      // same failure handling as vault-trash-purge.ts.
      logger.warn({ err, snapshotId: row.id }, "Vault snapshot trash purge failed for one row — will retry next sweep");
      logBus.warn(`Vault snapshot trash purge failed for backup #${row.id}: ${err?.message ?? err}`);
    }
  }

  return purged;
}
