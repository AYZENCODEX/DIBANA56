import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  xpName: text("xp_name"),
  xpPrice: real("xp_price").notNull().default(0.01),
  twitterHandle: text("twitter_handle"),
  discordUrl: text("discord_url"),
  websiteUrl: text("website_url"),
  tutorialLink: text("tutorial_link"),
  experienceLevel: text("experience_level").notNull().default("Beginner"),
  tier: text("tier").notNull().default("1"),
  fundingAmount: real("funding_amount").notNull().default(0),
  rewardEstimate: real("reward_estimate").notNull().default(0),
  thumbnailUrl: text("thumbnail_url"),
  // Project banner (wide hero image) — data-URL or external URL, same storage
  // convention as thumbnailUrl (project photo). Added alongside tutorialSteps below.
  bannerUrl: text("banner_url"),
  // JSON-stringified array of {title, description, link} — structured
  // tutorial step builder (replaces/augments the old freeform tutorial_notes).
  tutorialSteps: text("tutorial_steps"),
  // Phase 7A (Vault/Project/Team Overhaul roadmap doc) — JSON-stringified
  // array of strings, same storage convention as tutorialSteps above.
  // Editable in admin (project-detail.tsx Settings tab); rendered on
  // cards/detail/compare in Phase 7B.
  badges: text("badges"),
  totalRoiDistributed: real("total_roi_distributed").notNull().default(0),
  // project_type/exchange_sub_type/account_category added in Phase 12; project_status
  // added in Phase 26 (see MIGRATIONS in artifacts/api-server/src/index.ts).
  projectType: text("project_type"),
  exchangeSubType: text("exchange_sub_type"),
  accountCategory: text("account_category"),
  projectStatus: text("project_status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userProjectsTable = pgTable("user_projects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  projectId: integer("project_id").notNull(),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
});

export const projectEnrollmentsTable = pgTable("project_enrollments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  projectId: integer("project_id").notNull(),
  vaultEntryId: integer("vault_entry_id").notNull(),
  status: text("status").notNull().default("active"),
  // Phase 3 — JSON-stringified snapshot of the Main/Info/Recovery account
  // fields (see ENTITY_FIELDS tab: "account"), captured at enroll time and
  // scoped to this project — independent of the entity's own vault_entries
  // row, since the same entity can run a different account per project.
  accountData: text("account_data"),
  // Exchange enrollment shortcut — set when this enrollment was created by
  // picking an existing KYC Entity (matching the project's platform) instead
  // of filling the manual form; accountData above was auto-filled from that
  // KYC Entity's own fields. NULL for every manual enrollment.
  kycEntryId: integer("kyc_entry_id"),
  // Data Entity picked on a manual "Other"-platform enrollment's form.
  dataEntityId: integer("data_entity_id"),
  enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
});

// Per-entity ROI ledger for a project (created in Phase 2 of MIGRATIONS).
// roi is a Postgres GENERATED column (total_profit - total_cost) — read-only,
// never set on insert/update.
export const entityProjectRoiTable = pgTable("entity_project_roi", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  vaultEntryId: integer("vault_entry_id").notNull(),
  projectId: integer("project_id").notNull(),
  totalCost: real("total_cost").notNull().default(0),
  totalProfit: real("total_profit").notNull().default(0),
  roi: real("roi"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
});

// One rating per user per project (upsert on user_id+project_id). Added in Phase 26.
export const projectRatingsTable = pgTable("project_ratings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  projectId: integer("project_id").notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Airdrop calendar — one row per important date for a project (token snapshot,
// TGE, claim deadline, whitelist deadline, etc). Feeds the centralized calendar
// view (GET /project-dates) and the 1-day-ahead Telegram reminder cron (see
// lib/airdrop-reminder-cron.ts). remindedAt is set once the reminder for that
// date has been sent, so the cron never double-sends.
export const projectDatesTable = pgTable("project_dates", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  label: text("label").notNull(), // e.g. "Token Snapshot", "TGE", "Claim Deadline"
  eventType: text("event_type").notNull().default("snapshot"), // snapshot | deadline | tge | claim | other
  eventDate: timestamp("event_date").notNull(),
  notes: text("notes"),
  remindedAt: timestamp("reminded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProjectDateSchema = createInsertSchema(projectDatesTable).omit({
  id: true, createdAt: true, remindedAt: true,
});
export type InsertProjectDate = z.infer<typeof insertProjectDateSchema>;
export type ProjectDate = typeof projectDatesTable.$inferSelect;

// Public, shareable "P&L card" receipt link — one per (user, project) pair.
// Snapshot of the user's aggregate ROI ledger for a project (same numbers as
// GET /projects/:id/roi-summary), handed out as a link/PDF instead of
// requiring the recipient to have an AYZEN account. See routes/projects.ts
// "Public receipt link" section and migrations/022_entity_receipts.sql.
export const projectPnlReceiptsTable = pgTable("project_pnl_receipts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  projectId: integer("project_id").notNull(),
  receiptToken: text("receipt_token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, totalRoiDistributed: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
export type ProjectEnrollment = typeof projectEnrollmentsTable.$inferSelect;
export type EntityProjectRoi = typeof entityProjectRoiTable.$inferSelect;
export type ProjectRating = typeof projectRatingsTable.$inferSelect;
export type ProjectPnlReceipt = typeof projectPnlReceiptsTable.$inferSelect;
