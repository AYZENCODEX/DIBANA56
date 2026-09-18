/**
 * lib/scheduler/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Parts B1 + B2: Scheduler core +
 * Recurring/Cron (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md
 * §28/§29/§30/§31/§32/§33/§34). Types only — see event-bus/types.ts's
 * header for why that separation matters (every other scheduler/*.ts file,
 * and any future domain module that schedules or handles jobs, imports
 * this without the engine's runtime).
 */
import type { LatencySnapshot } from "../latency-histogram";

/** §28 — the full status lifecycle. B1's worker only ever writes a subset (see worker.ts); READY and CANCELLED are here for completeness/API surface even though B1 has no cancel endpoint yet. */
export type JobStatus =
  | "SCHEDULED"
  | "PAUSED"
  | "READY"
  | "RUNNING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "DEAD_LETTER";

/** §31 — how a recurring/cron job's overdue occurrences are handled. Only meaningful for a job that has `cron` or `intervalMs` set; a one-time job never misfires (it either runs or it's overdue-and-still-pending, same as B1). */
export type MisfirePolicy = "RUN_ONCE" | "SKIP" | "CATCH_UP" | "RESCHEDULE";

/** §28's ScheduledJob shape, as the engine hands it to a handler — mirrors the DB row but with Date objects instead of ISO strings. `runAt` for a recurring job's handler invocation is the OCCURRENCE being executed (which, under CATCH_UP, may be earlier than the row's current/next `run_at`) — see misfire.ts. */
export interface ScheduledJob<T = unknown> {
  id: string;
  jobType: string;
  runAt: Date;
  status: JobStatus;
  payload?: T;
  idempotencyKey?: string;
  traceId?: string;
  correlationId?: string;
  /** Part H3 — the event id that caused this job to be scheduled, when applicable (e.g. a "delayed" workflow trigger's anchor event id). Only meaningful for scheduleJob()/scheduleDelayed() — ScheduleCronParams/ScheduleRecurringParams below have no equivalent field, since a recurring/cron schedule isn't "caused by" a single event the way a one-time delayed job can be. */
  causationId?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  /** §29/§32 — set together for a cron-scheduled recurring job. Undefined for one-time and interval-recurring jobs. */
  cron?: string;
  /** IANA timezone identifier the cron expression is evaluated in (§32) — never a hard-coded offset. Only meaningful alongside `cron`. */
  timezone?: string;
  /** §29 "Recurring" — fixed-period alternative to `cron`, grid-anchored at `createdAt`. Undefined for one-time and cron-recurring jobs. */
  intervalMs?: number;
  /** §31 — defaults to RUN_ONCE (see job-store.ts). Only meaningful when `cron` or `intervalMs` is set. */
  misfirePolicy?: MisfirePolicy;
}

/** §29 — B1's one-time/delayed scheduling: a fixed instant. Cron/recurring scheduling is ScheduleCronParams/ScheduleRecurringParams below (Part B2). */
export interface ScheduleJobParams<T = unknown> {
  jobType: string;
  runAt: Date;
  payload?: T;
  /** Stable key for the logical job. Duplicate inserts with the same key return the existing job. */
  idempotencyKey?: string;
  traceId?: string;
  correlationId?: string;
  /** Part H3 — see ScheduledJob.causationId's own doc comment; when set, backed by migration 115's UNIQUE(job_type, causation_id) partial index (job-store.ts's scheduleJob() catches that constraint's violation and returns the already-scheduled job instead of throwing). */
  causationId?: string;
  maxAttempts?: number; // defaults to the registered handler's own default, else 5
  /** Internal/shared persistence fields used by recurring schedule helpers. */
  cron?: string;
  timezone?: string;
  intervalMs?: number;
  misfirePolicy?: MisfirePolicy;
}

/** §29 "Cron" + §32 "Timezone" — Part B2. `startAt` (default: now) is the instant the first occurrence is computed after, not the first occurrence itself — pass a future instant to delay a recurring schedule's start. */
export interface ScheduleCronParams<T = unknown> {
  jobType: string;
  cron: string;
  timezone: string;
  payload?: T;
  idempotencyKey?: string;
  traceId?: string;
  correlationId?: string;
  maxAttempts?: number;
  /** §31 — defaults to RUN_ONCE. */
  misfirePolicy?: MisfirePolicy;
  startAt?: Date;
}

/** §29 "Recurring" — Part B2. Fixed-period alternative to ScheduleCronParams for schedules that don't need clock alignment ("30 minutes after this job was created", not "at :00/:30"). */
export interface ScheduleRecurringParams<T = unknown> {
  jobType: string;
  intervalMs: number;
  payload?: T;
  idempotencyKey?: string;
  traceId?: string;
  correlationId?: string;
  maxAttempts?: number;
  /** §31 — defaults to RUN_ONCE. */
  misfirePolicy?: MisfirePolicy;
  startAt?: Date;
}

/**
 * §34 — a job handler. Like event-bus's EventHandler, must be safe to
 * invoke on a redelivered/reclaimed job (a lease-expiry reclaim after a
 * worker died mid-execution can run the same job twice) — the engine does
 * not attempt cross-attempt idempotency for jobs the way it does for
 * event consumers (there is no stable second key like "consumer name" to
 * dedupe against; a job IS the unit of work), so a handler whose side
 * effect isn't naturally safe to repeat should make it so itself (e.g. by
 * checking its own target state before acting), same caveat §26
 * ("Workflow Idempotency") makes for workflow step handlers.
 */
export type JobHandler<T = unknown> = (job: ScheduledJob<T>) => Promise<void>;

export interface JobHandlerDefinition<T = unknown> {
  jobType: string;
  handler: JobHandler<T>;
  /** Default max_attempts for a job of this type when the scheduler() caller doesn't specify one. */
  defaultMaxAttempts?: number;
  owner?: string;
  description?: string;
}

/**
 * Part E1 (§39 Observability) — metrics.ts's own in-process snapshot
 * shape. Same split as event-bus/types.ts's EventBusMetricsSnapshot:
 * pure counters plus the two worker gauges (see metrics.ts's header for
 * why those are gauges, not counters).
 */
export interface SchedulerMetricsSnapshot {
  jobsScheduled: number;
  jobsExecuted: number;
  jobsFailed: number;
  jobsRetried: number;
  jobsDeadLettered: number;
  workerFailures: number;
  workerActive: boolean;
  workerLastHeartbeatAt: string | null;
  /** §39 Latency metrics, Part G1 — `scheduler_lag`: how late a dispatch
   *  started relative to the job's own `run_at` (queue wait time, not
   *  handler behavior — see worker.ts's own recording sites in
   *  dispatchJob()/dispatchRecurringJob(), both recorded BEFORE the
   *  handler runs). */
  schedulerLagMs: LatencySnapshot;
  /** §39 Latency metrics, Part G1 — `job_execution_duration`: how long
   *  the job handler itself took, recorded whether it succeeded or
   *  failed — independent of outcome, same reasoning as
   *  EventBusMetricsSnapshot.handlerLatencyMs. For a recurring/cron job
   *  under CATCH_UP, this covers the whole `runsToExecute` loop as one
   *  sample, not per-occurrence — see dispatchRecurringJob()'s own
   *  recording site. */
  jobExecutionDurationMs: LatencySnapshot;
}
