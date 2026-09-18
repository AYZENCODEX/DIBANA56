/**
 * lib/event-bus/metrics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §57-A "Metrics" / §59 performance targets ("low-millisecond local
 * publish path, non-blocking consumers, bounded retry queues"). Per the
 * Phase 8 blueprint's V1 posture (§56 "start with durable DB-backed
 * primitives", not a metrics platform), this is deliberately just
 * in-process counters — no Prometheus/StatsD wiring — read by
 * engine-health.ts (Part D/mega-engine, not this file) once that lands.
 * Reset on process restart, which is fine: these are point-in-time
 * dispatcher-health counters, not a durable audit trail (event_outbox's
 * own attempt_count/status columns are the durable record of what
 * happened to any one event).
 *
 * Extended in Part G1 (§39's own "Latency metrics" list) with
 * `publishLatencyMs`/`handlerLatencyMs` — see
 * CHANGES_MEGA_ENGINE_LATENCY_PHASE_G1.md for the full phase writeup.
 */
import { createLatencyHistogram } from "../latency-histogram";
import type { EventBusMetricsSnapshot } from "./types";

const counters = {
  published: 0,
  dispatched: 0,
  handlerFailures: 0,
  retried: 0,
  deadLettered: 0,
  unknownType: 0,
  retryStormThrottled: 0,
};

let workerActive = false;
let workerLastHeartbeatAt: Date | null = null;

// Part G1 — §39 Latency metrics (`event_publish_latency`/`event_handler_latency`).
const publishLatency = createLatencyHistogram();
const handlerLatency = createLatencyHistogram();

export function recordPublished(): void { counters.published++; }
export function recordDispatched(): void { counters.dispatched++; }
export function recordHandlerFailure(): void { counters.handlerFailures++; }
export function recordRetried(): void { counters.retried++; }
export function recordDeadLettered(): void { counters.deadLettered++; }
export function recordUnknownType(): void { counters.unknownType++; }
export function recordRetryStormThrottled(): void { counters.retryStormThrottled++; }
export function recordWorkerSweepStart(): void { workerActive = true; workerLastHeartbeatAt = new Date(); }
export function recordWorkerSweepEnd(): void { workerActive = false; workerLastHeartbeatAt = new Date(); }

/** publisher.ts's publishEvent() calls this once per call, around the
 *  outbox INSERT itself — §39's `event_publish_latency`. */
export function recordPublishLatency(ms: number): void { publishLatency.record(ms); }
/** dispatcher.ts's dispatchRow() calls this once per subscriber delivery
 *  attempt, whether the handler succeeded or threw — §39's `event_handler_latency`. */
export function recordHandlerLatency(ms: number): void { handlerLatency.record(ms); }

export function getEventBusMetrics(): EventBusMetricsSnapshot {
  return {
    ...counters,
    publishLatencyMs: publishLatency.snapshot(),
    handlerLatencyMs: handlerLatency.snapshot(),
    workerActive,
    workerLastHeartbeatAt: workerLastHeartbeatAt ? workerLastHeartbeatAt.toISOString() : null,
  };
}
