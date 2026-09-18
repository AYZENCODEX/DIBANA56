/**
 * lib/vault-snapshot-trash-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Cron wiring for the vault-snapshot recycle-bin retention sweep (see
 * vault-snapshot-trash-purge.ts). Kept separate from the purge logic
 * itself, same reasoning as vault-trash-cron.ts next to
 * vault-trash-purge.ts.
 *
 * Schedule is configurable via VAULT_SNAPSHOT_TRASH_PURGE_CRON (standard
 * 5-field cron syntax); defaults to 03:30 server time daily — same hour as
 * the vault-entry trash sweep (vault-trash-cron.ts, 03:00) and the vault
 * health scan, offset by 30 minutes so they don't all fire at once.
 */

import cron from "node-cron";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { purgeExpiredVaultSnapshotTrash, VAULT_SNAPSHOT_TRASH_RETENTION_DAYS } from "./vault-snapshot-trash-purge";

let scheduled = false;

export function startVaultSnapshotTrashCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.VAULT_SNAPSHOT_TRASH_PURGE_CRON ?? "30 3 * * *";
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "VAULT_SNAPSHOT_TRASH_PURGE_CRON is not a valid cron expression — vault snapshot trash purge cron disabled");
    logBus.warn(`Vault snapshot trash purge cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    purgeExpiredVaultSnapshotTrash()
      .then((count) => {
        if (count > 0) logBus.system(`🗑️ Vault snapshot trash sweep purged ${count} expired backup${count === 1 ? "" : "s"}`);
      })
      .catch((err) => {
        logger.error({ err }, "Vault snapshot trash purge sweep failed");
        logBus.error(`Vault snapshot trash purge sweep failed: ${err?.message ?? err}`);
      });
  });

  logBus.system(`✅ Vault snapshot trash purge cron scheduled ("${expr}", retention ${VAULT_SNAPSHOT_TRASH_RETENTION_DAYS}d)`);
  logger.info({ expr, retentionDays: VAULT_SNAPSHOT_TRASH_RETENTION_DAYS }, "Vault snapshot trash purge cron scheduled");
}
