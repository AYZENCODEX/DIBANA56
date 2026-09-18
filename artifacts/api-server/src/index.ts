import app from "./app";
import { logger } from "./lib/logger";
import { logBus } from "./lib/log-bus";
import { initTelegramBot, stopTelegramBot } from "./lib/telegram";
import { startUptimeBot } from "./services/uptime-bot";
import { startVaultHealthCron } from "./lib/vault-health-cron";
import { startVaultTrashCron } from "./lib/vault-trash-cron";
import { startEmergencyAccessCron } from "./lib/emergency-access-cron";
import { startDepositWatcher } from "./services/deposit-watcher";
import { startAirdropReminderCron } from "./lib/airdrop-reminder-cron";
import { startFinanceRecurringCron } from "./lib/finance-recurring-cron";
import { startFinanceReminderCron } from "./lib/finance-reminder-cron";
import { startFinanceNetWorthCron } from "./lib/finance-networth-cron";
import { startFinanceDigestCron } from "./lib/finance-digest-cron";
import { startFinanceReportScheduleCron } from "./lib/finance-report-schedule-cron";
import { startFinanceInvoiceReminderCron } from "./lib/finance-invoice-reminder-cron";
import { startFinanceLateFeeCron } from "./lib/finance-late-fee-cron";
import { startMailScheduleCron } from "./lib/mail-schedule-cron";
import { startMailDigestCron } from "./lib/mail-notification-digest";
import { startVaultBackupScheduleCron, startVaultBackupMissedWatchdog } from "./lib/vault-backup-schedule-cron";
import { startVaultSnapshotTrashCron } from "./lib/vault-snapshot-trash-cron";
import { startDrTestCron } from "./lib/dr-test-cron";
import { startVaultBackupKeyRotationCron } from "./lib/vault-backup-key-rotation-cron";
import { startSendQueueWorker } from "./lib/mail-send-queue";
// OIDC Roadmap — Season 3, Phase 6e-c (Failure Handling): the backchannel
// logout retry queue's own worker, same "one cron.schedule call per
// durable queue" registration convention every other worker below uses.
import { startBackchannelLogoutQueueWorker } from "./lib/oidc-logout-propagation";
// Mega Engine — Phase 8 blueprint, Part A: Core Event Bus. Same
// "one cron.schedule call per durable queue" registration convention as
// every worker above — see lib/event-bus/dispatcher.ts's header.
import { startEventBusDispatcher } from "./lib/event-bus";
// Mega Engine — Phase 8 blueprint, Part B1: Scheduler core.
import { startSchedulerWorker } from "./lib/scheduler";
// Mega Engine — Phase 8 blueprint, Part E3: §60 Retention / §57-E cleanup.
import { registerRetentionSweepSchedule } from "./lib/mega-engine";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { MIGRATIONS } from "./lib/schema-migrations";

const rawPort = process.env["AYZEN_API_PORT"] ?? process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid port value: "${rawPort}"`);
}

async function waitForDbThenMigrate(): Promise<void> {
  logBus.system("DB probe started — waiting for connection...");
  let attempts = 0;
  while (true) {
    try {
      await db.execute(sql`SELECT 1`);
      break;
    } catch (err: any) {
      attempts++;
      if (attempts % 5 === 0) {
        logBus.warn(`DB still offline after ${attempts} probes: ${err?.message ?? err}`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  logBus.system("✅ Database connected — running startup migrations");
  for (const q of MIGRATIONS) {
    try {
      await db.execute(sql.raw(q));
      logBus.system(`Migration OK: ${q.replace("ALTER TABLE ", "").slice(0, 60)}`);
    } catch (err: any) {
      logger.warn({ err, q }, "Migration statement warning (column may already exist)");
      logBus.warn(`Migration skip (exists): ${q.slice(0, 60)}`);
    }
  }
  logBus.system("✅ All startup migrations complete");
  logger.info("Startup migrations complete");

  try {
    const { loadKeyManager, getActiveVersion } = await import("./lib/vault-crypto");
    await loadKeyManager();
    logBus.system(`✅ Vault field-encryption key manager loaded (active version v${getActiveVersion()})`);
  } catch (err: any) {
    // Not fatal — encryptField()/decryptField() fall back to the legacy key
    // until this succeeds, so writes/reads keep working either way.
    logger.warn({ err }, "Vault key manager load failed — falling back to legacy field key for now");
    logBus.warn(`Vault key manager load failed: ${err?.message ?? err}`);
  }

  try {
    const { loadWalletKeyManager, getActiveWalletKeyVersion } = await import("./lib/wallet-crypto");
    await loadWalletKeyManager();
    logBus.system(`✅ Wallet phrase-encryption key manager loaded (active version v${getActiveWalletKeyVersion()})`);
  } catch (err: any) {
    // Not fatal — encryptPhrase()/decryptPhrase() fall back to the legacy
    // key until this succeeds, so writes/reads keep working either way.
    logger.warn({ err }, "Wallet key manager load failed — falling back to legacy phrase key for now");
    logBus.warn(`Wallet key manager load failed: ${err?.message ?? err}`);
  }

  try {
    const { loadBackupEnvelopeKeyManager, getActiveBackupEnvelopeVersion } = await import("./lib/vault-backup-envelope");
    await loadBackupEnvelopeKeyManager();
    logBus.system(`✅ Vault backup envelope key manager loaded (active version v${getActiveBackupEnvelopeVersion()})`);
  } catch (err: any) {
    // Not fatal on its own, but automatic (scheduled) vault backups will fail
    // until this succeeds — manual, password-protected exports are unaffected.
    logger.warn({ err }, "Vault backup envelope key manager load failed — automatic backups will fail until this loads");
    logBus.warn(`Vault backup envelope key manager load failed: ${err?.message ?? err}`);
  }
}

// ── Mail retention: auto-delete synced mail_messages older than 30 days ────
async function purgeOldMail(): Promise<void> {
  try {
    const result: any = await db.execute(sql`DELETE FROM mail_messages WHERE created_at < NOW() - INTERVAL '30 days'`);
    const removed = result?.rowCount ?? result?.rows?.length ?? 0;
    if (removed) logBus.system(`Mail retention purge: removed ${removed} message(s) older than 30d`);
  } catch (err: any) {
    logger.warn({ err }, "Mail retention purge failed");
  }
}
setTimeout(purgeOldMail, 20000);
setInterval(purgeOldMail, 6 * 60 * 60 * 1000); // re-check every 6h

// ── Mail Hub: scheduled auto-sync — periodically pull new mail for every
// IMAP-configured account so the Mail Hub stays fresh without a manual
// "Sync" click. Runs a few minutes after boot, then every 20 minutes.
async function runScheduledMailSync(): Promise<void> {
  try {
    const { syncAllMailAccounts } = await import("./lib/mail-sync");
    const { synced, failed } = await syncAllMailAccounts();
    if (synced || failed) logBus.system(`Mail auto-sync: ${synced} account(s) synced, ${failed} failed`);
  } catch (err: any) {
    logger.warn({ err }, "Scheduled mail auto-sync failed");
  }
}
setTimeout(runScheduledMailSync, 60000);
setInterval(runScheduledMailSync, 20 * 60 * 1000); // every 20 minutes

setTimeout(waitForDbThenMigrate, 2000);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    logBus.error(`Server failed to start: ${(err as Error).message}`);
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logBus.system(`🚀 AYZEN API Server started on port ${port}`);
  initTelegramBot();
  startUptimeBot(port);
  startVaultHealthCron();
  startVaultTrashCron();
  startEmergencyAccessCron();
  startDepositWatcher();
  startAirdropReminderCron();
  startFinanceRecurringCron();
  startFinanceReminderCron();
  startFinanceNetWorthCron();
  startFinanceDigestCron();
  startFinanceReportScheduleCron();
  startFinanceInvoiceReminderCron();
  startFinanceLateFeeCron();
  startMailScheduleCron();
  startMailDigestCron();
  startVaultBackupScheduleCron();
  startVaultBackupMissedWatchdog();
  startVaultSnapshotTrashCron();
  startDrTestCron();
  startVaultBackupKeyRotationCron();
  startSendQueueWorker();
  startBackchannelLogoutQueueWorker();
  startEventBusDispatcher();
  startSchedulerWorker();
  // Mega Engine — Phase 8 blueprint, Part E3 (§57-E "cleanup" / §60
  // Retention). Registers the retention-sweep job handler and, if no
  // prior boot already scheduled it, its daily recurring job — must run
  // after startSchedulerWorker() so the worker claiming that job once
  // due is already ticking. Fire-and-forget: a failure here shouldn't
  // block the server from otherwise starting, same posture every other
  // best-effort boot step in this function already has (see
  // waitForDbThenMigrate()'s own retry loop above for the one step that
  // IS allowed to block).
  registerRetentionSweepSchedule().catch((err) => {
    logger.error({ err }, "mega_engine.retention_sweep.schedule_registration_failed");
  });

  // Graceful shutdown — stop Telegram polling before exit so the next start has no 409
  const shutdown = () => {
    stopTelegramBot().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
});
