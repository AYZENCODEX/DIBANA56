/**
 * lib/scheduler/job-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §28 Job Model / §29 One-time & Delayed. The write/read side of the
 * scheduler — worker.ts owns claiming and executing, this file owns
 * getting a job onto (and, if needed, off) the table in the first place.
 *
 * scheduleJob(params, tx) takes the same optional transaction handle
 * publisher.ts's publishEvent() does, for the same reason: a job is very
 * often scheduled as a direct consequence of a business write ("user
 * invited -> schedule a 30-minute reminder", §35's own example) or of an
 * event handler reacting to one, and should land durably in the same
 * commit as whatever triggered it rather than risking a crash between
 * the two leaving the reminder never scheduled.
 */
import crypto from "crypto";
import { db, scheduledJobTable } from "@workspace/db";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { warnIfUnregistered, defaultMaxAttemptsFor } from "./job-registry";
import { recordJobScheduled, recordJobDeduplicated } from "./metrics";
import { parseCron, nextCronOccurrence } from "./cron-parser";
import type { ScheduleJobParams, ScheduleCronParams, ScheduleRecurringParams, ScheduledJob } from "./types";
import { ensureTraceId, stableSerialize, getCurrentTraceContext } from "../trace-context";
import { publishEvent, registerEvent } from "../event-bus";

registerEvent({ type: "job.created", version: 1, owner: "scheduler" });
registerEvent({ type: "job.cancelled", version: 1, owner: "scheduler" });
registerEvent({ type: "job.failed", version: 1, owner: "scheduler" });

// Same shape as db.transaction(async (tx) => ...)'s callback param — see
// event-bus/publisher.ts's identical DbTx alias for why.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Schedules a one-time/delayed job (§29). Accepts a fixed `runAt` instant
 * — pass `new Date(Date.now() + delayMs)` for a "delayed" job, they're the
 * same underlying primitive at this layer (or just call scheduleDelayed()
 * below). For cron/recurring scheduling see scheduleCron()/
 * scheduleRecurring() below (Part B2).
 *
 * Does NOT throw for an unregistered `jobType` — unlike
 * event-registry.ts's validateEventPayload() (§6's "reject at publish
 * time"), a job can legitimately be scheduled before its handler module
 * has finished importing/registering in this same boot (module load
 * order isn't guaranteed), so this only warns. An unregistered type is
 * still a controlled failure per §34 — it happens at DISPATCH time
 * instead (worker.ts dead-letters it immediately once due), not silently
 * accepted forever.
 */
export async function scheduleJob<T = unknown>(params: ScheduleJobParams<T>, tx?: DbTx): Promise<{ id: string }> {
  warnIfUnregistered(params.jobType);
  const id = crypto.randomUUID();
  const idempotencyKey = params.idempotencyKey
    ?? `job:${params.jobType}:${params.causationId ?? ""}:${params.runAt.toISOString()}:${stableSerialize(params.payload)}`;
  const requestContext = getCurrentTraceContext();
  const correlationId = params.correlationId ?? requestContext?.correlationId;
  const causationId = params.causationId ?? requestContext?.causationId;
  const traceId = ensureTraceId(params.traceId, correlationId);
  const executor = tx ?? db;

  // Part H3 (migration 115) — deliberately NOT wrapped in a try/catch
  // that resolves a unique-violation to "the" existing job's id here,
  // unlike run-store.ts's startRun() (Part H1). That recovery pattern
  // needs the violated constraint's key to be unambiguous from THIS
  // function's own generic columns alone — true for workflow_run's
  // UNIQUE(definition_id, causation_id) (both real columns), but NOT
  // true for scheduled_job: migration 115's own constraint is scoped to
  // one job_type and keyed on (causation_id, payload->>'workflowId') —
  // a job-store.ts-level `(jobType, causationId)` lookup can't tell
  // which of potentially SEVERAL same-(jobType, causationId) rows (one
  // per fanned-out workflow — see that migration's own header) is the
  // one the caller actually meant, without job-store.ts reaching into a
  // payload shape it has no business knowing about (this file's own
  // job model is deliberately payload-opaque — every other job type's
  // payload is whatever its own handler module defines). A 23505 here
  // therefore just propagates to the caller unmodified; the caller
  // (schedule-triggers.ts, this phase's only causationId-supplying
  // caller today) is the one place that actually knows how to interpret
  // its own payload shape, so it's the right place to decide the
  // violation is benign — see that file's own updated catch block.
  try {
    await executor.insert(scheduledJobTable).values({
      id,
      jobType: params.jobType,
      runAt: params.runAt,
      payload: params.payload as Record<string, unknown> | undefined,
      cron: params.cron,
      timezone: params.timezone,
      intervalMs: params.intervalMs,
      misfirePolicy: params.misfirePolicy,
      idempotencyKey,
      traceId,
      correlationId,
      causationId,
      maxAttempts: params.maxAttempts ?? defaultMaxAttemptsFor(params.jobType),
    });
    await publishEvent({
      type: "job.created",
      payload: { jobId: id, jobType: params.jobType },
      traceId,
      correlationId,
      causationId,
    }, tx);
  } catch (err: any) {
    if (err?.code === "23505" || /duplicate key/i.test(String(err?.message ?? ""))) {
      const [existing] = await db.select({ id: scheduledJobTable.id }).from(scheduledJobTable)
        .where(eq(scheduledJobTable.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) {
        recordJobDeduplicated();
        return { id: existing.id };
      }
    }
    throw err;
  }

  recordJobScheduled();
  return { id };
}

/** Convenience: schedule `delayMs` from now — §29's "Delayed" reduces to "One-time" at runAt = now + delay. */
export async function scheduleDelayed<T = unknown>(
  jobType: string,
  delayMs: number,
  payload?: T,
  opts?: { idempotencyKey?: string; traceId?: string; correlationId?: string; causationId?: string; maxAttempts?: number },
  tx?: DbTx,
): Promise<{ id: string }> {
  return scheduleJob({ jobType, runAt: new Date(Date.now() + Math.max(0, delayMs)), payload, ...opts }, tx);
}

/**
 * §29 "Cron" + §32 "Timezone" — Part B2. Sets `cron`/`timezone`, leaves
 * `intervalMs` unset (a job has one or the other, never both — see
 * migration 112's header). `runAt` is computed as the first occurrence
 * strictly after `startAt` (default: now) — a recurring job's very first
 * dispatch goes through the exact same claim/execute path as any other
 * due row, it's just that worker.ts re-arms it afterward instead of
 * completing it (see worker.ts's dispatchRecurringJob()).
 *
 * Validates the cron expression synchronously (parseCron() throws on
 * malformed input) so a typo'd expression fails at the call site, not
 * silently at the job's first due time.
 */
export async function scheduleCron<T = unknown>(params: ScheduleCronParams<T>, tx?: DbTx): Promise<{ id: string }> {
  warnIfUnregistered(params.jobType);
  parseCron(params.cron); // fail fast on malformed syntax
  new Intl.DateTimeFormat("en-US", { timeZone: params.timezone }); // throws RangeError on an unrecognized IANA identifier — fail fast here too, not at first dispatch

  const runAt = nextCronOccurrence(params.cron, params.timezone, params.startAt ?? new Date());
  return scheduleJob({
    ...params,
    runAt,
    cron: params.cron,
    timezone: params.timezone,
    misfirePolicy: params.misfirePolicy ?? "RUN_ONCE",
    idempotencyKey: params.idempotencyKey ?? `cron:${params.jobType}:${stableSerialize(params.payload)}`,
  }, tx);
}

/**
 * §29 "Recurring" — Part B2. Fixed-period alternative to scheduleCron()
 * for schedules that don't need clock alignment. `runAt` for the first
 * occurrence defaults to `startAt ?? now + intervalMs` — i.e. the first
 * run is one full interval out, matching "every 30 minutes" read as "the
 * next one is 30 minutes from now", not "immediately".
 */
export async function scheduleRecurring<T = unknown>(params: ScheduleRecurringParams<T>, tx?: DbTx): Promise<{ id: string }> {
  warnIfUnregistered(params.jobType);
  if (!(params.intervalMs > 0)) throw new Error("scheduleRecurring: intervalMs must be positive");

  const runAt = params.startAt ?? new Date(Date.now() + params.intervalMs);
  const result = await scheduleJob({
    ...params,
    runAt,
    intervalMs: params.intervalMs,
    misfirePolicy: params.misfirePolicy ?? "RUN_ONCE",
    idempotencyKey: params.idempotencyKey ?? `interval:${params.jobType}:${stableSerialize(params.payload)}`,
  }, tx);
  return result;
}

function rowToJob(row: typeof scheduledJobTable.$inferSelect): ScheduledJob {
  return {
    id: row.id,
    jobType: row.jobType,
    runAt: row.runAt,
    status: row.status as ScheduledJob["status"],
    payload: row.payload,
    idempotencyKey: row.idempotencyKey ?? undefined,
    traceId: row.traceId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    causationId: row.causationId ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    cron: row.cron ?? undefined,
    timezone: row.timezone ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    misfirePolicy: (row.misfirePolicy as ScheduledJob["misfirePolicy"]) ?? undefined,
  };
}

export async function getJob(id: string): Promise<ScheduledJob | undefined> {
  const [row] = await db.select().from(scheduledJobTable).where(eq(scheduledJobTable.id, id)).limit(1);
  return row ? rowToJob(row) : undefined;
}

/**
 * Part I3 (§65 "H: Production hardening" follow-on — closes the item
 * Phase I2 named in its own "Still open" list: "an operator inspecting
 * a cancelled run still has to separately check the scheduler's own job
 * list to see that its workflow.resume job was cancelled too"). Same
 * (jobType, correlationId) key `cancelJobsForCorrelation()` already
 * uses, but a read — returns the full row(s), not just a count/boolean,
 * for a caller (the admin run-inspection route) that wants to actually
 * SHOW the job, not just act on it. Ordered newest-`createdAt`-first so
 * a caller that only wants "the current one" can safely take index 0 —
 * relevant because a WAITING run's resume job can, over its lifetime,
 * have been re-scheduled by more than one parkForWait() call (e.g. a
 * step retry backoff parks/resumes/parks again under the same runId
 * correlationId) even though at most one is ever non-terminal at a time
 * (see cancelJobsForCorrelation()'s own doc comment).
 */
export async function getJobsForCorrelation(jobType: string, correlationId: string): Promise<ScheduledJob[]> {
  const rows = await db.select().from(scheduledJobTable)
    .where(and(eq(scheduledJobTable.jobType, jobType), eq(scheduledJobTable.correlationId, correlationId)))
    .orderBy(desc(scheduledJobTable.createdAt));
  return rows.map(rowToJob);
}

/**
 * Cancels a job that hasn't run yet. Only ever moves a SCHEDULED/RETRYING
 * row to CANCELLED — a job already RUNNING (claimed by a worker right
 * now) or terminal (COMPLETED/FAILED/DEAD_LETTER/already CANCELLED) is
 * left untouched, same "only mutate it if it's still safe to" guard
 * lib/mail-send-queue.ts's undo-send uses on its own queue's `status`
 * column. Returns whether this call was the one that cancelled it.
 */
/**
 * Part D2 (Workflow ↔ Scheduler) — boot-time dedupe helper for a
 * registrar that re-runs its "make sure this recurring job exists" pass
 * on every restart (the exact same boot-time-snapshot posture triggers.ts
 * §D1 already documents for `registerWorkflowEventTriggers()`: a
 * definition's trigger doesn't push a live update, so wiring it up is
 * re-derived from the DB each boot). Without this, calling scheduleCron()
 * unconditionally on every boot would insert a brand-new cron row —
 * and therefore a brand-new recurring schedule — every single restart,
 * rather than reusing the one already ticking. Returns whether a
 * not-yet-terminal (COMPLETED/FAILED/CANCELLED/DEAD_LETTER excluded) job
 * of `jobType` already exists for `correlationId`, so the caller can skip
 * re-scheduling.
 */
export async function hasActiveJobForCorrelation(jobType: string, correlationId: string): Promise<boolean> {
  const terminal: ScheduledJob["status"][] = ["COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"];
  const [row] = await db.select({ id: scheduledJobTable.id }).from(scheduledJobTable)
    .where(and(
      eq(scheduledJobTable.jobType, jobType),
      eq(scheduledJobTable.correlationId, correlationId),
      notInArray(scheduledJobTable.status, terminal),
    ))
    .limit(1);
  return !!row;
}

export async function cancelJob(id: string): Promise<boolean> {
  const cancellable: ScheduledJob["status"][] = ["SCHEDULED", "RETRYING"];
  const updated = await db.update(scheduledJobTable)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(scheduledJobTable.id, id), inArray(scheduledJobTable.status, cancellable)))
    .returning({ id: scheduledJobTable.id });
  if (updated.length > 0) {
    await publishEvent({ type: "job.cancelled", payload: { jobId: id }, correlationId: id, causationId: id });
  }
  return updated.length > 0;
}

/**
 * Part I2 (§65 "H: Production hardening" follow-on — see
 * CHANGES_MEGA_ENGINE_MIDSTEP_CANCELLATION_PHASE_I1.md's own "Still
 * open" list, item "a cancelled-while-WAITING run's already-scheduled
 * workflow.resume job is not proactively cancelled"). Same conditional-
 * UPDATE, "only mutate it if it's still safe to" shape as cancelJob()
 * just above, but by (jobType, correlationId) instead of a single job
 * id — for a caller (workflow/run-store.ts's cancelRun()) that knows a
 * job by the correlation key its own scheduling call used
 * (scheduler-integration.ts's scheduleWorkflowResume() deliberately
 * sets `correlationId: runId`, exactly for lookups like this one — see
 * that file's own doc comment) rather than by the job's own generated
 * id, which that caller never captured (parkForWait() didn't need it —
 * see engine.ts). Cancels every not-yet-terminal job matching both
 * keys — in practice at most one row (a workflow run has at most one
 * live `workflow.resume` job at a time — the WAITING/wakeup model,
 * §24), but this doesn't assume that invariant holds and cancels all
 * matches rather than just the first. Returns the number of rows
 * actually cancelled — 0 (not an error) when the run was never parked
 * (nothing scheduled yet), its resume job already fired, or it had
 * already been cancelled/completed some other way.
 */
export async function cancelJobsForCorrelation(jobType: string, correlationId: string): Promise<number> {
  const cancellable: ScheduledJob["status"][] = ["SCHEDULED", "RETRYING"];
  const updated = await db.update(scheduledJobTable)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(
      eq(scheduledJobTable.jobType, jobType),
      eq(scheduledJobTable.correlationId, correlationId),
      inArray(scheduledJobTable.status, cancellable),
    ))
    .returning({ id: scheduledJobTable.id });
  for (const row of updated) {
    await publishEvent({ type: "job.cancelled", payload: { jobId: row.id }, correlationId, causationId: row.id });
  }
  return updated.length;
}

/** J10 operator controls. PAUSED rows remain durable and are never claimable. */
export async function pauseJob(id: string, reason = "Paused by operator"): Promise<boolean> {
  const updated = await db.update(scheduledJobTable)
    .set({ status: "PAUSED", pauseReason: reason, updatedAt: new Date() })
    .where(and(eq(scheduledJobTable.id, id), inArray(scheduledJobTable.status, ["SCHEDULED", "RETRYING"])))
    .returning({ id: scheduledJobTable.id });
  return updated.length > 0;
}

/** Re-queues a paused job without resetting its attempt history. */
export async function resumeJob(id: string): Promise<boolean> {
  const updated = await db.update(scheduledJobTable)
    .set({ status: "SCHEDULED", pauseReason: null, runAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scheduledJobTable.id, id), eq(scheduledJobTable.status, "PAUSED")))
    .returning({ id: scheduledJobTable.id });
  return updated.length > 0;
}
