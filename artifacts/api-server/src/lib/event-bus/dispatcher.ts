/**
 * lib/event-bus/dispatcher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §7 "dispatcher" / §9 "Event Delivery". Reads unpublished (PENDING/FAILED,
 * due) event_outbox rows, delivers each to every subscriber registered for
 * its type (subscriptions.ts), and advances each row's status. Claim/
 * lease/backoff/stale-lock-recovery shape is intentionally the same
 * pattern lib/mail-send-queue.ts already uses for its own durable
 * outbox-like queue — `FOR UPDATE SKIP LOCKED` claim, `locked_by`/
 * `locked_at` lease, startup + per-tick stale-lock sweeps, jittered
 * exponential backoff (retry.ts) — rather than inventing a second queueing
 * idiom in the same codebase.
 *
 * Delivery guarantees actually provided, matching §9 exactly:
 *   - at-least-once delivery (a crash between "handler ran" and "recorded
 *     processed" redelivers on the next tick)
 *   - per-(event, consumer) idempotency via idempotency.ts, so a handler
 *     itself never needs to guard against redelivery
 *   - dead-letter after retry.ts's MAX_DISPATCH_ATTEMPTS
 *   - correlation IDs pass straight through in the envelope
 *   - per-aggregate ordering is available via the aggregate index
 *     (migration 110) for a consumer that needs it, but this V1 dispatcher
 *     processes claimed rows within a batch independently/concurrently —
 *     a consumer with a hard ordering requirement should key its own
 *     idempotent apply logic off aggregate + a version/sequence field in
 *     the payload rather than relying on outbox dispatch order, same as
 *     §9 anticipates ("ordering per aggregate WHERE REQUIRED", not
 *     globally guaranteed by the bus itself in V1 — see §56's "what NOT
 *     to build in V1").
 *   - exactly-once is explicitly NOT promised (§9) — idempotency.ts is how
 *     exactly-once *business effects* are achieved instead, per §9's own
 *     framing.
 */
import cron from "node-cron";
import crypto from "crypto";
import { db, eventOutboxTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import { getSubscribers } from "./subscriptions";
import { isRegistered } from "./event-registry";
import { claimProcessing, hasProcessed, markProcessed, releaseProcessing } from "./idempotency";
import { moveToDeadLetter } from "./dead-letter";
import { nextAttemptDelayMs, shouldDeadLetter } from "./retry";
import {
  recordDispatched, recordHandlerFailure, recordRetried, recordDeadLettered,
  recordUnknownType, recordHandlerLatency, recordRetryStormThrottled,
  recordWorkerSweepStart, recordWorkerSweepEnd,
} from "./metrics";
import { getEngineCapacity, RetryStormGate, runWithConcurrency } from "../mega-engine/capacity";
import type { EventEnvelope } from "./types";

const WORKER_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const ENGINE_CAPACITY = getEngineCapacity();
const CLAIM_BATCH_SIZE = ENGINE_CAPACITY.eventBatchSize;
const MAX_IN_FLIGHT = ENGINE_CAPACITY.eventMaxInFlight;
const retryStormGate = new RetryStormGate(ENGINE_CAPACITY.retryStormWindowMs, ENGINE_CAPACITY.retryStormLimit);

// How long a row can sit locked in PROCESSING before the stale-lock sweep
// reclaims it — long enough that a legitimately slow subscriber chain
// isn't reclaimed out from under itself, short enough that a truly stuck
// row (worker died mid-dispatch) isn't stranded for long. Deliberately
// shorter than mail-send-queue's 5min: dispatching to in-process handlers
// has no external network call on the critical path the way a Resend send
// does, so a legitimate tick should never approach this.
const PROCESSING_STUCK_TIMEOUT_MS = 2 * 60_000;

function rowToEnvelope(row: typeof eventOutboxTable.$inferSelect): EventEnvelope {
  return {
    id: row.id,
    type: row.eventType,
    version: row.eventVersion,
    occurredAt: row.occurredAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString(),
    actor: (row.actor as EventEnvelope["actor"]) ?? undefined,
    traceId: row.traceId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    causationId: row.causationId ?? undefined,
    aggregate: row.aggregateType && row.aggregateId ? { type: row.aggregateType, id: row.aggregateId } : undefined,
    payload: row.payload,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
  };
}

/** Atomically claims up to `limit` due rows — same FOR UPDATE SKIP LOCKED idiom as mail-send-queue.ts's claimNextBatch(). */
async function claimNextBatch(limit: number): Promise<(typeof eventOutboxTable.$inferSelect)[]> {
  return db.transaction(async (trx) => {
    const claimable = await trx.execute(sql`
      SELECT id FROM event_outbox
      WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = (claimable.rows as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];

    return trx.update(eventOutboxTable)
      .set({ status: "PROCESSING", lockedAt: new Date(), lockedBy: WORKER_ID })
      .where(inArray(eventOutboxTable.id, ids))
      .returning();
  });
}

/**
 * Dispatches one claimed row to every subscriber for its type. Each
 * subscriber is attempted independently — one consumer's failure does not
 * stop delivery to the others, and a consumer already recorded as having
 * processed this event (idempotency.ts) is skipped without invoking its
 * handler again (redelivery-safe, per §9/§10).
 *
 * Returns the row's next state: PUBLISHED once every subscriber has
 * succeeded or was already-processed; otherwise FAILED (with backoff) or
 * DEAD_LETTER once retry.ts says to give up.
 */
async function dispatchRow(row: typeof eventOutboxTable.$inferSelect): Promise<void> {
  const envelope = rowToEnvelope(row);

  if (!isRegistered(envelope.type)) {
    // §6: unknown event types go to a controlled failure path — here,
    // straight to dead letter, since no amount of retrying makes an
    // unregistered type registered.
    recordUnknownType();
    await moveToDeadLetter({ envelope, consumer: null, attemptCount: row.attemptCount, lastError: `Event type "${envelope.type}" is not registered` });
    await db.update(eventOutboxTable).set({ status: "DEAD_LETTER", lockedBy: null, lockedAt: null, lastError: "Unregistered event type" })
      .where(sql`${eventOutboxTable.id} = ${row.id}`);
    return;
  }

  const subscribers = getSubscribers(envelope.type);
  const errors: string[] = [];

  for (const sub of subscribers) {
    let handlerStartedAt: number | null = null;
    try {
      if (await hasProcessed(envelope.id, sub.consumer)) continue; // already handled by this consumer — skip, don't re-invoke
      if (!(await claimProcessing(envelope.id, sub.consumer))) continue;
      // Part G1 — §39's `event_handler_latency`. Started just before the
      // handler call itself (not the hasProcessed() idempotency check
      // above, which is dedupe bookkeeping, not the handler's own work),
      // recorded in BOTH the success path below and the catch block —
      // this measures how long the handler took, independent of whether
      // it succeeded (see EventBusMetricsSnapshot.handlerLatencyMs's own
      // doc comment for why outcome is deliberately not folded in here).
      handlerStartedAt = Date.now();
      await sub.handler(envelope);
      recordHandlerLatency(Date.now() - handlerStartedAt);
      await markProcessed(envelope.id, sub.consumer);
      await releaseProcessing(envelope.id, sub.consumer);
      recordDispatched();
    } catch (err: any) {
      if (handlerStartedAt !== null) recordHandlerLatency(Date.now() - handlerStartedAt);
      const message = err?.message ?? String(err);
      errors.push(`[${sub.consumer}] ${message}`);
      logger.warn({ eventId: envelope.id, type: envelope.type, consumer: sub.consumer, err }, "Event Bus: subscriber handler failed");
      await releaseProcessing(envelope.id, sub.consumer);
    }
  }

  if (errors.length === 0) {
    await db.update(eventOutboxTable).set({ status: "PUBLISHED", publishedAt: new Date(), lockedBy: null, lockedAt: null, lastError: null })
      .where(sql`${eventOutboxTable.id} = ${row.id}`);
    return;
  }

  recordHandlerFailure();
  const attempts = row.attemptCount + 1;
  const combinedError = errors.join("; ").slice(0, 4000); // bounded — this is a diagnostics column, not a log store

  if (shouldDeadLetter(attempts)) {
    recordDeadLettered();
    // Only the subscribers that never succeeded should actually get
    // dead-lettered — a subscriber already marked processed (from an
    // earlier partial-success tick) has nothing left to retry.
    const stillFailing = subscribers.filter((s) => errors.some((e) => e.startsWith(`[${s.consumer}]`)));
    for (const sub of stillFailing) {
      await moveToDeadLetter({ envelope, consumer: sub.consumer, attemptCount: attempts, lastError: combinedError });
    }
    await db.update(eventOutboxTable).set({ status: "DEAD_LETTER", attemptCount: attempts, lastError: combinedError, lockedBy: null, lockedAt: null })
      .where(sql`${eventOutboxTable.id} = ${row.id}`);
    return;
  }

  recordRetried();
  const retryAllowed = retryStormGate.allow();
  if (!retryAllowed) recordRetryStormThrottled();
  const delay = retryAllowed ? nextAttemptDelayMs(attempts) : getEngineCapacity().retryStormWindowMs;
  await db.update(eventOutboxTable).set({
    status: "FAILED", attemptCount: attempts, lastError: combinedError,
    nextAttemptAt: new Date(Date.now() + delay), lockedBy: null, lockedAt: null,
  }).where(sql`${eventOutboxTable.id} = ${row.id}`);
  logger.info({ eventId: envelope.id, type: envelope.type, attempts, retryInMs: delay }, "Event Bus: will retry");
}

/** One worker tick: claim a batch, dispatch each row. Exposed for tests/manual triggering. */
export async function runEventBusDispatchSweep(): Promise<{ claimed: number }> {
  if (sweepInFlight) return { claimed: 0 };
  sweepInFlight = true;
  recordWorkerSweepStart();
  try {
    await recoverStaleLocks();

    const batch = await claimNextBatch(CLAIM_BATCH_SIZE);
    if (!batch.length) return { claimed: 0 };

    await runWithConcurrency(batch, MAX_IN_FLIGHT, dispatchRow);

    logBus.system(`📬 Event Bus sweep: dispatched ${batch.length} event(s)`);
    return { claimed: batch.length };
  } finally {
    recordWorkerSweepEnd();
    sweepInFlight = false;
  }
}

/** Per-tick stale-lock sweep — same reasoning as mail-send-queue.ts's recoverStaleLocks(): does not bump attemptCount, this is recovering an interrupted attempt, not counting a new failure. */
async function recoverStaleLocks(): Promise<void> {
  const cutoff = new Date(Date.now() - PROCESSING_STUCK_TIMEOUT_MS);
  const reclaimed = await db.execute(sql`
    UPDATE event_outbox
    SET status = 'FAILED', next_attempt_at = now(), locked_at = NULL, locked_by = NULL
    WHERE status = 'PROCESSING' AND locked_at < ${cutoff}
    RETURNING id
  `);
  const rows = reclaimed.rows as { id: string }[];
  if (!rows.length) return;
  logger.warn({ count: rows.length }, "Event Bus: reclaimed stale locked outbox rows");
  logBus.warn(`Event Bus: reclaimed ${rows.length} row(s) stuck in PROCESSING past ${PROCESSING_STUCK_TIMEOUT_MS / 1000}s (worker likely died mid-dispatch)`);
}

/** Startup recovery — same reasoning as mail-send-queue.ts's recoverOnStartup(). */
async function recoverOnStartup(): Promise<void> {
  const reset = await db.execute(sql`
    UPDATE event_outbox
    SET status = 'FAILED', next_attempt_at = now(), locked_at = NULL, locked_by = NULL
    WHERE status = 'PROCESSING'
    RETURNING id
  `);
  const count = (reset.rows as { id: string }[]).length;
  if (!count) return;
  logger.warn({ count }, "Event Bus: reset rows left in PROCESSING by a previous worker instance");
  logBus.warn(`Event Bus: reset ${count} row(s) left in PROCESSING on startup — recovering from a previous instance's crash/restart`);
}

let scheduled = false;
let sweepInFlight = false;
let scheduledTask: { stop: () => void; destroy?: () => void } | undefined;

/**
 * Starts the dispatcher's poll loop. Every 5s by default (same cadence as
 * the send queue — see EVENT_BUS_DISPATCH_CRON) since downstream
 * subscribers (Workflow, Notify, Audit per §1) are meant to feel
 * near-immediate, not batch-once-a-minute.
 */
export function startEventBusDispatcher(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.EVENT_BUS_DISPATCH_CRON ?? "*/5 * * * * *"; // every 5s
  if (!cron.validate(expr)) {
    scheduled = false;
    logger.warn({ expr }, "EVENT_BUS_DISPATCH_CRON is not a valid cron expression — Event Bus dispatcher disabled");
    logBus.warn(`Event Bus dispatcher disabled: invalid schedule "${expr}"`);
    return;
  }

  recoverOnStartup().catch((err) => {
    logger.error({ err }, "Event Bus startup recovery failed");
    logBus.error(`Event Bus startup recovery failed: ${err?.message ?? err}`);
  }).finally(() => {
    if (!scheduled) return;
    scheduledTask = cron.schedule(expr, () => {
      runEventBusDispatchSweep().catch((err) => {
        logger.error({ err }, "Event Bus dispatch sweep failed");
        logBus.error(`Event Bus dispatch sweep failed: ${err?.message ?? err}`);
      });
    });

    logBus.system(`✅ Event Bus dispatcher scheduled ("${expr}")`);
    logger.info({ expr, workerId: WORKER_ID }, "Event Bus dispatcher scheduled");
  });
}

/** J13 — stop claiming new work during graceful shutdown. In-flight handler
 * calls are allowed to finish; durable leases cover a crash before that. */
export function stopEventBusDispatcher(): void {
  scheduled = false;
  scheduledTask?.stop();
  scheduledTask?.destroy?.();
  scheduledTask = undefined;
  logger.info("Event Bus dispatcher stopped");
}

export function isEventBusDispatchInFlight(): boolean {
  return sweepInFlight;
}

export async function waitForEventBusIdle(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (sweepInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !sweepInFlight;
}
