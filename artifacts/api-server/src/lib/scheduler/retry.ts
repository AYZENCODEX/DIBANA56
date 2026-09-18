/**
 * lib/scheduler/retry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Same jittered bounded-exponential-backoff shape as event-bus/retry.ts
 * and lib/mail-send-queue.ts's nextAttemptDelay() — kept as its own copy
 * (rather than importing event-bus/retry.ts) because the scheduler's give-
 * up threshold is per-job (`scheduled_job.max_attempts`, set per call site
 * via ScheduleJobParams.maxAttempts / a handler's defaultMaxAttempts),
 * unlike the Event Bus's single fixed MAX_DISPATCH_ATTEMPTS constant — §11
 * asks for "bounded exponential backoff" as the policy shape, not a
 * shared numeric constant across two otherwise-independent engines.
 */

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 30 * 60_000; // 30 minutes

/** attempts 1..N -> roughly 10s, 20s, 40s, 80s, ~5m, ~11m, ~22m, 30m (capped), same curve as the Event Bus dispatcher. */
export function nextAttemptDelayMs(attempts: number): number {
  const raw = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(raw + jitter));
}

export function shouldDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
