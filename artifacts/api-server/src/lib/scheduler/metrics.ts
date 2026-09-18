/**
 * lib/scheduler/metrics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part E1 (§39 Observability's
 * `jobs.*`/`worker.*` counters, feeding §61's Engine Health Model).
 * Same "in-process counters, no Prometheus/StatsD wiring" V1 posture
 * event-bus/metrics.ts already documents for itself — read by
 * lib/mega-engine/engine-health.ts, not by worker.ts's own callers.
 * Reset on process restart; scheduled_job's own status/attempts columns
 * remain the durable record of what actually happened to any one job
 * (same split event-bus/metrics.ts draws against event_outbox).
 *
 * `workerActive`/`workerLastHeartbeatAt` are gauges, not counters — set
 * around worker.ts's runSchedulerSweep() tick (§33's "worker.heartbeat"),
 * not incremented. There is exactly one dispatch loop per process in
 * this codebase's V1 posture (§56 — no distributed worker-pool
 * coordination beyond the DB-level claim/lease already handling multiple
 * *processes*), so a boolean is enough; a true multi-worker-per-process
 * gauge would need a count instead, not needed yet.
 *
 * Extended in Part G1 (§39's own "Latency metrics" list) with
 * `schedulerLagMs`/`jobExecutionDurationMs` — see
 * CHANGES_MEGA_ENGINE_LATENCY_PHASE_G1.md for the full phase writeup.
 */
import { createLatencyHistogram } from "../latency-histogram";
import type { SchedulerMetricsSnapshot } from "./types";

const counters = {
  jobsScheduled: 0,
  jobsExecuted: 0,
  jobsFailed: 0,
  jobsRetried: 0,
  jobsDeadLettered: 0,
  workerFailures: 0,
  retryStormThrottled: 0,
};

let workerActive = false;
let workerLastHeartbeatAt: Date | null = null;

// Part G1 — §39 Latency metrics (`scheduler_lag`/`job_execution_duration`).
const schedulerLag = createLatencyHistogram();
const jobExecutionDuration = createLatencyHistogram();

export function recordJobScheduled(): void { counters.jobsScheduled++; }
export function recordJobExecuted(): void { counters.jobsExecuted++; }
export function recordJobFailed(): void { counters.jobsFailed++; }
export function recordJobRetried(): void { counters.jobsRetried++; }
export function recordJobDeadLettered(): void { counters.jobsDeadLettered++; }
export function recordRetryStormThrottled(): void { counters.retryStormThrottled++; }

/** worker.ts calls this once per sweep tick — start and finish, so a hung sweep (still `true` well past the poll cadence) is itself a DEGRADED signal engine-health.ts can read. */
export function recordWorkerSweepStart(): void { workerActive = true; workerLastHeartbeatAt = new Date(); }
export function recordWorkerSweepEnd(): void { workerActive = false; workerLastHeartbeatAt = new Date(); }
/** A whole sweep throwing (not an individual job's handler failing — that's recordJobFailed()) — §39's `worker.failed`. */
export function recordWorkerFailure(): void { counters.workerFailures++; }

/** worker.ts's dispatchJob()/dispatchRecurringJob() call this once per
 *  dispatch, before the handler runs — §39's `scheduler_lag`. */
export function recordSchedulerLag(ms: number): void { schedulerLag.record(ms); }
/** worker.ts's dispatchJob()/dispatchRecurringJob() call this once per
 *  dispatch, after the handler settles (success or failure) — §39's
 *  `job_execution_duration`. */
export function recordJobExecutionDuration(ms: number): void { jobExecutionDuration.record(ms); }

export function getSchedulerMetrics(): SchedulerMetricsSnapshot {
  return {
    ...counters,
    workerActive,
    workerLastHeartbeatAt: workerLastHeartbeatAt ? workerLastHeartbeatAt.toISOString() : null,
    schedulerLagMs: schedulerLag.snapshot(),
    jobExecutionDurationMs: jobExecutionDuration.snapshot(),
  };
}
