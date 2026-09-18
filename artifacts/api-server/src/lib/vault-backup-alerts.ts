/**
 * lib/vault-backup-alerts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Backup hardening, Round 7 — alerting on top of Round 6's audit trail.
 *
 * Round 6 gave the app a record of every security-relevant backup event.
 * Nothing consumed it proactively — an admin (or the account owner) only
 * finds out something happened by going and looking. This closes that gap
 * for the two events where silence is most costly:
 *
 *   1. A backup is downloaded/restored from an IP this account has never
 *      used for that before (isAnomalousBackupIp(), lib/vault-backup-audit.ts)
 *      — the account owner gets an email. If a session token is stolen and
 *      used only to pull backups (never to log in fresh), Round 6 alone
 *      would still have silently logged it; this is what actually surfaces
 *      it to the person who can act on it.
 *   2. Automatic key rotation fails and the active DEK is left stale
 *      (lib/vault-backup-key-rotation-cron.ts's key_rotation_stale event)
 *      — every admin gets an email, same "who to notify" list and delivery
 *      discipline as lib/dr-test-cron.ts's existing failure alert.
 *
 * Round 8 — routine daily-backup outcome alerts. Rounds 6/7 only ever
 * alerted on something going WRONG (anomalous access, stale key). The
 * schedule cron itself (lib/vault-backup-schedule-cron.ts) already recorded
 * lastRunStatus/lastRunAt/lastRunError on every run, success or failure —
 * but that only surfaces if the account owner happens to open the Snapshot
 * Backup page. Nobody actually gets told "your backup ran today" or "your
 * backup failed today" unless they go looking. Two additions close that:
 *
 *   3. alertUserOfScheduledBackupResult — fired after EVERY automatic
 *      backup run, success or failure, over all three channels this app
 *      already uses together elsewhere (see lib/finance-notify.ts's
 *      notifyEntryCreated for the same in-app + Telegram + email pattern):
 *      the notification bell (website), Telegram (if linked), and email
 *      (always, since every account has one). This is the direct answer to
 *      "did my backup happen or not" — the owner is told either way,
 *      without having to check.
 *   4. alertUserOfMissedBackup — fired by the new watchdog sweep in
 *      lib/vault-backup-schedule-cron.ts for the case #3 can't cover: the
 *      schedule never even got attempted (the cron process was down, or
 *      otherwise stopped ticking) rather than attempted-and-failed. Without
 *      this, a stopped cron would look like nothing at all — no success
 *      alert, no failure alert, just silence — which is exactly the
 *      "did it happen or not" gap this closes.
 *
 * All four are best-effort and fire-and-forget from the caller's
 * perspective: a failed alert must never fail the request/job that
 * triggered it, and one channel's failure (bounced email, unlinked
 * Telegram, a Telegram API hiccup) must never block the others — same
 * discipline as alertAdminsOfFailure() in lib/dr-test-cron.ts.
 */
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendEmail } from "./email";
import { sendToUser } from "./telegram";
import { logger } from "./logger";
import { createNotification } from "../routes/notifications";

export async function alertOwnerOfAnomalousBackupAccess(
  userId: number,
  eventType: "snapshot_downloaded" | "snapshot_restored",
  ip: string,
): Promise<void> {
  try {
    const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
    if (!user?.email) return;

    const action = eventType === "snapshot_downloaded" ? "downloaded" : "restored";
    const subject = `⚠️ AYZEN — Vault backup ${action} from a new location`;
    const html = `
      <p>A vault backup on your account was just <b>${action}</b> from an IP
         address (<code>${ip}</code>) we haven't seen do that before.</p>
      <p>If this was you — a new device, a new network, a VPN — no action is
         needed. If it wasn't, we'd recommend rotating your account password
         and reviewing your Vault Backup activity log right away.</p>
      <p>See Snapshot Backup → Activity Log in the app for the full history.</p>
    `;
    await sendEmail({
      to: user.email, subject, html,
      text: `A vault backup on your account was just ${action} from a new IP address (${ip}). If this wasn't you, rotate your password and review your Vault Backup activity log.`,
    });
  } catch (err: any) {
    // Best-effort — never let a failed alert email affect the download/
    // restore that already succeeded, or the audit row that's already saved.
    logger.warn({ err, userId }, "Failed to send anomalous vault-backup-access alert email");
  }
}

export async function alertAdminsOfStaleKeyRotation(version: number, ageDays: number, error: string): Promise<void> {
  const admins = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.role, "admin"));
  const subject = `⚠️ AYZEN — Vault backup key rotation failed (key is ${ageDays}d old)`;
  const html = `
    <p>Automatic vault-backup DEK rotation (lib/vault-backup-key-rotation-cron.ts)
       attempted to rotate key <b>v${version}</b>, which is <b>${ageDays} days</b>
       past its rotation threshold, and failed.</p>
    <p><b>Error:</b> ${error}</p>
    <p>Existing scheduled backups keep working fine under the current key in
       the meantime — this is not a data-availability issue — but the key is
       now overdue for rotation. Rotate manually via
       <code>POST /admin/vault-backup/rotate-key</code> once the underlying
       issue is fixed, and check <code>/admin/vault-backup/key-status</code>
       for the current state.</p>
  `;
  for (const admin of admins) {
    try {
      await sendEmail({ to: admin.email, subject, html });
    } catch (err: any) {
      // Same discipline as lib/dr-test-cron.ts's alertAdminsOfFailure(): one
      // admin's bounced email never blocks sending to the rest.
      logger.warn({ err, admin: admin.email }, "Failed to send stale-key-rotation alert email");
    }
  }
}

// ─── Routine backup-outcome alerts (Round 8) ─────────────────────────────────

export interface ScheduledBackupOutcome {
  ok: boolean;
  snapshotId?: number;
  error?: string;
  // Best-effort headline numbers, for a one-line "what's in it" summary —
  // never the full per-domain breakdown, this is a notification not a report.
  entriesCount?: number;
  walletsCount?: number;
  destination?: string; // "store" | "email" | "webhook" | "google_drive" | "dropbox"
}

/**
 * Fired after every automatic vault-backup run — success or failure — from
 * lib/vault-backup-schedule-cron.ts's runVaultBackupSchedule(). Delivers the
 * outcome over every channel the user has: in-app bell (always), Telegram
 * (if linked), email (always). Never throws — the schedule row has already
 * been updated with lastRunStatus/lastRunError by the caller by the time
 * this runs, so a failed alert here never affects the backup outcome itself.
 */
export async function alertUserOfScheduledBackupResult(userId: number, outcome: ScheduledBackupOutcome): Promise<void> {
  try {
    const [user] = await db.select({
      email: usersTable.email, username: usersTable.username, telegramChatId: usersTable.telegramChatId,
    }).from(usersTable).where(eq(usersTable.id, userId));
    if (!user) return;

    const when = new Date().toLocaleString();
    const summary = outcome.ok
      ? `${outcome.entriesCount ?? 0} vault entries, ${outcome.walletsCount ?? 0} wallets`
      : null;

    if (outcome.ok) {
      const title = "✅ Automatic vault backup completed";
      const message = `Your scheduled backup ran successfully at ${when}.${summary ? ` (${summary})` : ""}`;
      createNotification(userId, "vault_backup_scheduled_result", title, message, {
        ok: true, snapshotId: outcome.snapshotId,
      }).catch(() => {});

      if (user.telegramChatId) {
        sendToUser(user.telegramChatId, [
          "✅ *Automatic Vault Backup Completed*",
          "",
          summary ? summary : "Your vault backup ran successfully.",
          `Time: ${when}`,
        ].join("\n")).catch(() => {});
      }

      if (user.email) {
        sendEmail({
          to: user.email,
          subject: "✅ AYZEN — Automatic vault backup completed",
          html: `
            <p>Hi <b>${user.username}</b>, your scheduled vault backup ran successfully at <b>${when}</b>.</p>
            ${summary ? `<p>${summary}</p>` : ""}
            <p>See Snapshot Backup → Stored Backups in the app any time to review or restore it.</p>
          `,
          text: `Your scheduled vault backup ran successfully at ${when}.${summary ? ` ${summary}.` : ""}`,
        }).catch(() => {});
      }
    } else {
      const title = "⚠️ Automatic vault backup failed";
      const message = `Your scheduled backup attempted to run at ${when} but failed: ${outcome.error ?? "Unknown error"}`;
      createNotification(userId, "vault_backup_scheduled_result", title, message, {
        ok: false, error: outcome.error,
      }).catch(() => {});

      if (user.telegramChatId) {
        sendToUser(user.telegramChatId, [
          "⚠️ *Automatic Vault Backup Failed*",
          "",
          `Time: ${when}`,
          `Error: ${outcome.error ?? "Unknown error"}`,
          "",
          "No data was lost — this only means today's automatic backup didn't complete. Check Snapshot Backup → Automatic Backups in the app.",
        ].join("\n")).catch(() => {});
      }

      if (user.email) {
        sendEmail({
          to: user.email,
          subject: "⚠️ AYZEN — Automatic vault backup failed",
          html: `
            <p>Hi <b>${user.username}</b>, your scheduled vault backup attempted to run at <b>${when}</b> but failed.</p>
            <p><b>Error:</b> ${outcome.error ?? "Unknown error"}</p>
            <p>No existing data was lost — this only means today's automatic backup didn't complete. The next attempt will happen on its normal schedule, or you can run one manually now from Snapshot Backup → Automatic Backups → Run Now.</p>
          `,
          text: `Your scheduled vault backup attempted to run at ${when} but failed: ${outcome.error ?? "Unknown error"}. Run one manually from Snapshot Backup → Automatic Backups → Run Now.`,
        }).catch(() => {});
      }
    }
  } catch (err: any) {
    logger.warn({ err, userId }, "Failed to send scheduled-backup-result alert");
  }
}

/**
 * Fired by lib/vault-backup-schedule-cron.ts's watchdog sweep when an
 * enabled schedule's nextRunAt has passed WATCHDOG_GRACE_MINUTES ago without
 * ever being picked up (running_since never set) — i.e. the sweep itself
 * stopped ticking (server down, cron misconfigured), not just a single run
 * failing. Without this, that situation is indistinguishable from "nothing
 * to report" — no success alert, no failure alert, just silence — which is
 * the exact gap this closes: the owner is told their daily backup did NOT
 * happen, even when nothing "failed" in the normal sense.
 */
export async function alertUserOfMissedBackup(userId: number, missedSinceMinutes: number): Promise<void> {
  try {
    const [user] = await db.select({
      email: usersTable.email, username: usersTable.username, telegramChatId: usersTable.telegramChatId,
    }).from(usersTable).where(eq(usersTable.id, userId));
    if (!user) return;

    const hours = Math.round(missedSinceMinutes / 60);
    const whenText = hours >= 1 ? `over ${hours}h` : `${missedSinceMinutes}m`;

    const title = "⚠️ Automatic vault backup did not run";
    const message = `Your scheduled vault backup was due ${whenText} ago and hasn't run yet — the backup scheduler may be stalled.`;
    createNotification(userId, "vault_backup_missed", title, message, { missedSinceMinutes }).catch(() => {});

    if (user.telegramChatId) {
      sendToUser(user.telegramChatId, [
        "⚠️ *Automatic Vault Backup Missed*",
        "",
        `Your scheduled backup was due ${whenText} ago and never ran.`,
        "You can trigger one manually from Snapshot Backup → Automatic Backups → Run Now while this is looked into.",
      ].join("\n")).catch(() => {});
    }

    if (user.email) {
      sendEmail({
        to: user.email,
        subject: "⚠️ AYZEN — Automatic vault backup did not run",
        html: `
          <p>Hi <b>${user.username}</b>, your scheduled vault backup was due <b>${whenText} ago</b> and hasn't run yet — this usually means the backup scheduler itself was interrupted, not that a backup was attempted and failed.</p>
          <p>You can trigger a backup manually right now from Snapshot Backup → Automatic Backups → Run Now, and your schedule will resume automatically at its next normal time.</p>
        `,
        text: `Your scheduled vault backup was due ${whenText} ago and hasn't run yet. Run one manually from Snapshot Backup → Automatic Backups → Run Now.`,
      }).catch(() => {});
    }
  } catch (err: any) {
    logger.warn({ err, userId }, "Failed to send missed-backup alert");
  }
}
