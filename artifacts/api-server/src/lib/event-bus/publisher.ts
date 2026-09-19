/**
 * lib/event-bus/publisher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §7 "Publish Semantics" / §8 "Transactional Outbox". This is the one
 * function every domain module should call instead of the fire-and-forget
 * pattern §7 explicitly rules out ("DB commit + fire-and-forget Promise").
 *
 * publishEvent(params, tx) takes the SAME transaction handle the caller's
 * business write is already inside (identical calling convention to
 * lib/mail-send-queue.ts's enqueueSend(tx, ...) — see that file's header
 * for why this matters): the outbox row is written in the same commit as
 * the business rows, so "transaction succeeded but the process crashed
 * before publishing" (§7) cannot lose the event — it's already durably
 * PENDING in event_outbox the moment the caller's transaction commits,
 * ready for the dispatcher's claim/lease sweep to pick up on its own,
 * independent schedule.
 *
 * Calling publishEvent() with no `tx` (outside any transaction) is
 * supported for callers that have no other DB write to piggyback on, but
 * is the weaker guarantee §7 warns about narrowed to just this one insert
 * — there's no larger transaction for it to be atomic WITH. Prefer passing
 * `tx` whenever the event is a direct consequence of a DB write you're
 * already making.
 */
import crypto from "crypto";
import { db, eventOutboxTable } from "@workspace/db";
import { logger } from "../logger";
import { validateEventPayload, getEventDefinition } from "./event-registry";
import { recordPublished, recordPublishLatency } from "./metrics";
import type { EventEnvelope, PublishEventParams } from "./types";
import { ensureTraceId, getCurrentTraceContext } from "../trace-context";

// Same shape as db.transaction(async (tx) => ...)'s callback param —
// inferred straight off `db`, matching mail-send-queue.ts's DbTx alias so
// callers can pass the exact same `tx` they already have from their own
// db.transaction() block without an extra cast.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Writes one event to the outbox. Returns the generated envelope id
 * (callers rarely need it — mainly useful for logging/testing).
 *
 * Throws UnknownEventTypeError (via validateEventPayload) if `type` was
 * never registered with event-registry.ts's registerEvent() — per §6,
 * an unregistered type is a controlled failure at publish time, not
 * something that silently reaches the outbox and fails later in the
 * dispatcher.
 */
export async function publishEvent<T = unknown>(
  params: PublishEventParams<T>,
  tx?: DbTx,
): Promise<{ id: string }> {
  const validatedPayload = validateEventPayload<T>(params.type, params.payload);
  const def = getEventDefinition(params.type);

  const requestContext = getCurrentTraceContext();
  const correlationId = params.correlationId ?? requestContext?.correlationId;
  const causationId = params.causationId ?? requestContext?.causationId;
  const envelope: EventEnvelope<T> = {
    id: crypto.randomUUID(),
    type: params.type,
    version: params.version ?? def?.version ?? 1,
    occurredAt: new Date().toISOString(),
    actor: params.actor,
    traceId: ensureTraceId(params.traceId, correlationId),
    correlationId,
    causationId,
    aggregate: params.aggregate,
    payload: validatedPayload,
    metadata: params.metadata,
  };

  const executor = tx ?? db;
  // Part G1 — §39's `event_publish_latency`: the durable-insert half of
  // §59's "low-millisecond local publish path" target, measured directly
  // around the one write this function actually does (payload validation
  // above is synchronous/cheap and deliberately excluded, same "measure
  // the I/O, not the whole function" scope engine.ts's step_duration
  // recording below draws too).
  const insertStartedAt = Date.now();
  await executor.insert(eventOutboxTable).values({
    id: envelope.id,
    eventType: envelope.type,
    eventVersion: envelope.version,
    occurredAt: new Date(envelope.occurredAt),
    actor: envelope.actor,
    traceId: envelope.traceId,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    aggregateType: envelope.aggregate?.type,
    aggregateId: envelope.aggregate?.id,
    payload: envelope.payload as Record<string, unknown>,
    metadata: envelope.metadata,
  });
  recordPublishLatency(Date.now() - insertStartedAt);

  recordPublished();
  logger.debug({ eventId: envelope.id, type: envelope.type, correlationId: envelope.correlationId }, "Event published to outbox");
  return { id: envelope.id };
}

/**
 * Convenience wrapper for the common case of "this event IS the whole
 * transaction" (no other business write to piggyback on) — opens its own
 * transaction around a single outbox insert rather than making every
 * simple call site write `db.transaction(async (tx) => publishEvent(..., tx))`
 * by hand. Prefer publishEvent(params, tx) directly whenever you already
 * have a `tx` from your own business write (see this file's header).
 */
export async function publishEventStandalone<T = unknown>(params: PublishEventParams<T>): Promise<{ id: string }> {
  return db.transaction(async (trx) => publishEvent(params, trx));
}
