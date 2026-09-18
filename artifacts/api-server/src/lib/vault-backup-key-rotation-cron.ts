/**
 * lib/vault-backup-key-rotation-cron.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Backup hardening, Round 6 — automatic DEK rotation.
 *
 * routes/vault-backup-key.ts (existing, from the round that first noticed
 * "rotateBackupEnvelopeKey() exists but nothing ever calls it") gave an
 * admin a manual button. That closed the *capability* gap but not the
 * *practice* one — nothing enforces rotation actually happens on any
 * cadence, so in a real deployment the key backing every scheduled backup
 * can silently go years without rotating unless an admin remembers to
 * click the button on their own schedule.
 *
 * This adds the other half: a periodic sweep (same node-cron pattern as
 * lib/dr-test-cron.ts / lib/vault-backup-schedule-cron.ts) that checks the
 * active envelope key's age and rotates automatically once it exceeds
 * VAULT_BACKUP_KEY_ROTATION_DAYS (default 90). Every rotation — manual or
 * automatic — is now also recorded in the dedicated backup audit trail
 * (lib/vault-backup-audit.ts), not just the admin-only, rotation-focused
 * user_activity row routes/vault-backup-key.ts already writes.
 *
 * Rotation itself is unchanged and still fully backward-compatible (see
 * lib/vault-backup-envelope.ts's doc comment): it only affects NEW backups
 * going forward, old DEK versions are kept forever (migration 067 enforces
 * this at the DB level) so already-stored snapshots keep decrypting
 * exactly as before. This cron is purely "call the existing, already-safe
 * rotation function on a timer instead of relying on human memory."
 *
 * If the active key is still within its rotation window, nothing happens —
 * this sweep is a no-op read (one SELECT) the overwhelming majority of the
 * time it runs.
 */
import cron from "node-cron";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { logBus } from "./log-bus";
import { rotateBackupEnvelopeKey, loadBackupEnvelopeKeyManager } from "./vault-backup-envelope";
import { logBackupAudit } from "./vault-backup-audit";
import { alertAdminsOfStaleKeyRotation } from "./vault-backup-alerts";

let scheduled = false;

const ROTATION_DAYS = Number(process.env.VAULT_BACKUP_KEY_ROTATION_DAYS ?? 90);

async function getActiveKeyAgeDays(): Promise<{ version: number; ageDays: number } | null> {
  const result: any = await db.execute(
    sql`SELECT version, created_at FROM encryption_keys WHERE namespace = 'vault-backup' AND active = TRUE LIMIT 1`
  );
  const row = (result.rows ?? result)[0];
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return { version: Number(row.version), ageDays: ageMs / 86_400_000 };
}

async function checkAndRotateIfStale(): Promise<void> {
  await loadBackupEnvelopeKeyManager().catch(() => {}); // ensure in-memory cache is warm before comparing versions
  const active = await getActiveKeyAgeDays();
  if (!active) return; // nothing bootstrapped yet — first envelope encrypt will create v1

  if (active.ageDays < ROTATION_DAYS) return; // still within window — no-op

  logBus.system(`Vault-backup envelope key v${active.version} is ${Math.floor(active.ageDays)}d old (>= ${ROTATION_DAYS}d threshold) — rotating automatically`);
  try {
    const newVersion = await rotateBackupEnvelopeKey();
    await logBackupAudit({
      ownerUserId: null, actorKind: "system", eventType: "key_rotated",
      keyVersion: newVersion, detail: { previousVersion: active.version, previousAgeDays: Math.floor(active.ageDays), trigger: "automatic" },
    });
    logBus.system(`✅ Vault-backup envelope key auto-rotated: v${active.version} -> v${newVersion}`);
  } catch (err: any) {
    // A failed automatic rotation is a real problem — the key is stale and
    // stays stale until the next sweep or an admin rotates manually — but
    // it must never crash the sweep loop or block scheduled backups, which
    // still run fine under the current (just older) key in the meantime.
    logger.error({ err, version: active.version }, "Automatic vault-backup key rotation failed");
    logBus.error(`Automatic vault-backup key rotation failed: ${err?.message ?? err}`);
    await logBackupAudit({
      ownerUserId: null, actorKind: "system", eventType: "key_rotation_stale",
      keyVersion: active.version, detail: { ageDays: Math.floor(active.ageDays), error: err?.message ?? "unknown error" },
    });
    // Vault Backup hardening, Round 7 — a stale, un-rotatable key is exactly
    // the kind of thing that should reach a human, not just sit in the audit
    // trail until someone happens to check /admin/vault-backup/key-status.
    // Same non-blocking discipline as everything else in this file: never
    // let a failed alert delay or crash the sweep.
    await alertAdminsOfStaleKeyRotation(active.version, Math.floor(active.ageDays), err?.message ?? "unknown error").catch((alertErr) => {
      logger.error({ err: alertErr }, "Failed to dispatch stale-key-rotation alerts");
    });
  }
}

export function startVaultBackupKeyRotationCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  if (!(ROTATION_DAYS > 0)) {
    logBus.system("Automatic vault-backup key rotation disabled (VAULT_BACKUP_KEY_ROTATION_DAYS <= 0) — manual rotation via /admin/vault-backup/rotate-key still available");
    return;
  }

  // Once a day is plenty for a threshold measured in days — no need to
  // check key age on a tighter interval than the schedule sweep or DR test.
  const expr = process.env.VAULT_BACKUP_KEY_ROTATION_CRON ?? "0 4 * * *"; // 04:00 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "VAULT_BACKUP_KEY_ROTATION_CRON is not a valid cron expression — automatic key rotation disabled");
    logBus.warn(`Vault-backup key rotation cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    checkAndRotateIfStale().catch((err) => {
      logger.error({ err }, "Vault-backup key rotation check failed");
      logBus.error(`Vault-backup key rotation check failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Automatic vault-backup key rotation cron scheduled ("${expr}", threshold ${ROTATION_DAYS}d)`);
  logger.info({ expr, rotationDays: ROTATION_DAYS }, "Vault-backup key rotation cron scheduled");
}

export { getActiveKeyAgeDays as _getActiveKeyAgeDaysForStatus };
