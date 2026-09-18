import { pgTable, serial, text, integer, timestamp, real, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vaultEntriesTable = pgTable("vault_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  entitySerial: text("entity_serial"),
  category: text("category"), // legacy — no longer set or shown; kept nullable for old rows
  projectName: text("project_name").notNull(),

  // Data Entity bridge — the same kyc_data_entities table a KYC entity can
  // link via data_entity_id. Lets a Vault Entity (e.g. an Exchange-category
  // account) reuse an existing identity/KYC-document record instead of
  // re-typing it, exactly like a KYC entity does. Nullable — most vault
  // entries have no linked identity data. See routes/vault.ts,
  // routes/kyc-data-entities.ts, and components/vault/data-entity-picker.tsx.
  dataEntityId: integer("data_entity_id"),

  // Account · Main — account-level identity credentials
  username: text("username"),
  accountPassword: text("account_password"),

  // Email (linked email for this identity)
  email: text("email"),
  emailPassword: text("email_password"),
  email2fa: text("email_2fa"),
  emailBackupCode: text("email_backup_code"),
  emailRecovery: text("email_recovery"),
  emailRecoveryPassword: text("email_recovery_password"),
  // Account · Main — account-level 2FA and backup code (separate from the
  // linked email's own 2FA/backup which are email2fa/emailBackupCode above)
  account2fa: text("account_2fa"),
  accountBackupCode: text("account_backup_code"),
  // Account · Recovery — recovery-email 2FA/backup, separate from the
  // recovery email's own password above
  recovery2fa: text("recovery_2fa"),
  recoveryBackupCode: text("recovery_backup_code"),

  // Account · Info — dates, follower count (value/buy tracked via
  // currentValue/currentBuyValue below + value_history)
  lastLoginAt: timestamp("last_login_at"),
  buyDate: timestamp("buy_date"),
  createDate: timestamp("create_date"),
  followers: integer("followers").notNull().default(0),

  // Account · Wallet · Drive — fixed, set-once wallet record (immutable
  // once set; see PATCH /vault/:id/drive-wallet)
  driveWalletLabel: text("drive_wallet_label"),
  driveWalletAddress: text("drive_wallet_address"),
  driveWalletNote: text("drive_wallet_note"),
  driveWalletSetAt: timestamp("drive_wallet_set_at"),

  // Twitter / X — full multilayer
  twitterUsername: text("twitter_username"),
  twitterPassword: text("twitter_password"),
  twitterEmail: text("twitter_email"),
  twitterEmailPassword: text("twitter_email_password"),
  twitterFollowers: text("twitter_followers"),
  twitter2fa: text("twitter_2fa"),
  twitterEmailRecovery: text("twitter_email_recovery"),
  twitterEmailRecoveryPassword: text("twitter_email_recovery_password"),
  twitterAge: text("twitter_age"),
  twitterWorth: text("twitter_worth"),
  twitterBuyValue: text("twitter_buy_value"),
  twitterLastLoginAt: timestamp("twitter_last_login_at"),
  twitterBuyDate: timestamp("twitter_buy_date"),
  twitterCreateDate: timestamp("twitter_create_date"),
  twitterNotes: text("twitter_notes"),
  // Twitter · extra credential fields
  twitterAccountBackupCode: text("twitter_account_backup_code"),
  twitterEmail2fa: text("twitter_email_2fa"),
  twitterEmailBackupCode: text("twitter_email_backup_code"),
  twitterRecovery2fa: text("twitter_recovery_2fa"),
  twitterRecoveryBackupCode: text("twitter_recovery_backup_code"),

  // Discord — full multilayer
  discordUsername: text("discord_username"),
  discordPassword: text("discord_password"),
  discordEmail: text("discord_email"),
  discordEmailPassword: text("discord_email_password"),
  discord2fa: text("discord_2fa"),
  discordEmailRecovery: text("discord_email_recovery"),
  discordEmailRecoveryPassword: text("discord_email_recovery_password"),
  discordFollowers: text("discord_followers"),
  discordAge: text("discord_age"),
  discordWorth: text("discord_worth"),
  discordBuyValue: text("discord_buy_value"),
  discordLastLoginAt: timestamp("discord_last_login_at"),
  discordBuyDate: timestamp("discord_buy_date"),
  discordCreateDate: timestamp("discord_create_date"),
  discordNotes: text("discord_notes"),
  // Discord · extra credential fields
  discordAccountBackupCode: text("discord_account_backup_code"),
  discordEmail2fa: text("discord_email_2fa"),
  discordEmailBackupCode: text("discord_email_backup_code"),
  discordRecovery2fa: text("discord_recovery_2fa"),
  discordRecoveryBackupCode: text("discord_recovery_backup_code"),

  // Telegram — full multilayer
  telegramUsername: text("telegram_username"),
  telegramPassword: text("telegram_password"),
  telegramPhone: text("telegram_phone"),
  telegram2fa: text("telegram_2fa"),
  telegramLinkedEmail: text("telegram_linked_email"),
  telegramLinkedEmailPassword: text("telegram_linked_email_password"),
  telegramAge: text("telegram_age"),
  telegramWorth: text("telegram_worth"),
  telegramBuyValue: text("telegram_buy_value"),
  telegramFollowers: text("telegram_followers"),
  telegramLastLoginAt: timestamp("telegram_last_login_at"),
  telegramBuyDate: timestamp("telegram_buy_date"),
  telegramCreateDate: timestamp("telegram_create_date"),
  telegramNotes: text("telegram_notes"),
  // Telegram · extra credential fields
  telegramAccountBackupCode: text("telegram_account_backup_code"),
  telegramEmail2fa: text("telegram_email_2fa"),
  telegramEmailBackupCode: text("telegram_email_backup_code"),
  telegramRecovery2fa: text("telegram_recovery_2fa"),
  telegramRecoveryBackupCode: text("telegram_recovery_backup_code"),

  walletAddresses: text("wallet_addresses"),
  backupCodes: text("backup_codes"),
  // User-defined tags (e.g. "priority", "airdrop-live", "needs-kyc") — JSON
  // array string, same pattern as walletAddresses. See GET /vault/tags and
  // PATCH /vault/bulk-tag in routes/vault.ts.
  tags: text("tags"),
  notes: text("notes"),
  otherAccounts: text("other_accounts"),
  currentValue: real("current_value").notNull().default(0),
  currentBuyValue: real("current_buy_value").notNull().default(0),
  // Live on-chain worth — auto-computed by POST /vault/:id/refresh-wallet-worth
  // via read-only RPC calls (ethers v6) across ETH/BASE/MATIC/BSC/ARB/OP for every
  // address in walletAddresses + driveWalletAddress. Summed into computeEntityWorth
  // alongside the manual currentValue instead of requiring manual entry. Kept
  // separate from currentValue so the manual field is never silently overwritten.
  walletWorthUsd: real("wallet_worth_usd").notNull().default(0),
  walletWorthSyncedAt: timestamp("wallet_worth_synced_at"),
  // Seed phrase (AES-256-GCM encrypted, see encryptSeedPhrase in routes/vault.ts),
  // lifecycle status, and last-touched timestamp (all added to the DB earlier via
  // MIGRATIONS in index.ts; now declared here so Drizzle reads/writes them directly).
  encryptedSeedPhrase: text("encrypted_seed_phrase"),
  status: text("status").notNull().default("active"),
  // Per-platform ban tags — independent of the entity's own `status`. An
  // entity can be active overall while one linked platform account
  // (Twitter/Discord/Telegram) is individually flagged as banned. "Other"
  // platform accounts carry their own `banned` boolean inside the
  // other_accounts JSON blob instead, since that list is already free-form.
  twitterBanned: boolean("twitter_banned").notNull().default(false),
  discordBanned: boolean("discord_banned").notNull().default(false),
  telegramBanned: boolean("telegram_banned").notNull().default(false),
  // 0-10 quality/health score for this entity — drives the 5-tier rank badge
  // (see src/lib/entity-rank.tsx on the frontend). Defaults to 5 (mid-tier).
  score: integer("score").notNull().default(5),
  lastActivityAt: timestamp("last_activity_at"),
  // Health Monitor — last time the health-rules engine flagged this entry,
  // and which rule ids fired (JSON array string), so re-checks don't spam
  // duplicate alerts for an issue that's still unresolved.
  lastHealthAlertAt: timestamp("last_health_alert_at"),
  lastHealthFlags: text("last_health_flags"),
  // Soft-delete / recycle bin — set by DELETE /vault/:id instead of removing
  // the row. NULL = active/visible entry. A background cron (see
  // lib/vault-trash-cron.ts) hard-deletes rows past the retention window;
  // POST /vault/:id/restore clears this back to NULL. Every normal read path
  // filters deletedAt IS NULL; GET /vault/trash is the exception.
  deletedAt: timestamp("deleted_at"),
  // Public, shareable receipt link — same idea as
  // finance_ledger_entries.receiptToken (lib/db/src/schema/finance.ts) but
  // for a Vault Entity's "username/follower/age/worth/PnL" card. NULL =
  // no active link. See routes/vault.ts "Public receipt link" section and
  // migrations/022_entity_receipts.sql.
  receiptToken: text("receipt_token").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Audit trail for security-relevant vault events (created, updated, seed phrase
// revealed, status changed, deleted). Added in Phase 26. Powers GET /vault/:id/activity.
export const vaultActivityLogTable = pgTable("vault_activity_log", {
  id: serial("id").primaryKey(),
  vaultEntryId: integer("vault_entry_id").notNull(),
  userId: integer("user_id").notNull(),
  action: text("action").notNull(),
  detail: text("detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Entity relationship linking — airdrop farming setups have one main account
// plus multiple alt accounts, each stored as its own independent vault_entries
// row (no structural connection between them). This table lets a user mark
// that relationship explicitly: "this entity is an alt of X" or "shares a
// wallet with Y". Directional pairs (entityId -> linkedEntityId) so
// relation_type can read naturally from entityId's point of view (e.g.
// entityId "alt_of" linkedEntityId means entityId is the alt, linkedEntityId
// is the main). Symmetric relations (shares_wallet, shares_email, etc.) are
// still stored once, in whichever direction the user created it — the
// detail-page UI resolves both directions so either entity shows the link.
// Powers the "Linked Entities" section + graph view on vault-entity-detail.tsx.
export const vaultEntityLinksTable = pgTable("vault_entity_links", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  entityId: integer("entity_id").notNull(),
  linkedEntityId: integer("linked_entity_id").notNull(),
  // One of: alt_of, main_of, shares_wallet, shares_email, shares_ip,
  // shares_device, same_owner, other — enforced at the route layer, not the
  // DB, so new relation types don't need a migration.
  relationType: text("relation_type").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Per-field "Change" commit history — one row per edit made through
// PATCH /vault/:id/field (the entity detail page's per-field Change button).
// old_value/new_value are stored through the same encryptField()/decryptField()
// as the live columns (routes/vault.ts), regardless of whether the field
// itself is one of SENSITIVE_VAULT_FIELDS, so history for a plain field and
// a credential field are protected the same way at rest. No FK/cascade on
// vaultEntryId — same audit-log rationale as vaultActivityLogTable, kept as
// its own table since this needs structured old/new pairs per field rather
// than a free-text detail string.
export const vaultFieldHistoryTable = pgTable("vault_field_history", {
  id: serial("id").primaryKey(),
  vaultEntryId: integer("vault_entry_id").notNull(),
  userId: integer("user_id").notNull(),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
});

export const insertVaultEntrySchema = createInsertSchema(vaultEntriesTable).omit({ id: true, createdAt: true, updatedAt: true, entitySerial: true, deletedAt: true, receiptToken: true });
export type InsertVaultEntry = z.infer<typeof insertVaultEntrySchema>;
export type VaultEntry = typeof vaultEntriesTable.$inferSelect;
export type VaultActivityLog = typeof vaultActivityLogTable.$inferSelect;
export type VaultEntityLink = typeof vaultEntityLinksTable.$inferSelect;
export type VaultFieldHistory = typeof vaultFieldHistoryTable.$inferSelect;
