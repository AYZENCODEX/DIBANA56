import type { FieldDef } from "@/config/types";

// Field config for pages/user/vault.tsx's Add/Edit Entity dialog. See
// UI_CONFIG_PLAN.md Phase B.
//
// Covers every tab except "other" (the dynamic other-platform list, which
// is inherently a variable-length array editor, not a fixed field set —
// it stays as its own OtherAccountForm component in the page).
//
// Adding a credential field to any tab (twitter/discord/telegram/wallet)
// is one entry here — the dialog just renders
// <SchemaForm fields={ENTITY_FIELDS} tab={formTab} .../> for the active tab.
//
// The top-level "account" tab (renamed from the old flat "main" tab) is
// further split into 4 sub-tabs — Main / Info / Recovery / Wallet — via the
// `subtab` field on FieldDef. twitter/discord/telegram each split into the
// same 3 of those — Main / Info / Recovery (no Wallet, platforms don't carry
// one) — using the shared PLATFORM_SUBTABS constant in vault.tsx. Consumers
// filter by both `tab` and `subtab` themselves before calling <SchemaForm
// fields={filtered} .../> (SchemaForm's own filter only understands `tab`),
// so vault.tsx does:
//   ENTITY_FIELDS.filter(f => f.tab === activeTab && f.subtab === activeSubtab)
//
// NOTE: emailRecoveryPassword exists in the entity's saved fields
// (openEdit/EMPTY_FORM in vault.tsx) but was never actually rendered in the
// original hardcoded markup — that omission is preserved here rather than
// silently "fixed" as part of a migration. discordEmailPassword and
// telegramLinkedEmailPassword were in the same boat but are now rendered
// (Discord/Telegram · Recovery) for parity with Twitter's existing
// twitterEmailPassword field.

// Phase 3 — the Account tab (and this sub-tab strip) no longer renders in
// the entity-create dialog (pages/user/vault.tsx). It's reused as-is by the
// project-enrollment dialog (pages/user/project-entities.tsx), which shows
// these same Main/Info/Recovery fields at enroll time instead — Wallet is
// excluded there since wallet data stays entity-level, not enrollment-level.
export const ACCOUNT_SUBTABS = [
  { id: "main", label: "Main" },
  { id: "info", label: "Info" },
  { id: "recovery", label: "Recovery" },
];

export const ENTITY_FIELDS: FieldDef[] = [
  // ── Account · Main ───────────────────────────────────────────────────
  // NOTE: "category" (a Select bound to the page's own CATEGORIES list)
  // and "projectName" stay as page-local JSX immediately above this
  // SchemaForm call — category isn't a plain option list suited to this
  // field-def shape today, and pairing it with projectName in the same
  // 2-col row is simplest done inline. Everything after them in the tab
  // is config-driven.
  {
    key: "username", label: "Username", type: "text", tab: "account", subtab: "main",
    pairKey: "acct-1", placeholder: "account username / handle", compact: true,
  },
  {
    key: "accountPassword", label: "Account Password", type: "password", tab: "account", subtab: "main",
    pairKey: "acct-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "email", label: "Email", type: "text", tab: "account", subtab: "main",
    pairKey: "acct-2", placeholder: "account@email.com", compact: true,
  },
  {
    key: "emailPassword", label: "Email Password", type: "password", tab: "account", subtab: "main",
    pairKey: "acct-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "account2fa", label: "Account 2FA Secret", type: "text", tab: "account", subtab: "main",
    pairKey: "acct-3", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "accountBackupCode", label: "Account Backup Code", type: "text", tab: "account", subtab: "main",
    pairKey: "acct-3", placeholder: "backup code...", compact: true,
  },
  {
    key: "email2fa", label: "Email 2FA Secret", type: "text", tab: "account", subtab: "main",
    pairKey: "acct-4", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "emailBackupCode", label: "Email Backup Code", type: "text", tab: "account", subtab: "main",
    pairKey: "acct-4", placeholder: "backup code...", compact: true,
  },
  {
    key: "notes", label: "Notes", type: "textarea", tab: "account", subtab: "main",
    placeholder: "Airdrop notes, important info...", rows: 3,
  },

  // ── Account · Info ────────────────────────────────────────────────────
  // Date group (last login / buy date / create date)
  {
    key: "lastLoginAt", label: "Last Login", type: "date", tab: "account", subtab: "info",
    pairKey: "info-date", compact: true,
  },
  {
    key: "buyDate", label: "Buy Date", type: "date", tab: "account", subtab: "info",
    pairKey: "info-date", compact: true,
  },
  {
    key: "createDate", label: "Create Date", type: "date", tab: "account", subtab: "info",
    pairKey: "info-date", compact: true,
  },
  // Value group — initial buy price / worth. Further additions after the
  // entity is saved go through the Add-Value dialog (with note + 7/14/28d
  // P&L) on the entity detail page, not this form.
  {
    key: "currentBuyValue", label: "Buy Price ($)", type: "number", tab: "account", subtab: "info",
    pairKey: "info-value", placeholder: "e.g. 20", compact: true,
  },
  {
    key: "currentValue", label: "Worth ($)", type: "number", tab: "account", subtab: "info",
    pairKey: "info-value", placeholder: "e.g. 50", compact: true,
    help: "Add more later from the entity page — every change is P&L-tracked over 7d/14d/28d.",
  },
  // Follower group — same later-additions pattern as value, tracked with
  // its own history + note.
  {
    key: "followers", label: "Followers", type: "number", tab: "account", subtab: "info",
    placeholder: "e.g. 1200", compact: true,
    help: "Add more later from the entity page — every change is logged with a note.",
  },

  // ── Account · Recovery ───────────────────────────────────────────────
  {
    key: "emailRecovery", label: "Recovery Email", type: "text", tab: "account", subtab: "recovery",
    pairKey: "rec-1", placeholder: "recovery@email.com", compact: true,
  },
  {
    key: "emailRecoveryPassword", label: "Recovery Email Password", type: "password", tab: "account", subtab: "recovery",
    pairKey: "rec-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "recovery2fa", label: "Recovery 2FA Secret", type: "text", tab: "account", subtab: "recovery",
    pairKey: "rec-2", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "recoveryBackupCode", label: "Recovery Backup Code", type: "text", tab: "account", subtab: "recovery",
    pairKey: "rec-2", placeholder: "backup code...", compact: true,
  },

  // ── Account · Wallet · Manual ────────────────────────────────────────
  // (walletAddresses + backupCodes field-defs already exist further down
  // under tab: "wallet" — reused here for the Manual sub-tab. Seed phrase /
  // private key input is wired directly in vault.tsx since it maps to the
  // plaintext `seedPhrase` field, encrypted server-side, not a plain
  // SchemaForm text field.)

  // ── Twitter · Main ────────────────────────────────────────────────────
  {
    key: "twitterUsername", label: "Username", type: "text", tab: "twitter", subtab: "main",
    pairKey: "tw-main-1", placeholder: "@handle", compact: true,
  },
  {
    key: "twitterPassword", label: "Password", type: "password", tab: "twitter", subtab: "main",
    pairKey: "tw-main-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "twitterEmail", label: "Email", type: "text", tab: "twitter", subtab: "main",
    pairKey: "tw-main-2", placeholder: "tw@email.com", compact: true,
  },
  {
    key: "twitterEmailPassword", label: "Email Password", type: "password", tab: "twitter", subtab: "main",
    pairKey: "tw-main-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "twitter2fa", label: "Acct. 2FA Secret", type: "text", tab: "twitter", subtab: "main",
    pairKey: "tw-main-3", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "twitterAccountBackupCode", label: "Acct. Backup Code", type: "text", tab: "twitter", subtab: "main",
    pairKey: "tw-main-3", placeholder: "backup code...", compact: true,
  },
  {
    key: "twitterEmail2fa", label: "Email 2FA Secret", type: "text", tab: "twitter", subtab: "main",
    pairKey: "tw-main-4", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "twitterEmailBackupCode", label: "Email Backup Code", type: "text", tab: "twitter", subtab: "main",
    pairKey: "tw-main-4", placeholder: "backup code...", compact: true,
  },
  {
    key: "twitterNotes", label: "Notes", type: "textarea", tab: "twitter", subtab: "main",
    placeholder: "Airdrop notes, important info...", rows: 3,
  },

  // ── Twitter · Info ────────────────────────────────────────────────────
  {
    key: "twitterLastLoginAt", label: "Last Login", type: "date", tab: "twitter", subtab: "info",
    pairKey: "tw-info-date", compact: true,
  },
  {
    key: "twitterBuyDate", label: "Buy Date", type: "date", tab: "twitter", subtab: "info",
    pairKey: "tw-info-date", compact: true,
  },
  {
    key: "twitterCreateDate", label: "Create Date", type: "date", tab: "twitter", subtab: "info",
    pairKey: "tw-info-date", compact: true,
  },
  {
    key: "twitterFollowers", label: "Followers", type: "text", tab: "twitter", subtab: "info",
    pairKey: "tw-info-1", placeholder: "e.g. 1200", compact: true,
  },
  {
    key: "twitterAge", label: "Account Age", type: "text", tab: "twitter", subtab: "info",
    pairKey: "tw-info-1", placeholder: "e.g. 3 years", compact: true,
  },
  {
    key: "twitterWorth", label: "Worth ($)", type: "number", tab: "twitter", subtab: "info",
    pairKey: "tw-info-2", placeholder: "e.g. 80", compact: true,
  },
  {
    key: "twitterBuyValue", label: "Buy Value ($)", type: "number", tab: "twitter", subtab: "info",
    pairKey: "tw-info-2", placeholder: "e.g. 20", compact: true,
  },

  // ── Twitter · Recovery ────────────────────────────────────────────────
  {
    key: "twitterEmailRecovery", label: "Recovery Email", type: "text", tab: "twitter", subtab: "recovery",
    pairKey: "tw-rec-1", placeholder: "recovery@email.com", compact: true,
  },
  {
    key: "twitterEmailRecoveryPassword", label: "Recovery Email Pass", type: "password", tab: "twitter", subtab: "recovery",
    pairKey: "tw-rec-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "twitterRecovery2fa", label: "Recovery 2FA Secret", type: "text", tab: "twitter", subtab: "recovery",
    pairKey: "tw-rec-2", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "twitterRecoveryBackupCode", label: "Recovery Backup Code", type: "text", tab: "twitter", subtab: "recovery",
    pairKey: "tw-rec-2", placeholder: "backup code...", compact: true,
  },

  // ── Discord · Main ────────────────────────────────────────────────────
  {
    key: "discordUsername", label: "Username", type: "text", tab: "discord", subtab: "main",
    pairKey: "dc-main-1", placeholder: "user#1234", compact: true,
  },
  {
    key: "discordPassword", label: "Password", type: "password", tab: "discord", subtab: "main",
    pairKey: "dc-main-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "discordEmail", label: "Email", type: "text", tab: "discord", subtab: "main",
    pairKey: "dc-main-2", placeholder: "dc@email.com", compact: true,
  },
  {
    key: "discordEmailPassword", label: "Email Password", type: "password", tab: "discord", subtab: "main",
    pairKey: "dc-main-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "discord2fa", label: "Acct. 2FA Secret", type: "text", tab: "discord", subtab: "main",
    pairKey: "dc-main-3", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "discordAccountBackupCode", label: "Acct. Backup Code", type: "text", tab: "discord", subtab: "main",
    pairKey: "dc-main-3", placeholder: "backup code...", compact: true,
  },
  {
    key: "discordEmail2fa", label: "Email 2FA Secret", type: "text", tab: "discord", subtab: "main",
    pairKey: "dc-main-4", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "discordEmailBackupCode", label: "Email Backup Code", type: "text", tab: "discord", subtab: "main",
    pairKey: "dc-main-4", placeholder: "backup code...", compact: true,
  },
  {
    key: "discordNotes", label: "Notes", type: "textarea", tab: "discord", subtab: "main",
    placeholder: "Airdrop notes, important info...", rows: 3,
  },

  // ── Discord · Info ────────────────────────────────────────────────────
  {
    key: "discordLastLoginAt", label: "Last Login", type: "date", tab: "discord", subtab: "info",
    pairKey: "dc-info-date", compact: true,
  },
  {
    key: "discordBuyDate", label: "Buy Date", type: "date", tab: "discord", subtab: "info",
    pairKey: "dc-info-date", compact: true,
  },
  {
    key: "discordCreateDate", label: "Create Date", type: "date", tab: "discord", subtab: "info",
    pairKey: "dc-info-date", compact: true,
  },
  {
    key: "discordFollowers", label: "Followers", type: "text", tab: "discord", subtab: "info",
    pairKey: "dc-info-1", placeholder: "e.g. 300", compact: true,
  },
  {
    key: "discordAge", label: "Account Age", type: "text", tab: "discord", subtab: "info",
    pairKey: "dc-info-1", placeholder: "e.g. 2 years", compact: true,
  },
  {
    key: "discordWorth", label: "Worth ($)", type: "number", tab: "discord", subtab: "info",
    pairKey: "dc-info-2", placeholder: "e.g. 40", compact: true,
  },
  {
    key: "discordBuyValue", label: "Buy Value ($)", type: "number", tab: "discord", subtab: "info",
    pairKey: "dc-info-2", placeholder: "e.g. 10", compact: true,
  },

  // ── Discord · Recovery ────────────────────────────────────────────────
  {
    key: "discordEmailRecovery", label: "Recovery Email", type: "text", tab: "discord", subtab: "recovery",
    pairKey: "dc-rec-1", placeholder: "recovery@email.com", compact: true,
  },
  {
    key: "discordEmailRecoveryPassword", label: "Recovery Email Pass", type: "password", tab: "discord", subtab: "recovery",
    pairKey: "dc-rec-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "discordRecovery2fa", label: "Recovery 2FA Secret", type: "text", tab: "discord", subtab: "recovery",
    pairKey: "dc-rec-2", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "discordRecoveryBackupCode", label: "Recovery Backup Code", type: "text", tab: "discord", subtab: "recovery",
    pairKey: "dc-rec-2", placeholder: "backup code...", compact: true,
  },

  // ── Telegram · Main ───────────────────────────────────────────────────
  {
    key: "telegramUsername", label: "Username", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-1", placeholder: "@username", compact: true,
  },
  {
    key: "telegramPhone", label: "Phone", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-1", placeholder: "+1234567890", compact: true,
  },
  {
    key: "telegramPassword", label: "Password", type: "password", tab: "telegram", subtab: "main",
    pairKey: "tg-main-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "telegramLinkedEmail", label: "Linked Email", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-2", placeholder: "tg@email.com", compact: true,
  },
  {
    key: "telegramLinkedEmailPassword", label: "Email Password", type: "password", tab: "telegram", subtab: "main",
    pairKey: "tg-main-3", placeholder: "••••••••", compact: true,
  },
  {
    key: "telegram2fa", label: "Acct. 2FA Secret", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-3", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "telegramAccountBackupCode", label: "Acct. Backup Code", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-4", placeholder: "backup code...", compact: true,
  },
  {
    key: "telegramEmail2fa", label: "Email 2FA Secret", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-4", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "telegramEmailBackupCode", label: "Email Backup Code", type: "text", tab: "telegram", subtab: "main",
    pairKey: "tg-main-5", placeholder: "backup code...", compact: true,
  },
  {
    key: "telegramNotes", label: "Notes", type: "textarea", tab: "telegram", subtab: "main",
    placeholder: "Airdrop notes, important info...", rows: 3,
  },

  // ── Telegram · Info ───────────────────────────────────────────────────
  {
    key: "telegramLastLoginAt", label: "Last Login", type: "date", tab: "telegram", subtab: "info",
    pairKey: "tg-info-date", compact: true,
  },
  {
    key: "telegramBuyDate", label: "Buy Date", type: "date", tab: "telegram", subtab: "info",
    pairKey: "tg-info-date", compact: true,
  },
  {
    key: "telegramCreateDate", label: "Create Date", type: "date", tab: "telegram", subtab: "info",
    pairKey: "tg-info-date", compact: true,
  },
  {
    key: "telegramFollowers", label: "Followers", type: "text", tab: "telegram", subtab: "info",
    pairKey: "tg-info-1", placeholder: "e.g. 500", compact: true,
  },
  {
    key: "telegramAge", label: "Account Age", type: "text", tab: "telegram", subtab: "info",
    pairKey: "tg-info-1", placeholder: "e.g. 1 year", compact: true,
  },
  {
    key: "telegramWorth", label: "Worth ($)", type: "number", tab: "telegram", subtab: "info",
    pairKey: "tg-info-2", placeholder: "e.g. 25", compact: true,
  },
  {
    key: "telegramBuyValue", label: "Buy Value ($)", type: "number", tab: "telegram", subtab: "info",
    pairKey: "tg-info-2", placeholder: "e.g. 5", compact: true,
  },

  // ── Telegram · Recovery ───────────────────────────────────────────────
  {
    key: "telegramRecovery2fa", label: "Recovery 2FA Secret", type: "text", tab: "telegram", subtab: "recovery",
    pairKey: "tg-rec-1", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "telegramRecoveryBackupCode", label: "Recovery Backup Code", type: "text", tab: "telegram", subtab: "recovery",
    pairKey: "tg-rec-1", placeholder: "backup code...", compact: true,
  },

  {
    key: "walletAddresses", label: "Wallet Addresses (one per line)", type: "textarea", tab: "account", subtab: "wallet-manual",
    placeholder: "0x1234...\n0xabcd...", rows: 4,
  },
  {
    key: "backupCodes", label: "Backup Codes (one per line)", type: "textarea", tab: "account", subtab: "wallet-manual",
    placeholder: "backup-code-1\nbackup-code-2", rows: 3,
  },
];
