import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * `content` (added for the WordPress-style page builder): the HTML body
 * rendered by DevCustomPage (client/pages/dev/custom-page.tsx) for a nav
 * item's auto-generated blank page. Null/empty = still showing the
 * "not wired up yet" placeholder. Only dev/admin can write it — same
 * requireDev gate as the rest of this table — so it's treated as
 * trusted-author HTML (sanitized against <script>/inline-handler
 * injection client-side before render, same as any other admin-authored
 * WYSIWYG field).
 */

/**
 * dev_nav_items
 * ─────────────────────────────────────────────────────────────────────────────
 * Backs every fully-configurable sidebar, scoped by navType:
 *   "dev" | "user" | "admin" | "moderator" | "team_leader"
 * (table/export names kept as "dev_nav_items"/devNavItemsTable for backward
 * compatibility — it originally only backed the Dev sidebar before the
 * navType column was added).
 *
 * Supports up to 3 levels via the self-referencing parentId, independently
 * per navType:
 *   level 1 → category   (top of sidebar, no href — just a header)
 *   level 2 → section/link (direct link, or a section if it has level-3 children)
 *   level 3 → sub-item   (always a direct link)
 *
 * pluginSlug (optional) hides an item when that plugin is disabled — mirrors
 * the pluginSlug gating the old hardcoded nav arrays used.
 *
 * Adding an item without an explicit href auto-generates one
 * (/<navType>/custom/:slug, "/dev/custom/:slug" for navType "dev") that
 * resolves to a blank placeholder page — new sidebar entries are usable
 * immediately, no code changes required.
 */
export const devNavItemsTable = pgTable("dev_nav_items", {
  id: serial("id").primaryKey(),
  navType: text("nav_type").notNull().default("dev"),
  parentId: integer("parent_id"),
  level: integer("level").notNull().default(1),
  label: text("label").notNull(),
  icon: text("icon").notNull().default("Circle"),
  href: text("href"),
  content: text("content"),
  pluginSlug: text("plugin_slug"),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  isSeed: boolean("is_seed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const NAV_TYPES = ["dev", "user", "admin", "moderator", "team_leader"] as const;
export type NavType = (typeof NAV_TYPES)[number];
