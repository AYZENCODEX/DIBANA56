/**
 * lib/vault-backup-schedule-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Automatic Vault Backups.
 *
 * Sweeps vault_backup_schedules every VAULT_BACKUP_SCHEDULE_CRON interval
 * (default every 15 minutes) for rows where `enabled` and `nextRunAt <= now`.
 * For each due schedule:
 *   1. Builds the same full-vault snapshot the manual export button does
 *      (routes/vault-snapshot.ts's buildVaultSnapshotPayload()).
 *   2. Encrypts it under the server-managed envelope key instead of a
 *      password (lib/vault-backup-envelope.ts) — nobody's present to type
 *      one on a timer.
 *   3. Stores it as a vault_snapshots row (source = "scheduled") via the
 *      same storeSnapshotRow() the manual export path uses, so it shows up
 *      in "Stored Backups" and is pruned by the same MAX_STORED_SNAPSHOTS
 *      rule as manual ones.
 *   4. If the schedule has an off-vault destination configured (email or
 *      webhook), also delivers it there (lib/vault-backup-delivery.ts).
 *   5. Updates lastRunAt/lastRunStatus/nextRunAt so the next sweep knows
 *      it's not due again until the next interval.
 *
 * A failed run still advances nextRunAt (rather than retrying every sweep
 * forever) — the failure is visible via lastRunStatus/lastRunError on the
 * Automatic Backups card, and the next scheduled attempt will simply try
 * again at its normal cadence.
 *
 * Round 8 — every run (success or failure) now also fires
 * alertUserOfScheduledBackupResult() (lib/vault-backup-alerts.ts): in-app
 * notification + Telegram (if linked) + email, every time, not just on
 * failure. This is the direct "did my backup happen or not" answer the
 * lastRunStatus column alone couldn't give unless someone opened the page.
 *
 * A second, independent watchdog (startVaultBackupMissedWatchdog /
 * sweepMissedSchedules, below) covers the case the per-run alert above
 * can't: the sweep itself silently stops ticking (server down, cron
 * misconfigured) so no run — successful or failed — is ever attempted.
 * That would otherwise look like total silence: no success alert, no
 * failure alert. The watchdog runs on its own slower cadence and flags any
 * enabled schedule whose nextRunAt is more than WATCHDOG_GRACE_MINUTES
 * overdue with no in-flight run, alerts the owner via
 * alertUserOfMissedBackup(), and self-heals nextRunAt so it doesn't
 * re-alert on every tick.
 */
import cron from "node-cron";
import { eq, and, lte, isNull, or, lt } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { db, vaultBackupSchedulesTable, usersTable } from "@workspace/db";
import { buildVaultSnapshotPayload, storeSnapshotRow } from "../routes/vault-snapshot";
import { envelopeEncryptBackup } from "./vault-backup-envelope";
import { deliverSnapshot } from "./vault-backup-delivery";
import { logActivity } from "./activity";
import { alertUserOfScheduledBackupResult, alertUserOfMissedBackup } from "./vault-backup-alerts";

let scheduled = false;
let watchdogScheduled = false;

type ScheduleRow = typeof vaultBackupSchedulesTable.$inferSelect;

// If a run's running_since lock is older than this, treat it as abandoned
// (e.g. the server crashed mid-run) and let a later sweep reclaim the row,
// rather than leaving the schedule wedged forever.
const STALE_LOCK_MINUTES = Number(process.env.VAULT_BACKUP_SCHEDULE_STALE_LOCK_MINUTES ?? 60);

/** Computes the next run time strictly after `from`, per the schedule's frequency/day/hour settings. */
export function computeNextRunAt(s: Pick<ScheduleRow, "frequency" | "dayOfWeek" | "dayOfMonth" | "hourOfDay">, from: Date): Date {
  const hour = Math.min(Math.max(s.hourOfDay, 0), 23);
  const next = new Date(from);
  next.setSeconds(0, 0);

  if (s.frequency === "daily") {
    next.setHours(hour, 0, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (s.frequency === "monthly") {
    const day = Math.min(Math.max(s.dayOfMonth, 1), 28); // capped so every month has this day
    next.setDate(day);
    next.setHours(hour, 0, 0, 0);
    if (next <= from) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(day);
    }
    return next;
  }

  // "weekly" (default/fallback)
  const targetDow = Math.min(Math.max(s.dayOfWeek, 0), 6);
  next.setHours(hour, 0, 0, 0);
  let diff = (targetDow - next.getDay() + 7) % 7;
  if (diff === 0 && next <= from) diff = 7;
  next.setDate(next.getDate() + diff);
  return next;
}

/** Runs one schedule immediately, regardless of its nextRunAt — used by both the sweep and the "Run Now" button. */
export async function runVaultBackupSchedule(s: ScheduleRow): Promise<{ ok: boolean; snapshotId?: number; error?: string }> {
  const now = new Date();
  try {
    const { json, vaultCount, walletsCount, mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount } = await buildVaultSnapshotPayload(s.userId, s.includeAttachments);
    const { blob, version } = await envelopeEncryptBackup(json, s.userId);
    const { id } = await storeSnapshotRow({
      userId: s.userId,
      label: `Automatic backup — ${now.toLocaleDateString()}`,
      blob,
      includeAttachments: s.includeAttachments,
      entriesCount: vaultCount,
      walletsCount,
      mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount,
      source: "scheduled",
      encryptionMode: "envelope",
      encryptionVersion: version,
    });

    let deliveryError: string | undefined;
    if (s.destination !== "store") {
      let destinationEmail = s.destinationEmail;
      if (s.destination === "email" && !destinationEmail) {
        const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, s.userId));
        destinationEmail = user?.email ?? null;
      }
      const result = await deliverSnapshot(s.userId, {
        destination: s.destination as "email" | "webhook" | "google_drive" | "dropbox",
        email: destinationEmail,
        webhookUrl: s.webhookUrl,
        webhookSecret: s.webhookSecret,
      }, {
        id, label: s.destination === "email" ? "Automatic backup" : null, blob,
        sizeBytes: Buffer.byteLength(blob, "utf8"), entriesCount: vaultCount, walletsCount, createdAt: now,
      });
      if (result && !result.ok) deliveryError = result.error;
    }

    await logActivity(s.userId, "vault_backup_scheduled_run", "vault_snapshot", id, null, {
      entries: vaultCount, wallets: walletsCount, destination: s.destination,
    });

    await db.update(vaultBackupSchedulesTable).set({
      lastRunAt: now,
      lastRunStatus: "success",
      lastRunError: deliveryError ? `Backup stored, but delivery failed: ${deliveryError}` : null,
      nextRunAt: computeNextRunAt(s, now),
      runningSince: null,
      updatedAt: now,
    }).where(eq(vaultBackupSchedulesTable.id, s.id));

    // Round 8 — tell the owner it happened, on every channel they have,
    // regardless of outcome. If off-vault delivery failed but the backup
    // itself was still stored fine, that's noted as the "error" so the
    // alert doesn't wrongly read as a full success.
    alertUserOfScheduledBackupResult(s.userId, {
      ok: !deliveryError,
      snapshotId: id,
      error: deliveryError ? `Backup stored, but delivery failed: ${deliveryError}` : undefined,
      entriesCount: vaultCount,
      walletsCount,
      destination: s.destination,
    }).catch(() => {});

    return { ok: true, snapshotId: id };
  } catch (err: any) {
    const message = err?.message ?? "Unknown error";
    await db.update(vaultBackupSchedulesTable).set({
      lastRunAt: now, lastRunStatus: "failed", lastRunError: message,
      nextRunAt: computeNextRunAt(s, now), runningSince: null, updatedAt: now,
    }).where(eq(vaultBackupSchedulesTable.id, s.id)).catch(() => {});
    alertUserOfScheduledBackupResult(s.userId, { ok: false, error: message }).catch(() => {});
    return { ok: false, error: message };
  }
}

/**
 * Atomically claims a due schedule row for this sweep tick by setting
 * running_since, but only if it isn't already claimed by a still-running
 * sweep (running_since IS NULL), or its lock is stale (older than
 * STALE_LOCK_MINUTES, meaning a previous run likely crashed without
 * clearing it). Returns the claimed row, or null if another in-flight sweep
 * already owns it — this is the overlap guard: without it, a run that takes
 * longer than the cron interval would still be sitting on nextRunAt <= now
 * and get picked up again by the next tick, firing a duplicate backup and
 * duplicate email/webhook/cloud delivery.
 */
async function claimSchedule(id: number, now: Date): Promise<ScheduleRow | null> {
  const staleCutoff = new Date(now.getTime() - STALE_LOCK_MINUTES * 60_000);
  const [claimed] = await db.update(vaultBackupSchedulesTable)
    .set({ runningSince: now })
    .where(and(
      eq(vaultBackupSchedulesTable.id, id),
      or(isNull(vaultBackupSchedulesTable.runningSince), lt(vaultBackupSchedulesTable.runningSince, staleCutoff)),
    ))
    .returning();
  return claimed ?? null;
}

async function sweepDueSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select().from(vaultBackupSchedulesTable)
    .where(and(eq(vaultBackupSchedulesTable.enabled, true), lte(vaultBackupSchedulesTable.nextRunAt, now)));

  for (const s of due) {
    const claimed = await claimSchedule(s.id, now);
    if (!claimed) {
      // Already running from a previous, still-in-flight sweep tick — skip
      // it this time instead of starting a duplicate run.
      logBus.system(`Skipping automatic vault backup for user ${s.userId}: previous run still in progress`);
      continue;
    }

    const result = await runVaultBackupSchedule(claimed);
    if (result.ok) {
      logBus.system(`Automatic vault backup completed for user ${s.userId} (snapshot #${result.snapshotId})`);
    } else {
      logger.error({ err: result.error, userId: s.userId }, "Scheduled vault backup failed");
      logBus.error(`Automatic vault backup failed for user ${s.userId}: ${result.error}`);
    }
  }
}

export function startVaultBackupScheduleCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.VAULT_BACKUP_SCHEDULE_CRON ?? "*/15 * * * *"; // every 15 minutes
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "VAULT_BACKUP_SCHEDULE_CRON is not a valid cron expression — automatic vault backups disabled");
    logBus.warn(`Vault backup schedule cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    sweepDueSchedules().catch((err) => {
      logger.error({ err }, "Vault backup schedule sweep failed");
      logBus.error(`Vault backup schedule sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Automatic vault backup cron scheduled ("${expr}")`);
  logger.info({ expr }, "Vault backup schedule cron scheduled");
}

// ─── Missed-backup watchdog (Round 8) ────────────────────────────────────────
//
// sweepDueSchedules() above only ever reports on a run it actually
// attempted. If the cron process itself stops ticking (server down,
// deployment gap, VAULT_BACKUP_SCHEDULE_CRON misconfigured after a config
// change) an enabled schedule's nextRunAt just sits in the past forever —
// no run happens, so neither the success nor the failure alert in
// runVaultBackupSchedule() ever fires. That silence is indistinguishable
// from "nothing to report" unless something else is watching for it.
//
// This sweep runs on its own, slower, independent cadence and flags any
// enabled schedule whose nextRunAt is more than WATCHDOG_GRACE_MINUTES
// overdue AND isn't currently claimed by an in-flight run (running_since
// null) — i.e. it was due, and nothing has even tried yet. It then:
//   1. Alerts the owner via alertUserOfMissedBackup() — Telegram + email +
//      in-app, same three channels as a normal run's outcome alert.
//   2. Advances nextRunAt (via the same computeNextRunAt() the normal path
//      uses) so the NEXT watchdog tick doesn't re-alert for the same miss
//      forever, and records lastRunStatus="missed" so the Automatic
//      Backups card reflects it too — this self-heals the schedule back
//      onto its normal cadence once the underlying sweep is healthy again.
// The grace window is intentionally wider than the normal sweep interval
// (default: 3x it) so a single slow tick or brief restart never triggers a
// false "missed" alert — this is for genuine multi-tick silence, not
// jitter.
const DEFAULT_WATCHDOG_GRACE_MINUTES = 45;
const WATCHDOG_GRACE_MINUTES = Number(process.env.VAULT_BACKUP_WATCHDOG_GRACE_MINUTES) || DEFAULT_WATCHDOG_GRACE_MINUTES;

async function sweepMissedSchedules(): Promise<void> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - WATCHDOG_GRACE_MINUTES * 60_000);

  const missed = await db.select().from(vaultBackupSchedulesTable).where(and(
    eq(vaultBackupSchedulesTable.enabled, true),
    lte(vaultBackupSchedulesTable.nextRunAt, graceCutoff),
    isNull(vaultBackupSchedulesTable.runningSince),
  ));

  for (const s of missed) {
    const dueSince = s.nextRunAt ?? now;
    const missedSinceMinutes = Math.round((now.getTime() - dueSince.getTime()) / 60_000);

    logger.warn({ userId: s.userId, missedSinceMinutes }, "Automatic vault backup missed its scheduled time");
    logBus.error(`Automatic vault backup missed for user ${s.userId}: was due ${missedSinceMinutes}m ago and never ran`);

    await db.update(vaultBackupSchedulesTable).set({
      lastRunStatus: "missed",
      lastRunError: `Scheduled run was due ${missedSinceMinutes}m ago and never started — the backup scheduler may have been interrupted.`,
      nextRunAt: computeNextRunAt(s, now),
      updatedAt: now,
    }).where(eq(vaultBackupSchedulesTable.id, s.id)).catch(() => {});

    alertUserOfMissedBackup(s.userId, missedSinceMinutes).catch(() => {});
  }
}

export function startVaultBackupMissedWatchdog(): void {
  if (watchdogScheduled) return; // guard against double-init (e.g. hot reload)
  watchdogScheduled = true;

  // Deliberately its own, coarser cadence than the main sweep — checking
  // for "has this been silent for a while" doesn't need 15-minute
  // resolution, and a slower tick keeps this cheap to run forever.
  const expr = process.env.VAULT_BACKUP_WATCHDOG_CRON ?? "*/30 * * * *"; // every 30 minutes
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "VAULT_BACKUP_WATCHDOG_CRON is not a valid cron expression — missed-backup watchdog disabled");
    logBus.warn(`Vault backup missed-backup watchdog disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    sweepMissedSchedules().catch((err) => {
      logger.error({ err }, "Vault backup missed-schedule watchdog sweep failed");
      logBus.error(`Vault backup missed-schedule watchdog sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Automatic vault backup missed-backup watchdog scheduled ("${expr}", ${WATCHDOG_GRACE_MINUTES}m grace)`);
  logger.info({ expr, graceMinutes: WATCHDOG_GRACE_MINUTES }, "Vault backup missed-backup watchdog scheduled");
}
