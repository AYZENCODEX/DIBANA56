/**
 * lib/emergency-access-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Cron wiring for scanForTriggeredEmergencyAccess() (see
 * emergency-access-scan.ts). Same pattern as vault-trash-cron.ts /
 * vault-health-cron.ts — schedule is configurable via
 * EMERGENCY_ACCESS_SCAN_CRON, defaults to once daily at 04:00 server time
 * (off-peak from the 03:00 trash purge and 09:00 health scan crons).
 */
import cron from "node-cron";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { scanForTriggeredEmergencyAccess } from "./emergency-access-scan";

let scheduled = false;

export function startEmergencyAccessCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.EMERGENCY_ACCESS_SCAN_CRON ?? "0 4 * * *";
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "EMERGENCY_ACCESS_SCAN_CRON is not a valid cron expression — emergency access scan disabled");
    logBus.warn(`Emergency access scan cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    scanForTriggeredEmergencyAccess()
      .then((count) => {
        if (count > 0) logBus.system(`🆘 Emergency access scan triggered ${count} new grant${count === 1 ? "" : "s"}`);
      })
      .catch((err) => {
        logger.error({ err }, "Emergency access scan failed");
        logBus.error(`Emergency access scan failed: ${err?.message ?? err}`);
      });
  });

  logBus.system(`✅ Emergency access scan cron scheduled ("${expr}")`);
  logger.info({ expr }, "Emergency access scan cron scheduled");
}
