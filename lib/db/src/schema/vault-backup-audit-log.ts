import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * schema/vault-backup-audit-log.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Backup hardening, Round 6 — dedicated audit trail (migration 073).
 *
 * Append-only (DB-enforced, see the migration's UPDATE/DELETE triggers) log
 * of every security-relevant vault-backup event: ciphertext leaving the
 * server (download), a stored backup being decrypted/restored/deleted, a
 * schedule's off-vault destination changing (email/webhook/cloud), a cloud
 * connection being made or revoked, and every DEK rotation (manual or
 * automatic). See lib/vault-backup-audit.ts for the write helper and the
 * full event_type vocabulary.
 */
export const vaultBackupAuditLogTable = pgTable("vault_backup_audit_log", {
  id: serial("id").primaryKey(),

  ownerUserId: integer("owner_user_id"),   // whose backup/config this event is about (NULL only for namespace-wide key events)
  actorUserId: integer("actor_user_id"),   // who did it — may differ from ownerUserId (admin action) or be NULL (system/cron)
  actorKind: text("actor_kind").notNull().default("user"), // "user" | "admin" | "system"

  eventType: text("event_type").notNull(),

  snapshotId: integer("snapshot_id"),
  keyVersion: integer("key_version"),

  ip: text("ip"),
  userAgent: text("user_agent"),
  detail: jsonb("detail"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type VaultBackupAuditLogRow = typeof vaultBackupAuditLogTable.$inferSelect;
