import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * schema/vault-backup-deliveries.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Off-Vault Backup Delivery audit log (migration 056).
 *
 * Every attempt to deliver a stored vault_snapshots row off-vault (email
 * attachment or signed webhook POST — see lib/vault-backup-delivery.ts) logs
 * one row here, success or failure, so a bad webhook URL or bounced email
 * shows up in the UI (GET /vault/backup/deliveries) instead of silently
 * vanishing.
 */
export const vaultBackupDeliveriesTable = pgTable("vault_backup_deliveries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  snapshotId: integer("snapshot_id").notNull(),

  destination: text("destination").notNull(), // "email" | "webhook"
  target: text("target"),                     // the destination email or webhook URL
  status: text("status").notNull(),           // "success" | "failed"
  error: text("error"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type VaultBackupDelivery = typeof vaultBackupDeliveriesTable.$inferSelect;
