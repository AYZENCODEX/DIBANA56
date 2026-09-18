/**
 * lib/event-bus/idempotency.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §10 — "every consumer of a critical event should be able to safely
 * receive the same event more than once." Rather than trusting every
 * subscriber's handler to implement that itself, the dispatcher enforces
 * it centrally: a (event_id, consumer) pair recorded here is never
 * dispatched to that consumer's handler again, full stop.
 */
import { db, eventProcessedTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function hasProcessed(eventId: string, consumer: string): Promise<boolean> {
  const [row] = await db.select({ id: eventProcessedTable.id }).from(eventProcessedTable)
    .where(and(eq(eventProcessedTable.eventId, eventId), eq(eventProcessedTable.consumer, consumer)))
    .limit(1);
  return !!row;
}

/**
 * Records a successful (event_id, consumer) handling. Swallows a unique-
 * violation race (two dispatcher ticks — different process instances —
 * both dispatched the same event to the same consumer before either
 * committed) as a no-op success rather than throwing: the outcome either
 * way is "this consumer has processed this event," which is exactly what
 * the caller wants recorded, regardless of which insert won the race.
 */
export async function markProcessed(eventId: string, consumer: string): Promise<void> {
  try {
    await db.insert(eventProcessedTable).values({ eventId, consumer });
  } catch (err: any) {
    const isUniqueViolation = err?.code === "23505" || /duplicate key/i.test(String(err?.message ?? ""));
    if (!isUniqueViolation) throw err;
  }
}
