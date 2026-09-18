/**
 * lib/scheduler/misfire.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part B2: Recurring/Cron Scheduler
 * (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md §29 Recurring/Cron,
 * §31 Misfire Handling).
 *
 * A `Schedule` is the two ways §29 says a job can recur:
 *   - "cron"     — a 5-field expression evaluated in an IANA timezone (§32).
 *   - "interval" — a fixed millisecond period, grid-anchored at the job's
 *                  own `created_at` (no separate anchor column needed —
 *                  see migration 112's comment). This is §29's plain
 *                  "Recurring: every 30 minutes" case for schedules that
 *                  don't need clock alignment (a cron expression like
 *                  `* /30 * * * *` only fires at :00/:30, not "30 minutes
 *                  after whenever this job was created").
 *
 * §31's example is the reason this file exists as its own module rather
 * than folding straight into worker.ts: "A job scheduled every hour was
 * down for 6 hours. Do not blindly execute six copies unless the job
 * explicitly requests catch-up." resolveMisfire() is the single place
 * that decides, for both schedule kinds, how many of the missed
 * occurrences (if any) actually get dispatched.
 */
import { cronOccurrencesInRange, nextCronOccurrence } from "./cron-parser";
import type { MisfirePolicy, ScheduledJob } from "./types";

export type Schedule =
  | { kind: "cron"; cron: string; timezone: string }
  | { kind: "interval"; intervalMs: number; anchor: Date };

/**
 * §56 — never an unbounded catch-up storm. A schedule that's been due
 * hundreds of times (system down for weeks on a minutely job) still only
 * ever executes this many occurrences in one CATCH_UP pass; the rest
 * silently fold into the single next-occurrence-after-now reschedule, same
 * as SKIP would do for them.
 */
export const CATCH_UP_CAP = 20;

/** Builds a job's Schedule from its stored columns, or undefined for a one-time job (neither `cron` nor `intervalMs` set). A job has exactly one of the two — job-store.ts's scheduleCron()/scheduleRecurring() enforce that at the call site (see migration 112's header). */
export function scheduleForJob(job: Pick<ScheduledJob, "cron" | "timezone" | "intervalMs" | "createdAt">): Schedule | undefined {
  if (job.cron) return { kind: "cron", cron: job.cron, timezone: job.timezone ?? "UTC" };
  if (job.intervalMs) return { kind: "interval", intervalMs: job.intervalMs, anchor: job.createdAt };
  return undefined;
}

/** Next occurrence strictly after `after`, for either schedule kind. */
export function nextOccurrenceAfter(schedule: Schedule, after: Date): Date {
  return schedule.kind === "cron"
    ? nextCronOccurrence(schedule.cron, schedule.timezone, after)
    : nextIntervalOccurrence(schedule.anchor, schedule.intervalMs, after);
}

function nextIntervalOccurrence(anchor: Date, intervalMs: number, after: Date): Date {
  if (!(intervalMs > 0)) throw new Error("intervalMs must be positive");
  const diff = after.getTime() - anchor.getTime();
  const k = Math.floor(diff / intervalMs) + 1;
  return new Date(anchor.getTime() + k * intervalMs);
}

function intervalOccurrencesInRange(anchor: Date, intervalMs: number, fromInclusive: Date, toInclusive: Date, cap: number): { occurrences: Date[]; truncated: boolean } {
  const occurrences: Date[] = [];
  let k = Math.max(0, Math.ceil((fromInclusive.getTime() - anchor.getTime()) / intervalMs));
  while (occurrences.length < cap) {
    const t = anchor.getTime() + k * intervalMs;
    if (t > toInclusive.getTime()) break;
    if (t >= fromInclusive.getTime()) occurrences.push(new Date(t));
    k++;
  }
  return { occurrences, truncated: occurrences.length >= cap };
}

export interface MisfirePlan {
  /** Occurrence instants to actually invoke the handler for, in order. Empty for SKIP/RESCHEDULE. */
  runsToExecute: Date[];
  /** Where the job should be re-armed after this dispatch, regardless of policy. */
  nextRunAt: Date;
  /** How many occurrences besides the first were already due by `now` — 0 means "right on time, no misfire". */
  missedCount: number;
}

/**
 * §31 — the four policies, applied uniformly to cron and interval
 * schedules:
 *   RUN_ONCE   — run the single most-overdue occurrence once, then resume
 *                the normal schedule going forward. Default (see
 *                migration 112) — the safest choice per §31's own wording.
 *   SKIP       — run nothing for the gap; jump straight to the next
 *                occurrence after `now`.
 *   CATCH_UP   — run once per missed occurrence (bounded by CATCH_UP_CAP)
 *                — the "job explicitly requests catch-up" case §31 calls
 *                out as the only time six copies should ever run.
 *   RESCHEDULE — same as SKIP (recompute fresh from `now`, run nothing for
 *                the gap). Kept as a distinct named policy for interval
 *                schedules, where "reschedule relative to now" is the
 *                more natural way to describe drifting the grid forward
 *                rather than "skipping" occurrences that were never really
 *                clock-aligned commitments in the first place.
 */
export function resolveMisfire(schedule: Schedule, dueAt: Date, now: Date, policy: MisfirePolicy): MisfirePlan {
  const { occurrences } = schedule.kind === "cron"
    ? cronOccurrencesInRange(schedule.cron, schedule.timezone, dueAt, now, CATCH_UP_CAP)
    : intervalOccurrencesInRange(schedule.anchor, schedule.intervalMs, dueAt, now, CATCH_UP_CAP);

  // `dueAt` is the row's own run_at, which by definition was <= now for a
  // claimed job, so it should always be present in `occurrences` — this
  // fallback only guards a boundary rounding case between the claim query
  // (`run_at <= now()`, computed in Postgres) and this recomputation
  // (computed in JS against a slightly later `now`).
  const list = occurrences.length ? occurrences : [dueAt];
  const missedCount = Math.max(0, list.length - 1);
  const nextRunAt = nextOccurrenceAfter(schedule, now);

  switch (policy) {
    case "CATCH_UP":
      return { runsToExecute: list, nextRunAt, missedCount };
    case "RUN_ONCE":
      return { runsToExecute: [list[0]], nextRunAt, missedCount };
    case "SKIP":
    case "RESCHEDULE":
      return { runsToExecute: [], nextRunAt, missedCount };
    default:
      // Exhaustiveness guard — an unrecognized policy value (e.g. corrupted
      // DB row) falls back to the safest option rather than throwing mid-sweep.
      return { runsToExecute: [list[0]], nextRunAt, missedCount };
  }
}
