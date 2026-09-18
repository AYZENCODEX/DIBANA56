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
  lastActiveAt: timestamp("last_active_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
