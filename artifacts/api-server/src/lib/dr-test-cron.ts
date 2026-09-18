/**
 * lib/dr-test-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DR Evidence Collector — Phase 3 (cron scheduling + alerting), the part
 * routes/dr-tests.ts and lib/dr-test-runner.ts explicitly left undone:
 * "The node-cron scheduler + admin dashboard + alerting + hash chain
 * (Phase 3) are deliberately NOT part of this module — this module is
 * called today only by an admin's manual 'Run DR Test' action."
 *
 * This file only adds the scheduler + alerting half of that (no dashboard,
 * no hash chain — those stay open per the design doc). Every check it runs
 * (checksum → decrypt → isolated-schema restore → record-count
 * verification) already existed in runDrTest(); this just calls it on a
 * timer instead of waiting for someone to click a button, which is the
 * whole point of a *disaster recovery* test — an admin needs to find out a
 * scheduled backup has become unrestorable BEFORE an actual disaster, not
 * whenever they next remember to check manually.
 *
 * Schedule is configurable via DR_TEST_CRON (standard 5-field cron syntax);
 * defaults to Sunday 05:00 server time — weekly, off-peak, and offset from
 * every other backup-adjacent cron (vault backup schedule sweep runs every
 * 15 minutes; vault/snapshot trash purges run at 03:00/03:30 daily) so a
 * DR test's isolated-schema restore never overlaps a live backup write.
 *
 * On failure, alerts every admin user by email — best-effort, one send per
 * admin, a delivery failure for one admin never blocks the others or the
 * report itself (which is already persisted by runDrTest() regardless).
 * This does not replace admin-facing surfaces to come later (a dashboard
 * per the design doc) — it just means a failure doesn't sit silent in
 * dr_test_reports until someone happens to look.
 */
import cron from "node-cron";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { runDrTest } from "./dr-test-runner";
import { sendEmail } from "./email";

let scheduled = false;

async function alertAdminsOfFailure(report: Awaited<ReturnType<typeof runDrTest>>): Promise<void> {
  const admins = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.role, "admin"));
  const subject = `⚠️ AYZEN DR test ${report.testId} failed`;
  const html = `
    <p>A scheduled disaster-recovery test failed at stage <b>${report.failureStage ?? "unknown"}</b>.</p>
    <p><b>Reason:</b> ${report.failureReason ?? "No further detail recorded."}</p>
    <p><b>Snapshot tested:</b> #${report.snapshotId} (encryption v${report.keyVersion ?? "?"})</p>
    <p>This means the most recent automatic vault backup may not currently be
       restorable. See <code>/admin/dr-tests/${report.id}</code> for full evidence,
       and the vault-backup disaster-recovery runbook for next steps.</p>
  `;
  for (const admin of admins) {
    try {
      await sendEmail({ to: admin.email, subject, html });
    } catch (err: any) {
      // A failed alert email is unfortunate but not the failure that
      // matters here — the report itself is already saved, and the next
      // admin in the loop should still get their email.
      logger.warn({ err, admin: admin.email }, "Failed to send DR test failure alert email");
    }
  }
}

async function runScheduledDrTest(): Promise<void> {
  const report = await runDrTest({ triggeredBy: "scheduled" });
  if (report.overallResult === "fail") {
    await alertAdminsOfFailure(report).catch((err) => {
      logger.error({ err }, "Failed to dispatch DR test failure alerts");
    });
  }
}

export function startDrTestCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.DR_TEST_CRON ?? "0 5 * * 0"; // Sunday 05:00, weekly
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "DR_TEST_CRON is not a valid cron expression — scheduled DR tests disabled");
    logBus.warn(`Scheduled DR test cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runScheduledDrTest().catch((err) => {
      logger.error({ err }, "Scheduled DR test run failed to complete");
      logBus.error(`Scheduled DR test failed to complete: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Scheduled DR test cron scheduled ("${expr}")`);
  logger.info({ expr }, "Scheduled DR test cron scheduled");
}
