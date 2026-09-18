import { pgTable, serial, integer, real, text, timestamp } from "drizzle-orm/pg-core";

export const valueHistoryTable = pgTable("value_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sourceType: text("source_type").notNull(), // vault | local
  sourceId: integer("source_id").notNull(),
  target: text("target").notNull().default("account"),
  label: text("label"),
  // "value" (dollar worth, default) or "follower" — lets one table power
  // both the $ P&L panel and the follower-count P&L panel via ?metric=.
  metric: text("metric").notNull().default("value"),
  value: real("value").notNull(),
  buyValue: real("buy_value").notNull().default(0),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ValueHistory = typeof valueHistoryTable.$inferSelect;