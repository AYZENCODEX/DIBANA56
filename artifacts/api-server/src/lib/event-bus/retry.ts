/**
 * lib/event-bus/retry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §11 — "Default retry should use bounded exponential backoff." Same
 * baseMs * 2^attempts, capped, ±20% jitter shape lib/mail-send-queue.ts's
 * nextAttemptDelay() already uses (mass-failure-of-a-dependency shouldn't
 * retry every affected row in lockstep) — kept as its own small module
 * here (rather than importing that file's private helper) since the two
 * queues have independent tuning: outbox events can afford a longer
 * MAX_DISPATCH_ATTEMPTS ceiling than an interactive mail send before
 * giving up, because §11's "give up" here means dead-letter + operator
 * replay (§57-E), not "drop the user's message back to Drafts."
 */

/** §11 — after this many failed attempts, an outbox row goes to the dead letter table instead of retrying again. */
export const MAX_DISPATCH_ATTEMPTS = 8;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 30 * 60_000; // 30 minutes

/**
 * attempts 1..8 -> roughly 10s, 20s, 40s, 80s, ~5m, ~11m, ~22m, 30m
 * (capped) before dead-lettering.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const raw = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(raw + jitter));
}

export function shouldDeadLetter(attempts: number): boolean {
  return attempts >= MAX_DISPATCH_ATTEMPTS;
}
