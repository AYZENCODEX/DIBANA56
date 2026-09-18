/**
 * lib/latency-histogram.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase G1 (§65 "G: Observability/admin"; concretely,
 * §39's own "Latency metrics" list — `event_publish_latency`/
 * `event_handler_latency`/`workflow_duration`/`step_duration`/
 * `scheduler_lag`/`job_execution_duration` — the one §39 subsection Phase
 * E1 explicitly left uncovered, see that phase's own "Still open" list:
 * "this phase only covers §39's plain counters/gauges, not the
 * latency-metrics list further down the same section.")
 *
 * ── Why a shared file at `lib/`, not inside `mega-engine/` ────────────────
 * `event-bus/metrics.ts`, `scheduler/metrics.ts`, and `workflow/metrics.ts`
 * each need this (two latency fields apiece — see §39's list, split
 * exactly along those three engines) — and `mega-engine/*` already imports
 * FROM all three of those directories (`engine-health.ts`'s own header:
 * "No circular import... none of those three barrels reaches into
 * ../mega-engine"). Putting a shared dependency the three engines
 * themselves need under `mega-engine/` would invert that direction and
 * introduce exactly the circular-import risk every prior phase has
 * explicitly checked against. `lib/logger.ts`/`lib/log-bus.ts` already
 * establish the convention this file follows instead: a zero-dependency
 * shared utility living directly under `lib/`, imported downward by any
 * subsystem that needs it, never the reverse.
 *
 * ── Deliberately no percentiles (count/sum/min/max/avg only) ─────────────
 * A real p50/p95/p99 needs either a bounded reservoir sample or a
 * streaming sketch (t-digest/HDRHistogram) — genuine additional
 * infrastructure, not a natural extension of the existing "increment an
 * in-process counter" posture `event-bus/metrics.ts` already established
 * (Rule 17: avoid unnecessary infrastructure introduced reactively rather
 * than by deliberate design). count/sum/min/max/avg is enough to answer
 * §59's own framing ("measure before optimizing" — is this subsystem
 * trending slower, at a glance) without guessing at a sketch's bucket
 * boundaries or retention window up front. A future phase can swap this
 * file's internals for a real sketch without changing any call site — every
 * caller only ever sees `record(ms)`/`snapshot()`.
 *
 * ── Same "in-process, reset on restart" posture as every other metrics
 *    module in this codebase ─────────────────────────────────────────────
 * No persistence, no Prometheus/StatsD wiring — read by
 * `mega-engine/engine-health.ts` (a future phase's job to wire in, this
 * phase only produces the numbers) or an admin route, same as
 * `EventBusMetricsSnapshot`/`SchedulerMetricsSnapshot`/
 * `WorkflowMetricsSnapshot`'s own counters already are.
 */

export interface LatencySnapshot {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  /** `null` when `count === 0` — avoids a misleading `0`/`NaN` for "no
   *  samples yet", the same "absent, not a false zero" posture
   *  `SchedulerMetricsSnapshot.workerLastHeartbeatAt` already uses. */
  avgMs: number | null;
}

export interface LatencyHistogram {
  /** Records one duration sample, in milliseconds. Silently ignores a
   *  negative or non-finite value (clock skew, a caller's arithmetic bug)
   *  rather than corrupting the running aggregate — same "don't let a bad
   *  single input poison an otherwise-useful counter" posture this
   *  codebase already applies elsewhere (e.g. `dispatcher.ts`'s bounded
   *  `combinedError` diagnostics slice). */
  record(ms: number): void;
  /** A fresh, immutable copy — same convention every other `get*Metrics()`
   *  in this codebase already follows (`{ ...counters }`), so a caller
   *  can't accidentally mutate live state through the returned object. */
  snapshot(): LatencySnapshot;
}

export function createLatencyHistogram(): LatencyHistogram {
  let count = 0;
  let sumMs = 0;
  let minMs: number | null = null;
  let maxMs: number | null = null;

  return {
    record(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) return;
      count++;
      sumMs += ms;
      minMs = minMs === null ? ms : Math.min(minMs, ms);
      maxMs = maxMs === null ? ms : Math.max(maxMs, ms);
    },
    snapshot(): LatencySnapshot {
      return { count, sumMs, minMs, maxMs, avgMs: count > 0 ? sumMs / count : null };
    },
  };
}
