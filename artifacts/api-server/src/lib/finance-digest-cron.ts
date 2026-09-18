/**
 * lib/finance-digest-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Cron wiring for the Finance daily digest (see finance-notify.ts). Kept
 * separate from the sweep logic itself so it stays testable/callable on its
 * own, same split as vault-health-cron.ts / vault-health-scan.ts.
 *
 * Schedule is configurable via FINANCE_DIGEST_CRON (standard 5-field cron
 * syntax); defaults to 08:00 daily. Per-user delivery is additionally gated
 * by financeLastDigestSentAt (see runFinanceDailyDigest) so re-runs or a
 * wider cron window never double-send within the same ~24h.
 */
import cron from "node-cron";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { runFinanceDailyDigest } from "./finance-notify";

let scheduled = false;

export function startFinanceDigestCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.FINANCE_DIGEST_CRON ?? "0 8 * * *"; // 08:00 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_DIGEST_CRON is not a valid cron expression — finance digest cron disabled");
    logBus.warn(`Finance digest cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceDailyDigest().catch((err) => {
      logger.error({ err }, "Finance daily digest sweep failed");
      logBus.error(`Finance daily digest sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Finance daily digest cron scheduled ("${expr}")`);
  logger.info({ expr }, "Finance daily digest cron scheduled");
}
