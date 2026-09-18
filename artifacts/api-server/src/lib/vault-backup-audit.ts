/**
 * lib/vault-backup-audit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Backup hardening, Round 6 — dedicated audit trail.
 *
 * Write helper for vault_backup_audit_log (migration 073, schema at
 * lib/db/src/schema/vault-backup-audit-log.ts). Best-effort and non-blocking
 * — same discipline as routes/vault.ts's logVaultActivity and
 * lib/activity.ts's logActivity: a logging failure must never fail or delay
 * the request/job that triggered it. Callers `await` it anyway (rather than
 * fire-and-forget) so a slow write doesn't reorder relative to the response,
 * but the try/catch inside means that await can never throw.
 *
 * `detail` must stay small and non-sensitive — never ciphertext/plaintext,
 * key material, passwords, tokens, or webhook secrets. For a URL (e.g. a
 * changed webhook target), log a redacted form (host + path only, no query
 * string/credentials) — see redactUrl() below — never the raw value,
 * since this table is meant to be safely readable by any admin doing
 * incident response, not just the account owner.
 */
import { db, vaultBackupAuditLogTable } from "@workspace/db";
import { eq, desc, and, inArray, isNotNull } from "drizzle-orm";
import type { Request } from "express";

export type VaultBackupAuditEvent =
  | "snapshot_downloaded"
  | "snapshot_restore_previewed"
  | "snapshot_restored"
  | "snapshot_trashed"
  | "snapshot_untrashed"
  | "snapshot_purged"
  | "schedule_destination_changed"
  | "schedule_webhook_changed"
  | "cloud_connected"
  | "cloud_disconnected"
  | "key_rotated"
  | "key_rotation_stale";

export interface LogBackupAuditInput {
  ownerUserId: number | null; // null only for namespace-wide key events
  actorUserId?: number | null;
  actorKind?: "user" | "admin" | "system";
  eventType: VaultBackupAuditEvent;
  snapshotId?: number | null;
  keyVersion?: number | null;
  req?: Request | null; // when provided, ip/user-agent are captured automatically
  detail?: Record<string, unknown> | null;
}

function requestIp(req: Request): string {
  return (req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^::ffff:/, "");
}

/** Host + path only — strips query string, fragment, and any embedded credentials before it's ever logged. */
export function redactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return "[unparseable]";
  }
}

export async function logBackupAudit(input: LogBackupAuditInput): Promise<void> {
  try {
    await db.insert(vaultBackupAuditLogTable).values({
      ownerUserId: input.ownerUserId,
      actorUserId: input.actorUserId ?? input.ownerUserId ?? null,
      actorKind: input.actorKind ?? "user",
      eventType: input.eventType,
      snapshotId: input.snapshotId ?? null,
      keyVersion: input.keyVersion ?? null,
      ip: input.req ? requestIp(input.req) : null,
      userAgent: input.req ? ((input.req.headers["user-agent"] as string) || null) : null,
      detail: input.detail ?? null,
    });
  } catch (err) {
    // Best-effort, same as every other activity logger in this codebase —
    // an audit-log write failure must never fail the calling request.
    console.error("vault backup audit log failed:", err);
  }
}

/** A user's own backup-security history — newest first, paginated. */
export async function listOwnBackupAuditLog(userId: number, limit = 50): Promise<any[]> {
  return db.select().from(vaultBackupAuditLogTable)
    .where(eq(vaultBackupAuditLogTable.ownerUserId, userId))
    .orderBy(desc(vaultBackupAuditLogTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Admin-wide feed, optionally filtered to one user (e.g. incident response on a specific account). */
export async function listBackupAuditLogAdmin(opts: { userId?: number; limit?: number } = {}): Promise<any[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const q = db.select().from(vaultBackupAuditLogTable);
  if (opts.userId) {
    return q.where(eq(vaultBackupAuditLogTable.ownerUserId, opts.userId))
      .orderBy(desc(vaultBackupAuditLogTable.createdAt)).limit(limit);
  }
  return q.orderBy(desc(vaultBackupAuditLogTable.createdAt)).limit(limit);
}

// Vault Backup hardening, Round 7 — anomaly detection off this same trail.
// Deliberately its own baseline, not a reuse of lib/login-security.ts's
// isAnomalousIp(): that one compares against *login* history, which answers
// a different question ("has this account ever signed in from here") than
// the one that matters for a backup download/restore ("has THIS account's
// backup data ever left the server to here before"). A user who's logged
// in from an IP but never downloaded a backup from it should still trigger
// this — e.g. a session token stolen and used only to pull backups, never
// to log in fresh.
const BACKUP_IP_HISTORY_LOOKBACK = 50;

/**
 * True if `ip` has never appeared on a prior snapshot_downloaded or
 * snapshot_restored event for this user. Like isAnomalousIp(), a user with
 * no prior history at all is never flagged — nothing to compare against,
 * and flagging someone's very first download/restore would just be noise.
 */
export async function isAnomalousBackupIp(userId: number, ip: string): Promise<boolean> {
  if (!ip || ip === "unknown") return false; // can't compare, and would false-positive every time otherwise
  const rows = await db.select({ ip: vaultBackupAuditLogTable.ip }).from(vaultBackupAuditLogTable)
    .where(and(
      eq(vaultBackupAuditLogTable.ownerUserId, userId),
      inArray(vaultBackupAuditLogTable.eventType, ["snapshot_downloaded", "snapshot_restored"]),
      isNotNull(vaultBackupAuditLogTable.ip),
    ))
    .orderBy(desc(vaultBackupAuditLogTable.createdAt))
    .limit(BACKUP_IP_HISTORY_LOOKBACK);
  if (rows.length === 0) return false;
  return !rows.some((r) => r.ip === ip);
}
