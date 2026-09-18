/**
 * lib/scheduler/worker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §30 Scheduler Execution / §33 Worker Pool (Part B1), extended in Part B2
 * with §29 Recurring/Cron + §31 Misfire Handling (see dispatchRecurringJob()
 * below). Claim/lease/backoff shape is the same pattern as
 * event-bus/dispatcher.ts and lib/mail-send-queue.ts (`FOR UPDATE SKIP
 * LOCKED` claim, lease expiry instead of a fixed stuck-timeout constant —
 * see below, jittered exponential backoff via scheduler/retry.ts) — third
 * instance of the same idiom in this codebase now, deliberately not a
 * fourth-different one.
 *
 * §30's lease model: `locked_until` (an absolute expiry instant, not a
 * "locked since" timestamp + fixed recovery window like event_outbox
 * uses) + `locked_by` + `heartbeat_at`. Set once at claim time, generous
 * enough to cover a slow handler (JOB_LEASE_DURATION_MS below); it does
 * not renew the lease mid-execution for a still-running handler (a true
 * heartbeat-extends-lease loop is more machinery than any job scheduled so
 * far needs). `heartbeat_at` is still stamped at claim time so the column
 * has real data for whenever a future job type's handler does need it,
 * per §30/§33's shape, without having to guess the extension protocol
 * prematurely (§56).
 *
 * §33's six worker responsibilities, in dispatchJob()/dispatchRecurringJob()
 * below:
 *   1. claim job          -> claimNextBatch()
 *   2. validate payload    -> (no per-job-type schema yet — same
 *                              "registry SUPPORTS validation, not every
 *                              type has one on day one" posture as
 *                              event-registry.ts)
 *   3. execute handler      -> job-registry.ts's registered handler
 *   4. emit completion/failure event -> publishEvent("scheduler.job.completed" | "scheduler.job.failed", tx) — §35
 *   5. update job state       -> COMPLETED/DEAD_LETTER (one-time) or re-armed SCHEDULED (recurring/cron, B2) / RETRYING+backoff, in the SAME tx as #4
 *   6. release/expire lease     -> cleared on every terminal/retry write; a crashed worker's lease simply expires (see recoverExpiredLeases())
 */
import cron from "node-cron";
import crypto from "crypto";
import { db, scheduledJobTable, scheduledJobAttemptTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import { registerEvent, publishEvent } from "../event-bus";
import { z } from "zod/v4";
import { getJobHandlerDefinition, isJobTypeRegistered } from "./job-registry";
import { moveToDeadLetter } from "./dead-letter";
import { nextAttemptDelayMs, shouldDeadLetter } from "./retry";
import { scheduleForJob, resolveMisfire, nextOccurrenceAfter, type Schedule } from "./misfire";
import {
  recordJobExecuted, recordJobFailed, recordJobRetried, recordJobDeadLettered,
  recordWorkerSweepStart, recordWorkerSweepEnd, recordWorkerFailure,
  recordSchedulerLag, recordJobExecutionDuration,
} from "./metrics";
import type { ScheduledJob, MisfirePolicy } from "./types";

// §35 — Scheduler <-> Event Bus integration: every job's outcome is also
// an event, so a domain module can react to "did my scheduled thing
// happen" without polling scheduled_job directly. Self-registered here
// (not added to event-registry.ts's own DEFAULT_EVENT_TYPES list) —
// matches that file's header: "individual domain modules... take over
// registering their own types," and the Scheduler is exactly such a
// module from the Event Bus's point of view.
registerEvent({
  type: "scheduler.job.completed",
  version: 1,
  owner: "scheduler",
  // §29/§31 (B2) — `occurrences`/`missed` are optional and only ever set
  // for a recurring/cron job's dispatch (a one-time job's completion event
  // omits them, unchanged from B1): how many occurrences this single
  // dispatch actually ran (>1 only under CATCH_UP) and how many were found
  // overdue when the misfire policy was evaluated.
  schema: z.object({ jobId: z.string(), jobType: z.string(), occurrences: z.number().optional(), missed: z.number().optional() }),
});
registerEvent({
  type: "scheduler.job.failed",
  version: 1,
  owner: "scheduler",
  schema: z.object({ jobId: z.string(), jobType: z.string(), attempts: z.number(), lastError: z.string(), willRetry: z.boolean() }),
});
registerEvent({
  type: "scheduler.job.deadlettered",
  version: 1,
  owner: "scheduler",
  // §31 (B2) — `missed` mirrors scheduler.job.completed's addition, same reasoning.
  schema: z.object({ jobId: z.string(), jobType: z.string(), attempts: z.number(), missed: z.number().optional() }),
});

const WORKER_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const CLAIM_BATCH_SIZE = 25;

// How long a claimed job's lease is valid for before it's considered
// abandoned (§30: "If a worker dies: lease expires -> job becomes
// claimable"). Generous relative to anything B1 schedules — see header.
const JOB_LEASE_DURATION_MS = 5 * 60_000;

function rowToJob(row: typeof scheduledJobTable.$inferSelect): ScheduledJob {
  return {
    id: row.id,
    jobType: row.jobType,
    runAt: row.runAt,
    status: row.status as ScheduledJob["status"],
    payload: row.payload,
    idempotencyKey: row.idempotencyKey ?? undefined,
    traceId: row.traceId ?? undefined,
    causationId: row.causationId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    cron: row.cron ?? undefined,
    timezone: row.timezone ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    misfirePolicy: (row.misfirePolicy as MisfirePolicy) ?? undefined,
  };
}

/** §30 atomic claim — SCHEDULED or RETRYING rows past their run_at. */
async function claimNextBatch(limit: number): Promise<(typeof scheduledJobTable.$inferSelect)[]> {
  return db.transaction(async (trx) => {
    const claimable = await trx.execute(sql`
      SELECT id FROM scheduled_job
      WHERE status IN ('SCHEDULED', 'RETRYING') AND run_at <= now()
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = (claimable.rows as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];

    return trx.update(scheduledJobTable)
      .set({
        status: "RUNNING",
        lockedBy: WORKER_ID,
        lockedUntil: new Date(Date.now() + JOB_LEASE_DURATION_MS),
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(scheduledJobTable.id, ids))
      .returning();
  });
}

/**
 * Executes one claimed job and advances its state. The handler call
 * itself happens OUTSIDE any DB transaction (a handler may do its own,
 * unrelated DB/network work and must not be forced into this worker's
 * transaction) — only the bookkeeping afterward (job status + attempt
 * history row + the completion/failure event) is transactional, via
 * event-bus's publishEvent(..., tx) taking the exact same tx this file's
 * own job-state update runs in, so "job says COMPLETED" and "completion
 * event exists" can never disagree.
 */
async function dispatchJob(row: typeof scheduledJobTable.$inferSelect): Promise<void> {
  const job = rowToJob(row);
  const schedule = scheduleForJob(job);

  if (!isJobTypeRegistered(job.jobType)) {
    // §34: unknown job type — fail safely and become observable, straight to dead letter (no handler will ever exist for this without a deploy anyway).
    await moveToDeadLetter({ jobId: job.id, jobType: job.jobType, payload: job.payload as Record<string, unknown> | undefined, attempts: job.attempts, lastError: `Job type "${job.jobType}" has no registered handler` });
    recordJobDeadLettered();
    if (schedule) {
      // B2: a recurring/cron job re-arms for its next occurrence instead of
      // terminating — a handler registered by a later deploy picks the
      // schedule back up automatically, same "don't let one gap permanently
      // kill a recurring job" posture as dispatchRecurringJob() below.
      await db.update(scheduledJobTable).set({ status: "SCHEDULED", runAt: nextOccurrenceAfter(schedule, new Date()), attempts: 0, lastError: "Unregistered job type", lockedBy: null, lockedUntil: null, updatedAt: new Date() })
        .where(sql`${scheduledJobTable.id} = ${job.id}`);
    } else {
      await db.update(scheduledJobTable).set({ status: "DEAD_LETTER", lastError: "Unregistered job type", lockedBy: null, lockedUntil: null, updatedAt: new Date() })
        .where(sql`${scheduledJobTable.id} = ${job.id}`);
    }
    return;
  }

  if (schedule) {
    // §29/§31 (B2) — recurring/cron jobs never reach a terminal one-time
    // COMPLETED/DEAD_LETTER status; see dispatchRecurringJob()'s header.
    await dispatchRecurringJob(job, schedule);
    return;
  }

  const def = getJobHandlerDefinition(job.jobType)!;
  const attemptNumber = job.attempts + 1;
  const startedAt = new Date();
  // Part G1 — §39's `scheduler_lag`: how late this dispatch started
  // relative to the job's own `run_at`. Recorded here, before the handler
  // runs, since lag is about queue wait time, not handler behavior — a
  // slow handler shouldn't inflate this number. Clamped to >= 0 by
  // createLatencyHistogram() itself (see that file's own guard) — in
  // practice `startedAt` is always >= `job.runAt` (claimNextBatch() only
  // claims rows where `run_at <= now()`), but the guard is defensive
  // against clock skew between the claiming query and this line, not
  // load-bearing logic.
  recordSchedulerLag(startedAt.getTime() - job.runAt.getTime());

  // Plain locals rather than a discriminated-union `outcome` object —
  // simplest way to avoid TS narrowing quirks once these values get read
  // back inside the nested db.transaction() closure below (a captured
  // outer variable doesn't reliably narrow inside a nested function).
  let succeeded = true;
  let errorMessage: string | null = null;

  try {
    await def.handler(job);
  } catch (err: any) {
    succeeded = false;
    errorMessage = (err?.message ?? String(err)).slice(0, 4000);
    logger.warn({ jobId: job.id, jobType: job.jobType, err }, "Scheduler: job handler failed");
  }
  // Part G1 — §39's `job_execution_duration`. Recorded once, after the
  // try/catch above, regardless of success/failure — same "outcome is
  // already covered elsewhere, latency measures the handler's own time"
  // reasoning as event-bus's handlerLatencyMs.
  recordJobExecutionDuration(Date.now() - startedAt.getTime());

  const willDeadLetter = !succeeded && shouldDeadLetter(attemptNumber, job.maxAttempts);

  await db.transaction(async (trx) => {
    await trx.insert(scheduledJobAttemptTable).values({
      jobId: job.id, attemptNumber, status: succeeded ? "SUCCEEDED" : "FAILED",
      startedAt, finishedAt: new Date(), error: errorMessage,
    });

    if (succeeded) {
      await trx.update(scheduledJobTable).set({ status: "COMPLETED", attempts: attemptNumber, lastError: null, lockedBy: null, lockedUntil: null, updatedAt: new Date() })
        .where(sql`${scheduledJobTable.id} = ${job.id}`);
      await publishEvent({ type: "scheduler.job.completed", payload: { jobId: job.id, jobType: job.jobType }, traceId: job.traceId, correlationId: job.correlationId, causationId: job.causationId ?? job.correlationId }, trx);
      recordJobExecuted();
      return;
    }

    if (willDeadLetter) {
      await trx.update(scheduledJobTable).set({ status: "DEAD_LETTER", attempts: attemptNumber, lastError: errorMessage, lockedBy: null, lockedUntil: null, updatedAt: new Date() })
        .where(sql`${scheduledJobTable.id} = ${job.id}`);
      await publishEvent({ type: "scheduler.job.deadlettered", payload: { jobId: job.id, jobType: job.jobType, attempts: attemptNumber }, traceId: job.traceId, correlationId: job.correlationId, causationId: job.causationId }, trx);
      recordJobFailed();
      recordJobDeadLettered();
      // moveToDeadLetter does its own insert with unique-violation swallowing; run after the tx commits rather than inside it, since a duplicate-key retry there shouldn't roll back the job-state update above.
      return;
    }

    const delay = nextAttemptDelayMs(attemptNumber);
    await trx.update(scheduledJobTable).set({
      status: "RETRYING", attempts: attemptNumber, lastError: errorMessage,
      runAt: new Date(Date.now() + delay), lockedBy: null, lockedUntil: null, updatedAt: new Date(),
    }).where(sql`${scheduledJobTable.id} = ${job.id}`);
     await publishEvent({ type: "scheduler.job.failed", payload: { jobId: job.id, jobType: job.jobType, attempts: attemptNumber, lastError: errorMessage ?? "", willRetry: true }, traceId: job.traceId, correlationId: job.correlationId, causationId: job.causationId }, trx);
    recordJobFailed();
    recordJobRetried();
  });

  if (willDeadLetter) {
    await moveToDeadLetter({ jobId: job.id, jobType: job.jobType, payload: job.payload as Record<string, unknown> | undefined, attempts: attemptNumber, lastError: errorMessage ?? "" });
  }
}

/**
 * §29 Recurring/Cron + §31 Misfire Handling — Part B2. A recurring/cron
 * job's row never reaches a terminal state the way a one-time job's
 * (dispatchJob() above) does: every dispatch either
 *   - succeeds -> re-armed SCHEDULED at the next occurrence, attempts
 *     reset to 0 (§28's `attempts` is scoped to "retries of the CURRENT
 *     due occurrence", not a lifetime counter across occurrences — a
 *     transient failure on Tuesday's run shouldn't count against
 *     Wednesday's),
 *   - fails but hasn't exhausted max_attempts -> RETRYING with backoff,
 *     same as a one-time job (retry.ts's nextAttemptDelayMs()), or
 *   - exhausts max_attempts -> THIS occurrence is written to
 *     scheduled_job_dead_letter (so an operator can see it happened and,
 *     if it matters, replay it as a one-time job via replayDeadLetter()),
 *     but the row itself is STILL re-armed for its next occurrence rather
 *     than terminating. A single bad run can never permanently kill a
 *     recurring schedule — only cancelJob() (B1, unchanged) does that.
 *
 * §31's misfire policy is resolved once per dispatch, against the row's
 * own (possibly overdue) `run_at` as the "due since" reference point —
 * see misfire.ts's resolveMisfire(). Under CATCH_UP, multiple occurrences
 * run sequentially in this same dispatch; if any one of them throws, the
 * remaining ones in that batch are NOT attempted (the whole dispatch is
 * treated as one failed attempt and retried/backed-off as a unit, same as
 * a single-occurrence failure would be) — simpler and safer than trying
 * to track partial-batch completion across retries.
 */
async function dispatchRecurringJob(job: ScheduledJob, schedule: Schedule): Promise<void> {
  const def = getJobHandlerDefinition(job.jobType)!;
  const attemptNumber = job.attempts + 1;
  const now = new Date();
  const policy: MisfirePolicy = job.misfirePolicy ?? "RUN_ONCE";
  const plan = resolveMisfire(schedule, job.runAt, now, policy);

  if (plan.missedCount > 0) {
    logger.warn({ jobId: job.id, jobType: job.jobType, missed: plan.missedCount, policy }, "Scheduler: recurring job misfired");
    logBus.warn(`Scheduler: "${job.jobType}" (${job.id}) misfired — ${plan.missedCount} occurrence(s) overdue, policy=${policy}`);
  }

  const startedAt = new Date();
  // Part G1 — §39's `scheduler_lag`, same reasoning as dispatchJob()'s own
  // recording site above: measured against `job.runAt` (the OVERDUE
  // occurrence's own due time misfire.ts's resolveMisfire() was called
  // with), before the handler loop runs.
  recordSchedulerLag(startedAt.getTime() - job.runAt.getTime());

  let succeeded = true;
  let errorMessage: string | null = null;
  let executed = 0;

  try {
    for (const occurrenceAt of plan.runsToExecute) {
      await def.handler({ ...job, runAt: occurrenceAt });
      executed++;
    }
  } catch (err: any) {
    succeeded = false;
    errorMessage = (err?.message ?? String(err)).slice(0, 4000);
    logger.warn({ jobId: job.id, jobType: job.jobType, executed, planned: plan.runsToExecute.length, err }, "Scheduler: recurring job handler failed");
  }
  // Part G1 — §39's `job_execution_duration`, covering the WHOLE
  // `runsToExecute` loop (potentially several occurrences under
  // CATCH_UP) as one sample — this dispatch is already treated as one
  // unit for retry/backoff purposes (see this function's own header), so
  // its duration is measured the same way, not per-occurrence.
  recordJobExecutionDuration(Date.now() - startedAt.getTime());

  const willDeadLetter = !succeeded && shouldDeadLetter(attemptNumber, job.maxAttempts);

  await db.transaction(async (trx) => {
    await trx.insert(scheduledJobAttemptTable).values({
      jobId: job.id, attemptNumber, status: succeeded ? "SUCCEEDED" : "FAILED",
      startedAt, finishedAt: new Date(), error: errorMessage,
    });

    if (succeeded) {
      await trx.update(scheduledJobTable).set({ status: "SCHEDULED", runAt: plan.nextRunAt, attempts: 0, lastError: null, lockedBy: null, lockedUntil: null, updatedAt: new Date() })
        .where(sql`${scheduledJobTable.id} = ${job.id}`);
       await publishEvent({ type: "scheduler.job.completed", payload: { jobId: job.id, jobType: job.jobType, occurrences: executed, missed: plan.missedCount }, traceId: job.traceId, correlationId: job.correlationId, causationId: job.causationId ?? job.correlationId }, trx);
      recordJobExecuted();
      return;
    }

    if (willDeadLetter) {
      // This occurrence is dead-lettered, but the SCHEDULE lives on — see this function's header.
      await trx.update(scheduledJobTable).set({ status: "SCHEDULED", runAt: plan.nextRunAt, attempts: 0, lastError: errorMessage, lockedBy: null, lockedUntil: null, updatedAt: new Date() })
        .where(sql`${scheduledJobTable.id} = ${job.id}`);
       await publishEvent({ type: "scheduler.job.deadlettered", payload: { jobId: job.id, jobType: job.jobType, attempts: attemptNumber, missed: plan.missedCount }, traceId: job.traceId, correlationId: job.correlationId, causationId: job.causationId }, trx);
      recordJobFailed();
      recordJobDeadLettered();
      // moveToDeadLetter runs after the tx commits (below) — same reasoning as dispatchJob()'s own comment: a duplicate-key retry there shouldn't roll back the job-state update above.
      return;
    }

    const delay = nextAttemptDelayMs(attemptNumber);
    await trx.update(scheduledJobTable).set({
      status: "RETRYING", attempts: attemptNumber, lastError: errorMessage,
      runAt: new Date(Date.now() + delay), lockedBy: null, lockedUntil: null, updatedAt: new Date(),
    }).where(sql`${scheduledJobTable.id} = ${job.id}`);
     await publishEvent({ type: "scheduler.job.failed", payload: { jobId: job.id, jobType: job.jobType, attempts: attemptNumber, lastError: errorMessage ?? "", willRetry: true }, traceId: job.traceId, correlationId: job.correlationId, causationId: job.causationId }, trx);
    recordJobFailed();
    recordJobRetried();
  });

  if (willDeadLetter) {
    await moveToDeadLetter({ jobId: job.id, jobType: job.jobType, payload: job.payload as Record<string, unknown> | undefined, attempts: attemptNumber, lastError: errorMessage ?? "" });
  }
}

/** One worker tick: claim a batch, dispatch each row sequentially. Exposed for tests/manual triggering. */
export async function runSchedulerSweep(): Promise<{ claimed: number }> {
  recordWorkerSweepStart();
  try {
    await recoverExpiredLeases();

    const batch = await claimNextBatch(CLAIM_BATCH_SIZE);
    if (!batch.length) return { claimed: 0 };

    for (const row of batch) {
      await dispatchJob(row);
    }

    logBus.system(`⏱️ Scheduler sweep: dispatched ${batch.length} job(s)`);
    return { claimed: batch.length };
  } catch (err) {
    recordWorkerFailure();
    throw err;
  } finally {
    recordWorkerSweepEnd();
  }
}

/**
 * §30: "lease expires -> job becomes claimable -> another worker
 * resumes." Reclaims any RUNNING row whose locked_until has passed back
 * to RETRYING (not straight back to SCHEDULED — a lease that expired
 * without the worker ever reporting back IS a failed attempt, so it
 * should count against attempts/backoff the same as a thrown error would,
 * unlike event-bus's stale-lock sweep which deliberately does NOT bump
 * attempts — the difference is event_outbox's stuck-timeout is a same-
 * instance-hang guard on top of a short poll interval, while a scheduler
 * job's lease is long (5 min) specifically because it's expected to cover
 * genuine crash/restart gaps, where "silently retry forever without
 * counting it" risks a permanently wedged job type never reaching dead
 * letter).
 */
async function recoverExpiredLeases(): Promise<void> {
  const reclaimed = await db.execute(sql`
    UPDATE scheduled_job
    SET status = 'RETRYING', attempts = attempts + 1,
        last_error = 'Lease expired — worker likely died mid-execution',
        run_at = now(), locked_by = NULL, locked_until = NULL, updated_at = now()
    WHERE status = 'RUNNING' AND locked_until < now() AND attempts + 1 < max_attempts
    RETURNING id, job_type
  `);

  const rows = reclaimed.rows as { id: string; job_type: string }[];
  if (rows.length) {
    logger.warn({ count: rows.length }, "Scheduler: reclaimed jobs with expired leases");
    logBus.warn(`Scheduler: reclaimed ${rows.length} job(s) whose lease expired (worker likely died mid-execution)`);
  }

  // Rows about to exhaust max_attempts are SELECTed (not bulk-UPDATEd the
  // way the reclaim above is) because, as of B2, what happens to them
  // depends on whether they're recurring — a one-time job still goes
  // straight to terminal DEAD_LETTER (unchanged from B1), but a
  // cron/interval job needs its next occurrence computed in JS (the cron
  // parser has no SQL equivalent) and gets re-armed SCHEDULED instead, per
  // dispatchRecurringJob()'s "one bad run can't kill a recurring schedule"
  // rule. `FOR UPDATE SKIP LOCKED` inside this transaction holds the same
  // row-level lock a bulk UPDATE would, so a concurrent worker process
  // can't double-claim these rows while we compute their next occurrence.
  type DeadLetterCandidateRow = {
    id: string; job_type: string; attempts: number;
    payload: Record<string, unknown> | null;
    cron: string | null; timezone: string | null; interval_ms: string | number | null;
    created_at: string | Date;
  };
  const candidates = await db.transaction(async (trx) => {
    const found = await trx.execute(sql`
      SELECT id, job_type, attempts, payload, cron, timezone, interval_ms, created_at
      FROM scheduled_job
      WHERE status = 'RUNNING' AND locked_until < now() AND attempts + 1 >= max_attempts
      FOR UPDATE SKIP LOCKED
    `);
    const rows = found.rows as DeadLetterCandidateRow[];
    for (const c of rows) {
      const attempts = c.attempts + 1;
      const schedule: Schedule | undefined = c.cron
        ? { kind: "cron", cron: c.cron, timezone: c.timezone ?? "UTC" }
        : c.interval_ms
        ? { kind: "interval", intervalMs: Number(c.interval_ms), anchor: new Date(c.created_at) }
        : undefined;

      if (schedule) {
        const nextRunAt = nextOccurrenceAfter(schedule, new Date());
        await trx.update(scheduledJobTable).set({
          status: "SCHEDULED", runAt: nextRunAt, attempts: 0,
          lastError: "Lease expired — max attempts reached, worker likely died mid-execution",
          lockedBy: null, lockedUntil: null, updatedAt: new Date(),
        }).where(sql`${scheduledJobTable.id} = ${c.id}`);
      } else {
        await trx.update(scheduledJobTable).set({
          status: "DEAD_LETTER", attempts,
          lastError: "Lease expired — max attempts reached, worker likely died mid-execution",
          lockedBy: null, lockedUntil: null, updatedAt: new Date(),
        }).where(sql`${scheduledJobTable.id} = ${c.id}`);
      }
    }
    return rows.map((c) => ({ id: c.id, jobType: c.job_type, payload: c.payload ?? undefined, attempts: c.attempts + 1 }));
  });

  for (const d of candidates) {
    await moveToDeadLetter({ jobId: d.id, jobType: d.jobType, payload: d.payload, attempts: d.attempts, lastError: "Lease expired — max attempts reached" });
  }
}

/** Startup recovery — a RUNNING row this fresh process finds is, by definition, from a previous instance that never reported back. Same treatment as the per-tick lease sweep. */
async function recoverOnStartup(): Promise<void> {
  await recoverExpiredLeases(); // locked_until is already in the past for anything genuinely orphaned from a prior process, so the normal expiry sweep covers startup too — no separate query needed (contrast mail-send-queue.ts, whose stuck-timeout is relative to locked_at rather than an absolute expiry column).
}

let scheduled = false;

/** Starts the scheduler's poll loop. Every 5s by default, same cadence as the Event Bus dispatcher and the mail send queue. */
export function startSchedulerWorker(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.SCHEDULER_DISPATCH_CRON ?? "*/5 * * * * *"; // every 5s
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "SCHEDULER_DISPATCH_CRON is not a valid cron expression — Scheduler worker disabled");
    logBus.warn(`Scheduler worker disabled: invalid schedule "${expr}"`);
    return;
  }

  recoverOnStartup().catch((err) => {
    recordWorkerFailure();
    logger.error({ err }, "Scheduler startup recovery failed");
    logBus.error(`Scheduler startup recovery failed: ${err?.message ?? err}`);
  }).finally(() => {
    cron.schedule(expr, () => {
      runSchedulerSweep().catch((err) => {
        logger.error({ err }, "Scheduler sweep failed");
        logBus.error(`Scheduler sweep failed: ${err?.message ?? err}`);
      });
    });

    logBus.system(`✅ Scheduler worker scheduled ("${expr}")`);
    logger.info({ expr, workerId: WORKER_ID }, "Scheduler worker scheduled");
  });
}
