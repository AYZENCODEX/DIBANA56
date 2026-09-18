import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/project-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Project Templates — see migrations/070_ayzen_project_templates.sql for the
 * full rationale. One-click prefill for admin/projects.tsx's "Initialize New
 * Protocol" dialog: an admin/moderator saves the recurring, non-identity
 * fields (category/type, tier/experience/duration/difficulty/cost, XP
 * system, tutorial link+steps, badges) once as a named template, then picks
 * it from a dropdown next time instead of re-filling the same Meta/Economics/
 * Tutorial tabs for every new "Exchange Campaign" or "L2 Airdrop" project.
 *
 * `data` is stored as a JSON string (same string-in/string-out convention as
 * projects.tutorial_steps/badges) rather than individual columns — see the
 * migration file for why. routes/project-templates.ts is the only place
 * that parses/validates its shape.
 */
export const projectTemplatesTable = pgTable("ayzen_project_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  data: text("data").notNull(),
  createdBy: integer("created_by").notNull(),
  // Extended in migration 071 — see that file's comments for each column.
  folder: text("folder"),
  usageCount: integer("usage_count").notNull().default(0),
  defaultForProjectType: text("default_for_project_type"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProjectTemplateSchema = createInsertSchema(projectTemplatesTable).omit({
  id: true, createdAt: true, updatedAt: true, usageCount: true,
});
export type InsertProjectTemplate = z.infer<typeof insertProjectTemplateSchema>;
export type ProjectTemplate = typeof projectTemplatesTable.$inferSelect;

// Allow-listed keys a template's `data` blob may carry — kept in one place
// so the route (write-time validation) and any future consumer agree on the
// exact same shape. Deliberately excludes identity/media/money fields
// (name, description, thumbnailUrl, bannerUrl, twitterHandle, discordUrl,
// websiteUrl, xpPrice-adjacent funding/reward numbers, deadline) — those
// stay per-project and are never templated. xpName/xpPrice ARE included
// since an XP system (e.g. "TXP" at a fixed rate) is often the one thing
// that's identical across a whole campaign family.
export const PROJECT_TEMPLATE_DATA_KEYS = [
  "category", "subcategory", "projectType", "exchangeSubType", "accountCategory",
  "tier", "experienceLevel", "durationType", "difficulty", "costType",
  "xpName", "xpPrice",
  "tutorialLink", "tutorialSteps", "badges",
] as const;
export type ProjectTemplateDataKey = typeof PROJECT_TEMPLATE_DATA_KEYS[number];
