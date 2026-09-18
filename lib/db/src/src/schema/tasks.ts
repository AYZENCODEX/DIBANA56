import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id"),
  name: text("name").notNull(),
  description: text("description"),
  rewardAmount: real("reward_amount"),
  xpAmount: real("xp_amount").notNull().default(0),
  verificationType: text("verification_type").notNull().default("manual"),
  taskType: text("task_type").notNull().default("One-time"),
  completionCount: integer("completion_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const taskSubmissionsTable = pgTable("task_submissions", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull(),
  userId: integer("user_id").notNull(),
  status: text("status").notNull().default("pending"),
  proofUrl: text("proof_url"),
  notes: text("notes"),
  rejectionReason: text("rejection_reason"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  cost: real("cost"),
  profit: real("profit"),
  roi: real("roi"),
  entityId: integer("entity_id"),
  entityIds: text("entity_ids"),
  costCategory: text("cost_category"),
  profitCategory: text("profit_category"),
  costEntries: text("cost_entries"),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true, completionCount: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
