/**
 * lib/scheduler/job-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §34 — "Register job handlers" / "Unknown jobs must fail safely and
 * become observable." Same in-memory, self-registering shape as
 * event-bus/event-registry.ts (see that file's header) — job handlers are
 * code, versioned with the code that defines and schedules them, not
 * runtime-editable state.
 */
import { logger } from "../logger";
import type { JobHandler, JobHandlerDefinition } from "./types";

export class UnknownJobTypeError extends Error {
  constructor(public readonly jobType: string) {
    super(`Job type "${jobType}" has no registered handler — see scheduler/job-registry.ts's registerJobHandler()`);
    this.name = "UnknownJobTypeError";
  }
}

const registry = new Map<string, JobHandlerDefinition<any>>();

/**
 * §34's registerJobHandler(). Does not throw on re-registration (hot
 * reload/tests re-import modules) — same posture as event-registry.ts's
 * registerEvent().
 */
export function registerJobHandler<T = unknown>(
  jobType: string,
  handler: JobHandler<T>,
  opts?: { defaultMaxAttempts?: number; owner?: string; description?: string },
): void {
  registry.set(jobType, { jobType, handler, ...opts });
}

export function getJobHandlerDefinition(jobType: string): JobHandlerDefinition<any> | undefined {
  return registry.get(jobType);
}

export function isJobTypeRegistered(jobType: string): boolean {
  return registry.has(jobType);
}

export function listJobHandlers(): JobHandlerDefinition<any>[] {
  return Array.from(registry.values());
}

export function defaultMaxAttemptsFor(jobType: string): number {
  return registry.get(jobType)?.defaultMaxAttempts ?? 5;
}

export function warnIfUnregistered(jobType: string): void {
  if (!registry.has(jobType)) {
    logger.warn({ jobType }, "Scheduler: scheduling a job whose type has no registered handler yet — it will dead-letter the moment it becomes due");
  }
}
