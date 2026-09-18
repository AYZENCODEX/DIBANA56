import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/**
 * schema/vault-snapshots.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15b — Stored Vault Backups.
 *
 * routes/vault-snapshot.ts (Feature 15) already builds a password-encrypted
 * full-vault blob, but until now it only ever streamed that blob straight to
 * the browser as a download — nothing was kept server-side, so "backup" was
 * really just an export button: lose the file and the backup is gone, and
 * there was no way to see what backups even existed.
 *
 * This table makes the vault the actual backup store: every export is also
 * persisted here (see POST /vault/snapshot/export), so the Snapshot Backup
 * page can list, re-download, restore-from, or delete past backups without
 * the user having to keep track of downloaded .ayzenbak files themselves.
 *
 * The stored `blob` is the exact same AYZENBAK1:... string that would be
 * written to a downloaded file — it is already AES-256-GCM encrypted with a
 * password AYZEN never sees again after the request completes, so storing it
 * server-side adds no new secret exposure: without the password this row is
 * just as unreadable as a downloaded file would be.
 */
export const vaultSnapshotsTable = pgTable("vault_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Optional user-given name ("Before wallet migration", etc). Falls back to
  // the created date in the UI when null.
  label: text("label"),

  // The AYZENBAK1:<salt>:<iv>:<authTag>:<ciphertext> blob itself.
  blob: text("blob").notNull(),

  // Denormalized metadata so list views never need to touch `blob` (which
  // can be several MB) just to render a row.
  sizeBytes: integer("size_bytes").notNull(),
  includesAttachments: boolean("includes_attachments").notNull().default(false),
  entriesCount: integer("entries_count").notNull().default(0),
  walletsCount: integer("wallets_count").notNull().default(0),
  // Feature 15d — Vault Backup Coverage Expansion (migration 058). Row
  // counts for the wider backup surface added in
  // lib/vault-snapshot-extra.ts: native mailbox, project/protocol
  // enrollments, task submissions, and finance. Nullable/defaulted to 0 so
  // pre-15d rows (backed up before this migration) just show 0 rather than
  // null-breaking the list UI.
  mailboxCount: integer("mailbox_count").notNull().default(0),
  projectsCount: integer("projects_count").notNull().default(0),
  tasksCount: integer("tasks_count").notNull().default(0),
  financeCount: integer("finance_count").notNull().default(0),
  // Feature 15e — Wallet Hub backup coverage (migration 059): transfers,
  // internal AZN/USDT/BDT/XP balances, built-in-wallet tokens, and on-chain
  // deposit history — everything the Wallet Hub page shows beyond the base
  // `wallets` rows already counted separately as walletsCount above.
  walletHubCount: integer("wallet_hub_count").notNull().default(0),
  // Feature 15f — Activity Trace backup coverage (migration 060). Row count
  // for the general event log (`user_activity`) plus the two Vault-specific
  // audit trails (`vault_activity_log`, `vault_field_history`) bundled into
  // the backup by lib/vault-snapshot-extra.ts's gatherActivitySnapshot().
  // Same denormalized-count purpose as the other *Count columns above.
  activityCount: integer("activity_count").notNull().default(0),
  // Feature 15h — Entity Coverage backup coverage (migration 061). Row
  // count for the rest of the Local/Vault/KYC/Game entity surface bundled
  // by lib/vault-snapshot-extra.ts's gatherEntityCoverageSnapshot(): KYC
  // Data Entities (kyc_data_entities — identity records a KYC or Vault
  // entity can link via data_entity_id), category receipt links
  // (vault_category_receipts), per-entity $ / follower-count history
  // (value_history), and entity access grants both granted and received
  // (vault_shares). Same denormalized-count purpose as the other *Count
  // columns above.
  entityCoverageCount: integer("entity_coverage_count").notNull().default(0),
  // Feature 15j — Emergency Access backup coverage (migration 062). Row
  // count for the dead-man-switch surface bundled by
  // lib/vault-snapshot-extra.ts's gatherEmergencyAccessSnapshot():
  // emergency contacts this user nominated, grants triggered against this
  // user's own vault, and grants where this user is the nominated contact.
  // Same denormalized-count purpose as the other *Count columns above.
  emergencyAccessCount: integer("emergency_access_count").notNull().default(0),
  // Feature 15m — Account & Platform Extras backup coverage (migration 064).
  // Row count for the remaining account-scoped surface bundled by
  // lib/vault-snapshot-extra.ts's gatherAccountExtrasSnapshot():
  // notifications, referrals (both directions), subscription/billing state,
  // support tickets + messages, developer API keys (metadata only, never
  // key_hash), passkeys, and Polymarket trade history. Same denormalized-
  // count purpose as the other *Count columns above.
  accountExtrasCount: integer("account_extras_count").notNull().default(0),
  // Feature 15n — Team & Earning backup coverage (migration 065). Row
  // count for the two surfaces bundled by lib/vault-snapshot-extra.ts's
  // gatherTeamSnapshot() (teams owned, memberships across every team this
  // user belongs to, join requests/favorites/messages/announcements/
  // missions this user personally created, both team activity logs) and
  // gatherEarningSnapshot() (this user's own pay-per-click earn links).
  // Same denormalized-count purpose as the other *Count columns above.
  teamCount: integer("team_count").notNull().default(0),
  earningCount: integer("earning_count").notNull().default(0),
  // Feature 15t — Backup System Self-Coverage (migration 074). Row count for
  // the backup SYSTEM's own per-user configuration bundled by
  // lib/vault-snapshot-extra.ts's gatherBackupSystemSnapshot(): the
  // automatic-backup schedule, connected cloud-delivery accounts (labels
  // only — never tokens), delivery history, this user's slice of the
  // dedicated backup audit log, a secrets-free summary of their Vault
  // security posture, and any project templates they've authored. Same
  // denormalized-count purpose as the other *Count columns above.
  backupSystemCount: integer("backup_system_count").notNull().default(0),
  // Feature 15u — Connected Mail Accounts backup coverage (migration 075).
  // Row count for the external IMAP/SMTP mailboxes this user connected
  // (lib/vault-snapshot-extra.ts's gatherEmailAccountsSnapshot()) — both
  // personal and any team mailbox they personally configured, password/
  // auth_key decrypted the same way Vault entity fields and wallet seed
  // phrases already are elsewhere in the same snapshot. Same denormalized-
  // count purpose as the other *Count columns above.
  emailAccountsCount: integer("email_accounts_count").notNull().default(0),
  // Feature 15w — Mailbox Deliverability & Reputation backup coverage
  // (migration 076). Row count for the moderation surface bundled by
  // lib/vault-snapshot-extra.ts's gatherMailboxReputationSnapshot(): the
  // sender Block/Allow list, auto-flagged/blocked outbound recipients, and
  // this account's own sending-health (healthy/warning/paused) status. Same
  // denormalized-count purpose as the other *Count columns above.
  mailboxReputationCount: integer("mailbox_reputation_count").notNull().default(0),
  // Feature 15x — External Mail Sync Cache backup coverage (migration 077).
  // Row count for `mail_messages` (lib/vault-snapshot-extra.ts's
  // gatherExternalMailSnapshot()) — the synced header/body cache for a
  // user's connected external IMAP/SMTP mailboxes, decrypted the same way
  // native mailbox message bodies already are. Same denormalized-count
  // purpose as the other *Count columns above.
  externalMailCount: integer("external_mail_count").notNull().default(0),

  // Feature 15c — Automatic Vault Backups (migration 056).
  // sha256 of `blob`, computed at write time — lets a corruption/integrity
  // check confirm a stored or off-vault-delivered copy still matches what
  // was originally written.
  checksum: text("checksum"),
  // "manual" (POST /vault/snapshot/export) or "scheduled" (the automatic
  // backup cron, lib/vault-backup-schedule-cron.ts).
  source: text("source").notNull().default("manual"),
  // "password" — blob is AYZENBAK1:... (a user-chosen password, never
  // stored). "envelope" — blob is ENV1:... (the server-managed key from
  // lib/vault-backup-envelope.ts; only scheduled backups use this, since
  // nobody is present to type a password on a timer).
  encryptionMode: text("encryption_mode").notNull().default("password"),
  // Which vault-backup-envelope.ts DEK version encrypted this row, when
  // encryptionMode = "envelope". Null for password-mode rows.
  encryptionVersion: integer("encryption_version"),

  // Vault Backup hardening — Snapshot Delete Protection (migration 072).
  // NULL = active/visible. Set on DELETE /vault/snapshots/:id (and by the
  // quota/count auto-prune in pruneOldSnapshots()) instead of removing the
  // row outright — recoverable via POST /vault/snapshots/:id/restore until
  // lib/vault-snapshot-trash-purge.ts's sweep hard-deletes it after
  // VAULT_SNAPSHOT_TRASH_RETENTION_DAYS. A DB trigger additionally refuses
  // any hard DELETE on a row that isn't soft-deleted yet, or was soft-
  // deleted too recently — see migration 072's comment.
  deletedAt: timestamp("deleted_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertVaultSnapshotSchema = createInsertSchema(vaultSnapshotsTable).omit({
  id: true, createdAt: true,
});
