import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * schema/vault-backup-cloud-connections.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15l — Cloud Backup Delivery (migration 063).
 *
 * One row per (userId, provider) — an OAuth connection to the user's own
 * Google Drive or Dropbox account, used by lib/vault-backup-delivery.ts to
 * push a copy of a vault_snapshots blob there, the same way "email" and
 * "webhook" destinations already work (see vault-backup-schedules.ts's
 * `destination` column, which now also accepts "google_drive" | "dropbox").
 *
 * accessToken/refreshToken are always stored through encryptField()/
 * decryptField() (lib/vault-crypto.ts) — same envelope-encryption machinery
 * every other Vault secret uses, so this rides the same key-rotation story
 * rather than introducing a second one.
 */
export const vaultBackupCloudConnectionsTable = pgTable("vault_backup_cloud_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // "google_drive" | "dropbox"
  provider: text("provider").notNull(),

  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),

  // Display-only — the connected account's email/name, shown on the
  // Automatic Backups card without needing to decrypt a token.
  accountLabel: text("account_label"),

  // Google Drive only: the "AYZEN Vault Backups" folder id, created once on
  // first connect. Dropbox addresses uploads by path instead.
  folderId: text("folder_id"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  userProviderUnique: unique().on(t.userId, t.provider),
}));

export type VaultBackupCloudConnection = typeof vaultBackupCloudConnectionsTable.$inferSelect;
