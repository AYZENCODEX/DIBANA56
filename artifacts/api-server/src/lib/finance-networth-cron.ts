/**
 * lib/finance-networth-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Once a month, snapshots every user's net worth (see lib/finance-networth.ts)
 * so the Net Worth trend chart has a point even for users who never click
 * "Snapshot now". Safe to re-run mid-month — snapshotNetWorth replaces the
 * current month's row rather than duplicating it.
 */
import cron from "node-cron";
import { snapshotNetWorthForAllUsers } from "./finance-networth";
import { logger } from "./logger";
import { logBus } from "./log-bus";

let scheduled = false;

export function startFinanceNetWorthCron() {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_NETWORTH_CRON ?? "30 0 1 * *"; // 00:30 on the 1st of each month
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_NETWORTH_CRON is not a valid cron expression — net worth snapshot cron disabled");
    logBus.warn(`Finance net-worth cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    snapshotNetWorthForAllUsers().then(({ usersSnapshotted }) => {
      logBus.system(`Net worth snapshot sweep: ${usersSnapshotted} user(s) snapshotted`);
    }).catch((err) => {
      logger.error({ err }, "Net worth snapshot sweep failed");
      logBus.error(`Net worth snapshot sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Finance net-worth snapshot cron scheduled ("${expr}")`);
  logger.info({ expr }, "Finance net-worth snapshot cron scheduled");
}
