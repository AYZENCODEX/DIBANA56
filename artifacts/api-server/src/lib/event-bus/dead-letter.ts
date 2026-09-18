/**
 * lib/event-bus/dead-letter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §57-E "dead-letter tools" / §61 health model's per-engine DLQ. An outbox
 * row that exhausted retry.ts's MAX_DISPATCH_ATTEMPTS (or referenced an
 * unregistered event type — a dispatch-level failure, §6) lands here with
 * its full envelope, so an operator can inspect why and, once fixed,
 * replay it without the original producer having to re-publish.
 */
import { db, eventDeadLetterTable, eventOutboxTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import type { EventEnvelope } from "./types";

/**
 * Records a dead letter. `consumer` is null for a dispatch-level failure
 * (event type not registered — no consumer was ever reached); otherwise
 * it's the specific subscriber whose handler kept failing, so a different
 * subscriber's successful handling of the SAME event isn't blocked by one
 * consumer's dead-letter (each (event, consumer) pair is independent —
 * matches event_processed's own per-consumer grain).
 */
export async function moveToDeadLetter(params: {
  envelope: EventEnvelope;
  consumer: string | null;
  attemptCount: number;
  lastError: string;
}): Promise<void> {
  const { envelope, consumer, attemptCount, lastError } = params;
  try {
    await db.insert(eventDeadLetterTable).values({
      eventId: envelope.id,
      eventType: envelope.type,
      consumer,
      envelope: envelope as unknown as Record<string, unknown>,
      attemptCount,
      lastError,
    });
  } catch (err: any) {
    const isUniqueViolation = err?.code === "23505" || /duplicate key/i.test(String(err?.message ?? ""));
    if (!isUniqueViolation) throw err; // already dead-lettered for this (event, consumer) — fine, leave the existing row
  }
  logger.warn({ eventId: envelope.id, type: envelope.type, consumer, attemptCount }, "Event moved to dead letter");
  logBus.warn(`Event Bus: "${envelope.type}" (${envelope.id}) dead-lettered after ${attemptCount} attempt(s)${consumer ? ` for consumer "${consumer}"` : ""}: ${lastError}`);
}

export async function listDeadLetters(filter?: { eventType?: string; status?: "PENDING" | "REPLAYED" | "DISCARDED" }) {
  const conditions = [];
  if (filter?.eventType) conditions.push(eq(eventDeadLetterTable.eventType, filter.eventType));
  if (filter?.status) conditions.push(eq(eventDeadLetterTable.status, filter.status));
  const rows = conditions.length
    ? await db.select().from(eventDeadLetterTable).where(and(...conditions))
    : await db.select().from(eventDeadLetterTable);
  return rows;
}

/**
 * §57-E replay — re-inserts a NEW outbox row (a fresh id; the original
 * event id is kept in metadata for traceability) rather than mutating the
 * dead-lettered row itself, so the dispatcher's normal claim/attempt
 * counting starts clean. Marks the dead-letter row REPLAYED so it drops
 * out of the PENDING operator queue without deleting the audit trail
 * (§60: "do not delete audit records merely because event records
 * expire" — same posture extended to dead-letter history).
 */
export async function replayDeadLetter(id: number): Promise<{ newEventId: string }> {
  const [row] = await db.select().from(eventDeadLetterTable).where(eq(eventDeadLetterTable.id, id)).limit(1);
  if (!row) throw new Error(`Dead letter row ${id} not found`);
  if (row.status !== "PENDING") throw new Error(`Dead letter row ${id} is already ${row.status}`);

  const original = row.envelope as unknown as EventEnvelope;
  const newEventId = crypto.randomUUID();

  await db.transaction(async (trx) => {
    await trx.insert(eventOutboxTable).values({
      id: newEventId,
      eventType: original.type,
      eventVersion: original.version,
      actor: original.actor,
      correlationId: original.correlationId,
      causationId: original.id, // the replayed event is caused by the original one
      aggregateType: original.aggregate?.type,
      aggregateId: original.aggregate?.id,
      payload: original.payload as Record<string, unknown>,
      metadata: { ...(original.metadata ?? {}), replayedFromDeadLetterId: id, replayedFromEventId: original.id },
    });
    await trx.update(eventDeadLetterTable).set({ status: "REPLAYED", resolvedAt: new Date() })
      .where(eq(eventDeadLetterTable.id, id));
  });

  logBus.system(`Event Bus: replayed dead letter #${id} ("${original.type}") as new event ${newEventId}`);
  return { newEventId };
}

export async function discardDeadLetter(id: number): Promise<void> {
  await db.update(eventDeadLetterTable).set({ status: "DISCARDED", resolvedAt: new Date() })
    .where(and(eq(eventDeadLetterTable.id, id), eq(eventDeadLetterTable.status, "PENDING")));
}
