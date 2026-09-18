import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";

// Generic, reusable activity/event log. subject_type + subject_id identify
// *what* the row is about (e.g. subject_type="project_enrollment",
// subject_id=project_enrollments.id) — every feature that needs an audit
// trail or event timeline reuses this one table instead of a bespoke one.
//
// Phase 4 (Vault/Project/Team Overhaul roadmap) uses this for per-entity
// project-enrollment history: "enrolled" / "left" / "reward" events.
// Phase 15 will reuse it for team-level activity (subject_type="team") —
// do not fork a second log table for that; add a new subject_type instead.
export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  // Free-form action string — e.g. "enrolled", "left", "reward",
  // "disqualified", "banned", "cancelled" (Phase 5 adds the last three).
  action: text("action").notNull(),
  // Who performed/triggered the action (nullable — some events are system-generated).
  actorUserId: integer("actor_user_id"),
  // Populated for reward-type events; null otherwise. Running totals are
  // always computed from SUM(amount) over the log at read time, never
  // stored, so they can never drift out of sync.
  amount: real("amount"),
  // JSON-stringified free-form context (projectId, vaultEntryId, taskId, reason, etc).
  meta: text("meta"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ActivityLogRow = typeof activityLogTable.$inferSelect;
