import { pgTable, serial, text, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * page_layouts
 * ─────────────────────────────────────────────────────────────────────────────
 * One row = one named section on one page (e.g. "featured-stats" on
 * "user-dashboard"). `sortOrder` + `visible` are set by dragging/toggling
 * in the Layout Builder (/admin/layout-builder) and read back by the page
 * itself via usePageLayoutOrder() to decide what order to render its
 * sections in — same live-editable-without-redeploy idea as
 * dev_nav_items and config_entries, applied to page composition instead
 * of nav items / config arrays.
 *
 * Only pages that call usePageLayoutOrder() with their section keys are
 * actually reorderable in effect — registering a pageKey in
 * layout-sections.ts (the registry) just makes it selectable in the
 * builder UI.
 */
export const pageLayoutsTable = pgTable("page_layouts", {
  id: serial("id").primaryKey(),
  pageKey: text("page_key").notNull(),
  sectionKey: text("section_key").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  pageSectionUnique: uniqueIndex("page_layouts_page_section_idx").on(t.pageKey, t.sectionKey),
}));
