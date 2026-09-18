/**
 * lib/event-bus/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part A: Core Event Bus
 * (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md §4/§9/§57-A).
 *
 * Everything in this file is a type/shape only — no DB access, no I/O —
 * so every other event-bus/*.ts file (and every future domain module that
 * publishes or subscribes) can import it without pulling in the engine's
 * runtime.
 */
import type { z } from "zod/v4";
import type { LatencySnapshot } from "../latency-histogram";

/** §4.1 — the envelope every event on the bus must use. */
export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  version: number;

  occurredAt: string; // ISO 8601
  publishedAt?: string;

  actor?: {
    userId?: number;
    organizationId?: number;
    sessionId?: string;
    source?: string;
  };

  traceId?: string;
  correlationId?: string;
  causationId?: string;

  aggregate?: {
    type: string;
    id: string;
  };

  payload: T;

  metadata?: Record<string, unknown>;
}

/** §8 — the outbox row's lifecycle. */
export type OutboxStatus = "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED" | "DEAD_LETTER";

/** §60 — dead-letter rows are operator-resolved, not just retried forever. */
export type DeadLetterStatus = "PENDING" | "REPLAYED" | "DISCARDED";

/** §62 — governance metadata every registered event type should declare. */
export interface EventDefinition<T = unknown> {
  type: string;
  version: number;
  /** Validated against `payload` at publish time when provided (§6: schema validation). */
  schema?: z.ZodType<T>;
  owner?: string;
  description?: string;
  /** §6: deprecation status. A deprecated type can still publish (existing producers keep working) but new call sites should be flagged in review. */
  deprecated?: boolean;
}

/** Params a producer passes to publishEvent() — id/occurredAt are generated, not supplied. */
export interface PublishEventParams<T = unknown> {
  type: string;
  version?: number; // defaults to the registered definition's version, else 1
  payload: T;
  actor?: EventEnvelope["actor"];
  traceId?: string;
  aggregate?: EventEnvelope["aggregate"];
  correlationId?: string;
  causationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * §5/§62 — a subscriber handler. Must be idempotent-safe from the
 * dispatcher's point of view (it may be invoked more than once for the
 * same event id — see event-bus/idempotency.ts) but does NOT need to
 * implement its own dedupe: the dispatcher already skips a
 * (event id, consumer) pair it has a recorded success for, before ever
 * calling the handler again.
 */
export type EventHandler<T = unknown> = (envelope: EventEnvelope<T>) => Promise<void>;

export interface Subscription {
  eventType: string;
  consumer: string; // stable name — used as the idempotency key, so renaming a consumer resets its dedupe history
  handler: EventHandler<any>;
}

/** Snapshot shape returned by metrics.ts (§57-A "Metrics", §59 performance targets). */
export interface EventBusMetricsSnapshot {
  published: number;
  dispatched: number;
  handlerFailures: number;
  retried: number;
  deadLettered: number;
  unknownType: number;
  /** §39 Latency metrics, Part G1 — `event_publish_latency`: how long
   *  publisher.ts's own outbox INSERT took (payload validation excluded —
   *  see that file's own recording site's comment). */
  publishLatencyMs: LatencySnapshot;
  /** §39 Latency metrics, Part G1 — `event_handler_latency`: how long one
   *  subscriber's handler took for one delivery attempt, recorded whether
   *  it succeeded or threw (see dispatcher.ts's own recording site) — this
   *  measures handler execution time independent of outcome; success/
   *  failure counts are what `dispatched`/`handlerFailures` above are for. */
  handlerLatencyMs: LatencySnapshot;
}
