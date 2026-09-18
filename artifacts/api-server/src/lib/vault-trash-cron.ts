/**
 * lib/vault-trash-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Cron wiring for the Vault recycle-bin retention sweep (see
 * vault-trash-purge.ts). Kept separate from the purge logic itself, same
 * reasoning as vault-health-cron.ts next to vault-health-scan.ts — so the
 * sweep stays testable/callable on its own without touching the scheduler.
 *
 * Schedule is configurable via VAULT_TRASH_PURGE_CRON (standard 5-field cron
 * syntax); defaults to 03:00 server time daily, off-peak from the 09:00
 * health-scan cron.
 */

import cron from "node-cron";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { purgeExpiredVaultTrash, VAULT_TRASH_RETENTION_DAYS } from "./vault-trash-purge";

let scheduled = false;

export function startVaultTrashCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.VAULT_TRASH_PURGE_CRON ?? "0 3 * * *";
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "VAULT_TRASH_PURGE_CRON is not a valid cron expression — trash purge cron disabled");
    logBus.warn(`Vault trash purge cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    purgeExpiredVaultTrash()
      .then((count) => {
        if (count > 0) logBus.system(`🗑️ Vault trash sweep purged ${count} expired entr${count === 1 ? "y" : "ies"}`);
      })
      .catch((err) => {
        logger.error({ err }, "Vault trash purge sweep failed");
        logBus.error(`Vault trash purge sweep failed: ${err?.message ?? err}`);
      });
  });

  logBus.system(`✅ Vault trash purge cron scheduled ("${expr}", retention ${VAULT_TRASH_RETENTION_DAYS}d)`);
  logger.info({ expr, retentionDays: VAULT_TRASH_RETENTION_DAYS }, "Vault trash purge cron scheduled");
}
