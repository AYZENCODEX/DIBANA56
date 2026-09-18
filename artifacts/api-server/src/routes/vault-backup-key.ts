/**
 * routes/vault-backup-key.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin-only visibility + a manual trigger for the "vault-backup" envelope
 * key chain (lib/vault-backup-envelope.ts). Fixes a gap flagged in the
 * envelope-mode disaster-recovery runbook: rotateBackupEnvelopeKey() existed
 * but nothing in the app ever called it, so in practice the backup DEK never
 * rotated.
 *
 * This intentionally does NOT expose or return any wrapped_dek value, raw
 * key material, or VAULT_MASTER_KEY — only namespace/version/active/
 * created_at metadata, same masking discipline as routes/key-manager.ts.
 *
 * IMPORTANT — read before ever calling POST /rotate in production:
 *   - Rotation only affects NEW backups going forward. It does not, and
 *     cannot, re-encrypt vault_snapshots rows already written under an
 *     older version — those keep decrypting fine under their original
 *     version (old DEKs are never deleted), so this is safe to call at any
 *     time with no downtime and no data loss.
 *   - Rotation is UNRELATED to VAULT_MASTER_KEY (the KEK). Rotating this
 *     backup DEK never requires touching the KEK, and must never be
 *     confused with a KEK change — see the runbook's warning that a KEK
 *     change with no re-wrap step permanently bricks every existing DEK.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAdmin, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { rotateBackupEnvelopeKey, getActiveBackupEnvelopeVersion } from "../lib/vault-backup-envelope";
import { logActivity } from "../lib/activity";
import { logBackupAudit, listBackupAuditLogAdmin } from "../lib/vault-backup-audit";

const router = Router();

// Vault Backup hardening, Round 6 — same threshold
// lib/vault-backup-key-rotation-cron.ts auto-rotates against, surfaced here
// so an admin sees "stale" before the cron would even act, not just after.
const ROTATION_DAYS = Number(process.env.VAULT_BACKUP_KEY_ROTATION_DAYS ?? 90);

// ─── GET /admin/vault-backup/key-status — list DEK versions (metadata only) ─
router.get("/admin/vault-backup/key-status", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const result: any = await db.execute(
      sql`SELECT version, active, created_at FROM encryption_keys WHERE namespace = 'vault-backup' ORDER BY version ASC`
    );
    const rows: any[] = result.rows ?? result;
    const activeVersion = getActiveBackupEnvelopeVersion();
    const activeRow = rows.find(r => Number(r.version) === activeVersion);
    const activeAgeDays = activeRow ? (Date.now() - new Date(activeRow.created_at).getTime()) / 86_400_000 : null;

    res.json({
      activeVersion,
      activeKeyAgeDays: activeAgeDays !== null ? Math.floor(activeAgeDays) : null,
      rotationThresholdDays: ROTATION_DAYS,
      // Cosmetic-only flag for the UI to badge — the enforcing check lives
      // in the cron (VAULT_BACKUP_KEY_ROTATION_DAYS), not here.
      stale: activeAgeDays !== null && ROTATION_DAYS > 0 && activeAgeDays >= ROTATION_DAYS,
      versions: rows.map(r => ({ version: Number(r.version), active: !!r.active, createdAt: r.created_at })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /admin/vault-backup/rotate-key — generate + activate a new DEK ────
router.post("/admin/vault-backup/rotate-key", requireAdmin, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const adminId = getRequestUserId(req);
  try {
    const newVersion = await rotateBackupEnvelopeKey();
    if (adminId) {
      // No key material in the log — only the fact that a rotation happened
      // and which version is now active (see file-header note on scope).
      await logActivity(adminId, "vault_backup_key_rotated", "encryption_key", newVersion, "vault-backup", { newVersion });
    }
    // Vault Backup hardening, Round 6 — also record it in the dedicated
    // backup audit trail (ownerUserId null: this is namespace-wide, not
    // scoped to one user's data), so it shows up alongside every other
    // backup-security event instead of only in the generic admin feed.
    await logBackupAudit({
      ownerUserId: null, actorUserId: adminId ?? null, actorKind: "admin",
      eventType: "key_rotated", keyVersion: newVersion, req, detail: { trigger: "manual" },
    });
    res.json({ ok: true, newActiveVersion: newVersion });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /admin/vault-backup/audit-log — backup-security event feed ────────
// Vault Backup hardening, Round 6. Optional ?userId= to scope to one
// account (incident response); otherwise every user's events, newest first.
router.get("/admin/vault-backup/audit-log", requireAdmin, async (req, res): Promise<void> => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = await listBackupAuditLogAdmin({
      userId: userId && Number.isFinite(userId) ? userId : undefined,
      limit: limit && Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ events: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
