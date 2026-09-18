import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * credit_action_pricing
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 5 — admin credit console.
 *
 * `services/credit-meter.ts`'s `METERED_ACTIONS` map is still the source of
 * truth for WHICH actions exist (key, app, label) and their default cost —
 * that stays a code change, same as before. This table is only the admin
 * console's override layer on top of it: one row per action the admin has
 * touched, so "set the fee for wallet creation to 4 credits" or "waive the
 * fee on mail view for now" is a PATCH from the admin console, not a code
 * deploy. An action with no row here just uses its code default.
 *
 * `enabled = false` means the fee is waived (effective cost 0) — it does
 * NOT hide or block the action. Per the master plan (§5): tiers/pricing
 * never become feature walls, so there is deliberately no "disabled action
 * refuses the request" path anywhere in credit-meter.ts.
 */
export const creditActionPricingTable = pgTable("credit_action_pricing", {
  id: serial("id").primaryKey(),
  actionKey: text("action_key").notNull().unique(),
  cost: integer("cost"), // null = fall back to the code default in METERED_ACTIONS
  enabled: boolean("enabled").notNull().default(true), // false = fee waived (cost treated as 0); never gates the feature itself
  updatedBy: integer("updated_by"), // admin userId who last changed this row
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CreditActionPricingRow = typeof creditActionPricingTable.$inferSelect;
