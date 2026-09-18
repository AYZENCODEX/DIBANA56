import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";

// Phase 7 — Notification Bus. See migrations/108_ayzen_notification_bus_preferences.sql
// for the reasoning (opt-out model: missing row = every channel on).
export const notificationPreferencesTable = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  category: text("category").notNull(), // 'ryft' | 'skarn' | 'verve' | 'warde' | 'sylo' | 'wisp' | 'system'
  inApp: boolean("in_app").notNull().default(true),
  telegram: boolean("telegram").notNull().default(true),
  email: boolean("email").notNull().default(true),
  astra: boolean("astra").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  userCategoryUnique: unique().on(t.userId, t.category),
}));

export type NotificationPreference = typeof notificationPreferencesTable.$inferSelect;
