import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * schema/emergency-access.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 *
 * Two tables:
 *
 *   emergency_contacts — who an owner has nominated, and after how many days
 *   of the owner's inactivity (users.lastActiveAt) that nomination becomes
 *   eligible to trigger a grant. Nothing here can read the vault by itself —
 *   it only records the *nomination*.
 *
 *   emergency_access_grants — one row per triggered dead-man-switch event.
 *   Created by lib/emergency-access-cron.ts the moment an active contact's
 *   waitDays threshold is crossed, status "pending_admin_review". The owner
 *   can cancel it themselves at any time before an admin acts (proof of life
 *   — see routes/emergency-access.ts POST /emergency-access/grants/:id/cancel).
 *   An admin must additionally approve before a token is minted — this is
 *   the "admin approval" step from the feature spec, a second gate on top of
 *   the inactivity timer so a single stale lastActiveAt read (e.g. a paused
 *   account, a long trip) can't hand over a vault on its own.
 *
 * Deliberately NOT a cascade/FK relationship to vault_entries — same
 * rationale as vault_activity_log/vault_field_history (schema/vault.ts):
 * these are audit/workflow rows, kept even if the underlying entries change.
 */
export const emergencyContactsTable = pgTable("emergency_contacts", {
  id: serial("id").primaryKey(),
  // The vault owner who nominated this contact.
  userId: integer("user_id").notNull(),
  contactName: text("contact_name").notNull(),
  contactEmail: text("contact_email").notNull(),
  // Set once the contact accepts the invite email and (optionally) has/creates
  // an AYZEN account — nullable, a grant can still be emailed to contactEmail
  // without one.
  contactUserId: integer("contact_user_id"),
  // Days of owner inactivity (NOW() - users.last_active_at) before this
  // contact becomes eligible to trigger a grant. Independent per contact —
  // an owner can nominate a "30-day" contact and a "90-day" contact.
  waitDays: integer("wait_days").notNull().default(30),
  // active | revoked — revoked contacts are kept (audit trail) instead of
  // deleted; the cron and every route treat non-"active" as inert.
  status: text("status").notNull().default("active"),
  // Random token mailed to contactEmail to confirm the nomination before
  // it's live — an owner mistyping an email address should not silently
  // hand a stranger a dead-man switch. NULL once confirmed.
  inviteToken: text("invite_token"),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const emergencyAccessGrantsTable = pgTable("emergency_access_grants", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull(),
  ownerUserId: integer("owner_user_id").notNull(),
  // pending_admin_review | approved | denied | cancelled | expired | revoked
  status: text("status").notNull().default("pending_admin_review"),
  // users.last_active_at snapshot at the moment the cron triggered this —
  // kept for the admin-review screen, since the live value keeps moving.
  ownerInactiveSinceAt: timestamp("owner_inactive_since_at"),
  triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
  // Owner clicking "I'm here" cancels their own grant — see file header.
  cancelledAt: timestamp("cancelled_at"),
  adminReviewedBy: integer("admin_reviewed_by"),
  adminReviewedAt: timestamp("admin_reviewed_at"),
  adminNote: text("admin_note"),
  // Minted only on admin approval — single bearer token the contact uses to
  // view a read-only, decrypted export of the owner's vault. Hashed at rest
  // (see lib/emergency-access-token.ts) exactly like passkey/session
  // credentials elsewhere in this codebase — never store it raw.
  accessTokenHash: text("access_token_hash"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  accessedAt: timestamp("accessed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type EmergencyContact = typeof emergencyContactsTable.$inferSelect;
export type EmergencyAccessGrant = typeof emergencyAccessGrantsTable.$inferSelect;
