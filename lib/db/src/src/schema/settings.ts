import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  platformName: text("platform_name").notNull().default("AYZEN"),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").notNull().default("#06b6d4"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpUser: text("smtp_user"),
  smtpPassword: text("smtp_password"),
  smtpFrom: text("smtp_from"),
  telegramBotUsername: text("telegram_bot_username"),
  telegramWebhookUrl: text("telegram_webhook_url"),
  customDomain: text("custom_domain"),
  twoFaIssuerName: text("two_fa_issuer_name").notNull().default("AYZEN"),
  // Admin payment methods — used as the destination the admin shows to users
  // buying AZN credits directly from the platform (not the peer marketplace).
  bkashNumber: text("bkash_number"),
  nagadNumber: text("nagad_number"),
  usdtAddress: text("usdt_address"),
  usdtNetwork: text("usdt_network").default("TRC20"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const pluginsTable = pgTable("plugins", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: text("config"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const errorLogsTable = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("ERROR"),
  message: text("message").notNull(),
  endpoint: text("endpoint"),
  stack: text("stack"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});
