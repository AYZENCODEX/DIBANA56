/**
 * lib/vault-trash-purge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Recycle-bin retention sweep for Vault entities. DELETE /vault/:id (see
 * routes/vault.ts) soft-deletes by setting deleted_at instead of removing the
 * row, so entries stay recoverable via POST /vault/:id/restore. This module
 * is what actually finishes the job: once an entry has sat in the trash
 * longer than VAULT_TRASH_RETENTION_DAYS (default 30), it's hard-deleted —
 * row removed, value_history purged, marketplace listing delisted, orphaned
 * ROI pruned — exactly like the old immediate-delete behavior did.
 *
 * Kept separate from routes/vault.ts so it's callable both from the cron
 * below and directly (e.g. an admin "run now" button) without importing the
 * whole router module.
 */

import { db, vaultEntriesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { syncOnVaultDelete } from "../services/sync";

export const VAULT_TRASH_RETENTION_DAYS = Number(process.env.VAULT_TRASH_RETENTION_DAYS ?? 30);

/**
 * Hard-deletes every vault entry whose deleted_at is older than the
 * retention window, across all users. Returns how many were purged.
 */
export async function purgeExpiredVaultTrash(): Promise<number> {
  const cutoff = new Date(Date.now() - VAULT_TRASH_RETENTION_DAYS * 86400000);

  const expired = await db.execute(
    sql`SELECT id, user_id FROM vault_entries WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`
  );
  const rows = expired.rows as { id: number; user_id: number }[];

  for (const row of rows) {
    try {
      await db.delete(vaultEntriesTable).where(eq(vaultEntriesTable.id, row.id));
      await db.execute(
        sql`DELETE FROM value_history WHERE user_id = ${row.user_id} AND source_type = 'vault' AND source_id = ${row.id}`
      );
      await syncOnVaultDelete(row.id);
    } catch (err: any) {
      logger.warn({ err, entryId: row.id }, "Vault trash purge failed for one entry — will retry next sweep");
      logBus.warn(`Vault trash purge failed for entry #${row.id}: ${err?.message ?? err}`);
    }
  }

  return rows.length;
}
