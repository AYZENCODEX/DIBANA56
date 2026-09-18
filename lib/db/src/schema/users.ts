import { pgTable, serial, text, boolean, timestamp, real, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("active"),
  avatarUrl: text("avatar_url"),
  ayzenEmail: text("ayzen_email"),
  // AYZEN Email (username@<domain>, Cloudflare Email Routing) — see
  // routes/email-routing.ts and migrations/035_ayzen_email_verification.sql.
  // ayzenEmailVerified only flips true once Cloudflare confirms the
  // forward-to destination address is verified; until then the CF routing
  // rule exists but stays disabled and no mail actually gets delivered.
  ayzenEmailVerified: boolean("ayzen_email_verified").notNull().default(false),
  ayzenEmailForwardTo: text("ayzen_email_forward_to"),
  ayzenEmailCfRuleId: text("ayzen_email_cf_rule_id"),
  ayzenEmailCfAddressId: text("ayzen_email_cf_address_id"),
  ayzenEmailMode: text("ayzen_email_mode").notNull().default("forward"), // 'forward' | 'native'
  // Native mailbox compose signature — see
  // migrations/041_ayzen_mailbox_compose_upgrade.sql. Stored as HTML (the
  // compose box is a rich editor); ComposeDialog inserts it into new
  // messages only, not replies/forwards, when signatureEnabled is true.
  ayzenMailboxSignature: text("ayzen_mailbox_signature"),
  ayzenMailboxSignatureEnabled: boolean("ayzen_mailbox_signature_enabled").notNull().default(true),
  twoFaEnabled: boolean("two_fa_enabled").notNull().default(false),
  twoFaSecret: text("two_fa_secret"),
  emailVerified: boolean("email_verified").notNull().default(false),
  totalRoi: real("total_roi").notNull().default(0),
  walletCount: integer("wallet_count").notNull().default(0),
  streak: integer("streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  bio: text("bio"),
  twitterHandle: text("twitter_handle"),
  discordHandle: text("discord_handle"),
  websiteUrl: text("website_url"),
  telegramHandle: text("telegram_handle"),
  telegramChatId: text("telegram_chat_id"),
  telegramUsername: text("telegram_username"),
  whatsappNumber: text("whatsapp_number"),
  facebookUrl: text("facebook_url"),
  location: text("location"),
  kycLevel: integer("kyc_level").notNull().default(0),
  kycVerified: boolean("kyc_verified").notNull().default(false),
  kycStatus: text("kyc_status").notNull().default("none"), // none | pending | approved | rejected
  kycSubmittedAt: timestamp("kyc_submitted_at"),
  kycReviewedAt: timestamp("kyc_reviewed_at"),
  kycReviewedBy: integer("kyc_reviewed_by"),
  kycRejectionReason: text("kyc_rejection_reason"),
  referralCode: text("referral_code").unique(),
  referredBy: integer("referred_by"),
  recoveryEmail: text("recovery_email"),
  // Vault/dashboard digest delivery preference (Telegram + email). The
  // underlying health scan always runs every 6h (see vault-health-cron.ts)
  // so flags stay fresh; this only controls how often the user is actually
  // notified, so daily/weekly/monthly users aren't spammed by the 6h scan.
  digestFrequency: text("digest_frequency").notNull().default("daily"), // daily | weekly | monthly
  lastDigestSentAt: timestamp("last_digest_sent_at"),
  // Undo Send (Phase 2) — see migrations/051_ayzen_mailbox_undo_send_phase2.sql
  // and routes/mail-undo-send-settings.ts. Phase 1 only had a single
  // operator-set MAIL_UNDO_SEND_WINDOW_MS env var applied to every user;
  // this is the per-user Settings replacement (Gmail-style 5/10/20/30s
  // choices). lib/mail-send-queue.ts's enqueueSend() reads this off the
  // user row instead of the env var when queuing an immediate send, and
  // falls back to the env-derived default if it's ever out of range.
  mailUndoSendWindowMs: integer("mail_undo_send_window_ms").notNull().default(8000),
  // Separate cadence tracker for the Finance module's own daily digest (see
  // lib/finance-notify.ts / lib/finance-digest-cron.ts) — kept independent
  // of the vault digest above so the two features never fight over the same
  // "did we already send today" flag.
  financeLastDigestSentAt: timestamp("finance_last_digest_sent_at"),
  lastActiveAt: timestamp("last_active_at"),
  // Invoice branding (lib/finance-invoice.ts / lib/invoice-pdf.ts) — one set
  // per user, reused on every invoice they send rather than set per-invoice,
  // shown on both the itemized PDF and the public repay page.
  financeInvoiceLogoUrl: text("finance_invoice_logo_url"),
  financeInvoiceThemeColor: text("finance_invoice_theme_color").notNull().default("#00a89f"),
  financeInvoiceBusinessName: text("finance_invoice_business_name"),
  financeInvoiceBusinessAddress: text("finance_invoice_business_address"),
  financeInvoiceFooterNote: text("finance_invoice_footer_note"),
  // Enterprise-grade additions (migration 034) — business identity fields
  // shown in the PDF header/footer alongside the name/address/logo above,
  // plus the default Terms & Conditions text and the prefix used when
  // minting each invoice's human invoice_number (see finance-invoice.ts's
  // formatInvoiceNumber).
  financeInvoiceTaxId: text("finance_invoice_tax_id"),
  financeInvoiceBusinessEmail: text("finance_invoice_business_email"),
  financeInvoiceBusinessPhone: text("finance_invoice_business_phone"),
  financeInvoiceWebsite: text("finance_invoice_website"),
  financeInvoiceTerms: text("finance_invoice_terms"),
  financeInvoiceNumberPrefix: text("finance_invoice_number_prefix").notNull().default("INV"),
  financeSmsWebhookToken: text("finance_sms_webhook_token").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
