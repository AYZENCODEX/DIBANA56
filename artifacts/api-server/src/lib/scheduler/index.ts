/**
 * lib/scheduler/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Mega Engine — Phase 8 blueprint, Parts B1 + B2: Scheduler core +
 * Recurring/Cron, and E1 (§39 jobs.*/worker.* metrics, feeding §61's
 * Engine Health Model). Barrel export — domain modules should import
 * from "../scheduler" (this file), not reach into individual files here.
 */
export type { ScheduledJob, JobStatus, JobHandler, JobHandlerDefinition, ScheduleJobParams, ScheduleCronParams, ScheduleRecurringParams, MisfirePolicy, SchedulerMetricsSnapshot } from "./types";

export { registerJobHandler, getJobHandlerDefinition, isJobTypeRegistered, listJobHandlers, UnknownJobTypeError } from "./job-registry";
export { scheduleJob, scheduleDelayed, scheduleCron, scheduleRecurring, getJob, getJobsForCorrelation, cancelJob, cancelJobsForCorrelation, hasActiveJobForCorrelation, pauseJob, resumeJob } from "./job-store";
export { nextAttemptDelayMs, shouldDeadLetter } from "./retry";
export { moveToDeadLetter, listDeadLetters, replayDeadLetter, discardDeadLetter } from "./dead-letter";
export { runSchedulerSweep, startSchedulerWorker, stopSchedulerWorker } from "./worker";
export { parseCron, nextCronOccurrence, cronOccurrencesInRange } from "./cron-parser";
export { scheduleForJob, resolveMisfire, nextOccurrenceAfter, CATCH_UP_CAP, type Schedule, type MisfirePlan } from "./misfire";

// Part E1 — §39 jobs.*/worker.* metrics.
export { getSchedulerMetrics } from "./metrics";
