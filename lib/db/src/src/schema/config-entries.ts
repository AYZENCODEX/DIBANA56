import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * config_entries
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic, domain-scoped config rows backing the "Config Manager" dev tool.
 * Each row is one item in a flat array — e.g. one AZN payment method, one
 * currency, one project category — that previously lived only as a hardcoded
 * TS array in artifacts/ayzen/src/config/*.ts (see docs/UI_CONFIG_PLAN.md).
 *
 * `domain` identifies which array this row belongs to (a slug registered in
 * CONFIG_DOMAINS on the backend, e.g. "marketplace-azn-payment-methods").
 * `data` is the arbitrary JSON payload for that entry — shape differs per
 * domain. Icon fields are stored as a string name (resolved client-side via
 * the shared icon map), never a component reference, since those aren't
 * serializable.
 *
 * Only domains a page has actually been wired to read from this table (via
 * its own hook call) are live-editable in effect — registering a domain here
 * without updating its consuming page just stores data nobody reads yet.
 */
export const configEntriesTable = pgTable("config_entries", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull(),
  data: jsonb("data").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  isSeed: boolean("is_seed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
