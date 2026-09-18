import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/**
 * schema/vault-backup-schedules.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Automatic Vault Backups (migration 056).
 *
 * One row per user, upserted by PUT /vault/backup/schedule
 * (routes/vault-backup-schedule.ts) and swept every
 * VAULT_BACKUP_SCHEDULE_CRON interval by lib/vault-backup-schedule-cron.ts.
 * When enabled and nextRunAt is due, the sweep builds the same full-vault
 * snapshot the manual export button does, encrypts it under the server
 * envelope key (lib/vault-backup-envelope.ts), stores it as a vault_snapshots
 * row (source = "scheduled"), optionally delivers a copy off-vault (email,
 * webhook, or — Feature 15l — the user's own Google Drive/Dropbox, see
 * vault-backup-deliveries.ts / vault-backup-cloud-connections.ts below),
 * then advances nextRunAt.
 */
export const vaultBackupSchedulesTable = pgTable("vault_backup_schedules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),

  enabled: boolean("enabled").notNull().default(false),

  // "daily" | "weekly" | "monthly" — see computeNextRunAt() in
  // lib/vault-backup-schedule-cron.ts for how the other fields combine with
  // this to produce the next run time.
  frequency: text("frequency").notNull().default("weekly"),
  dayOfWeek: integer("day_of_week").notNull().default(0),   // 0=Sunday..6=Saturday, for "weekly"
  dayOfMonth: integer("day_of_month").notNull().default(1), // 1-28, for "monthly"
  hourOfDay: integer("hour_of_day").notNull().default(3),   // 0-23, server local time

  includeAttachments: boolean("include_attachments").notNull().default(false),

  // "store" (vault_snapshots only) | "email" | "webhook" | "google_drive" |
  // "dropbox" (Feature 15l — the latter two need a connection row in
  // vault_backup_cloud_connections, made via routes/vault-backup-cloud.ts).
  destination: text("destination").notNull().default("store"),
  destinationEmail: text("destination_email"),
  webhookUrl: text("webhook_url"),
  // Generated once when a webhook destination is first configured; used to
  // HMAC-SHA256 sign delivery payloads (X-Ayzen-Signature). Never re-shown
  // to the client after generation — see GET's hasWebhookSecret flag.
  webhookSecret: text("webhook_secret"),

  lastRunAt: timestamp("last_run_at"),
  lastRunStatus: text("last_run_status"), // "success" | "failed" | "missed" (Round 8 watchdog — see lib/vault-backup-schedule-cron.ts's sweepMissedSchedules)
  lastRunError: text("last_run_error"),
  nextRunAt: timestamp("next_run_at"),

  // Overlap guard (migration 066): set to now() by sweepDueSchedules() when
  // it claims this row for a run, cleared back to NULL when that run
  // finishes (success or failure). A row with running_since already set is
  // skipped by later sweep ticks, preventing a slow run (snapshot build +
  // delivery taking longer than the cron interval) from being picked up
  // twice and firing duplicate backups/deliveries. See
  // lib/vault-backup-schedule-cron.ts.
  runningSince: timestamp("running_since"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertVaultBackupScheduleSchema = createInsertSchema(vaultBackupSchedulesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});

export type VaultBackupSchedule = typeof vaultBackupSchedulesTable.$inferSelect;
