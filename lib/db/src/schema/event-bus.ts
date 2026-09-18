import { pgTable, text, integer, timestamp, jsonb, serial, unique, index } from "drizzle-orm/pg-core";

/**
 * schema/event-bus.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part A: Core Event Bus. See
 * migrations/110_ayzen_mega_engine_event_bus_phase_a.sql for the full
 * reasoning; this is the Drizzle mirror of those three tables, schema only
 * (no engine logic here — that lives in
 * artifacts/api-server/src/lib/event-bus/*, same
 * `lib/db` must-not-depend-on-engine-logic boundary every other schema
 * file in this directory documents for its own subsystem).
 *
 * `id` on event_outbox is TEXT, not SERIAL — the blueprint's EventEnvelope
 * (§4.1) requires a globally unique event id the *publisher* generates
 * before the row exists (so it can be logged/correlated even if the
 * insert itself fails), not one the database assigns on insert.
 */

export const eventOutboxTable = pgTable("event_outbox", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventVersion: integer("event_version").notNull().default(1),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),

  actor: jsonb("actor").$type<{ userId?: number; organizationId?: number; sessionId?: string; source?: string }>(),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  aggregateType: text("aggregate_type"),
  aggregateId: text("aggregate_id"),

  payload: jsonb("payload").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),

  // PENDING | PROCESSING | PUBLISHED | FAILED | DEAD_LETTER — see
  // event-bus/types.ts's OutboxStatus for the authoritative union; kept as
  // plain TEXT here rather than a Postgres enum for the same reason
  // schema/relationships.ts gives (no ALTER TYPE needed to add a status).
  status: text("status").notNull().default("PENDING"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  claimIdx: index("idx_event_outbox_claim").on(t.status, t.nextAttemptAt),
  aggregateIdx: index("idx_event_outbox_aggregate").on(t.aggregateType, t.aggregateId),
  correlationIdx: index("idx_event_outbox_correlation").on(t.correlationId),
}));

export type EventOutboxRow = typeof eventOutboxTable.$inferSelect;
export type NewEventOutboxRow = typeof eventOutboxTable.$inferInsert;

export const eventProcessedTable = pgTable("event_processed", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull(),
  consumer: text("consumer").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  eventConsumerUnique: unique().on(t.eventId, t.consumer),
  eventIdx: index("idx_event_processed_event").on(t.eventId),
}));

export type EventProcessedRow = typeof eventProcessedTable.$inferSelect;

export const eventDeadLetterTable = pgTable("event_dead_letter", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  consumer: text("consumer"), // null = dispatch-level failure, not a specific subscriber
  envelope: jsonb("envelope").notNull().$type<Record<string, unknown>>(),
  attemptCount: integer("attempt_count").notNull(),
  lastError: text("last_error"),
  status: text("status").notNull().default("PENDING"), // PENDING | REPLAYED | DISCARDED
  failedAt: timestamp("failed_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (t) => ({
  eventConsumerUnique: unique().on(t.eventId, t.consumer),
  typeIdx: index("idx_event_dead_letter_type").on(t.eventType),
  statusIdx: index("idx_event_dead_letter_status").on(t.status),
}));

export type EventDeadLetterRow = typeof eventDeadLetterTable.$inferSelect;
