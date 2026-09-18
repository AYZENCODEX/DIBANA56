/**
 * lib/mega-engine/retention.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part E3 (§57-E's last two
 * bullets, "cleanup" + "retention" — the two items E1
 * (`CHANGES_MEGA_ENGINE_OBSERVABILITY_PHASE_E1.md`) and E2
 * (`CHANGES_MEGA_ENGINE_ADMIN_INSPECTION_PHASE_E2.md`) both carried
 * forward in their own "Still open" lists). Implements §60's own table:
 *
 *   event_outbox      -> short operational retention
 *   event_processing  -> compact retention
 *   dead_letter       -> longer operational retention
 *   workflow_run      -> configurable business retention
 *   scheduler attempts -> short operational retention
 *   audit             -> governed by existing audit policy (NOT touched
 *                         here — §60's own closing line: "Do not delete
 *                         audit records merely because event records
 *                         expire.")
 *
 * "dead_letter" above covers BOTH `event_dead_letter` (Part A) and
 * `scheduled_job_dead_letter` (Part B1) — the two engines' DLQ tables
 * are the same shape of thing (§57-E groups them as one bullet, and
 * engine-health.ts's own `checkEventBusDlq()`/`checkSchedulerDlq()`
 * already treat them as parallel signals).
 *
 * §60 lists six rows; this file targets five of them (everything except
 * `audit`, deliberately left alone). `scheduled_job` itself (the job
 * record, as opposed to its `scheduled_job_attempt` log rows) has no
 * §60 entry of its own — unlike `workflow_run`'s explicit "configurable
 * business retention", nothing in the blueprint says a completed
 * one-time job's row should ever be deleted, and a job row (e.g. "sent
 * this user their 30-minute reminder") can matter for the same kind of
 * business-record reasons a workflow_run does. Left alone here rather
 * than guessing a window for it — see this file's own closing "Still
 * open" note in the phase's CHANGES doc.
 *
 * Every window below is a fixed constant, not yet wired to §53
 * Configuration (no `RETENTION_*` env var exists in that section's own
 * list) — same "deliberately coarse V1, start simple" posture
 * engine-health.ts's own thresholds already document for themselves.
 * `workflow_run`'s window says "configurable" in §60 itself; until a
 * real config knob exists, `WORKFLOW_RUN_RETENTION_MS` below is that
 * knob's V1 placeholder, not a permanent hardcode.
 *
 * Every sweep is a plain, unbounded `DELETE ... WHERE` — no batching, no
 * pagination — the same "simple counts, not sophisticated" posture
 * every other Part E1/E2 file in this phase already has for itself; a
 * future phase can add batching once there's an actual table large
 * enough to need it.
 */
import {
  db,
  eventOutboxTable, eventProcessedTable, eventDeadLetterTable,
  scheduledJobAttemptTable, scheduledJobDeadLetterTable,
  workflowRunTable, workflowStepRunTable, workflowCheckpointTable, workflowVariableTable,
} from "@workspace/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import { registerJobHandler, scheduleCron, hasActiveJobForCorrelation, type ScheduledJob } from "../scheduler";
import type { WorkflowRunStatus } from "../workflow";

const DAY_MS = 24 * 60 * 60 * 1000;

/** §60's own six-row table, minus `audit` — see this file's header for why `scheduled_job` itself isn't a seventh row here. */
export const RETENTION_WINDOWS_MS = {
  /** "short operational retention" — only PUBLISHED rows; PENDING/FAILED ones are still engine-health.ts's own overdue-outbox signal and must never be swept regardless of age. */
  eventOutboxPublished: 3 * DAY_MS,
  /** "compact retention" — event_processed is a pure (event_id, consumer) idempotency-dedupe record; once past any plausible redelivery window it has no further use. */
  eventProcessed: 7 * DAY_MS,
  /** "longer operational retention" — both DLQ tables; only REPLAYED/DISCARDED rows (a still-PENDING dead letter is exactly what an operator is expected to still be looking at). */
  deadLetterResolved: 90 * DAY_MS,
  /** "configurable business retention" — see header re: V1 placeholder. Only terminal runs; cutoff is `updated_at`, not `completed_at`, because COMPLETED is currently the only run status that engine.ts sets `completedAt` on (FAILED/CANCELLED/COMPENSATED/DEAD_LETTER/TIMED_OUT don't) while every transitionRun() call — terminal or not — always bumps `updated_at` in the same UPDATE (see run-store.ts's transitionRun()), making it the one cutoff column reliably set for all six terminal statuses alike. */
  workflowRunTerminal: 180 * DAY_MS,
  /** "short operational retention" — per-attempt log rows, independent of whether their parent job (one-time or recurring) is itself still active. */
  scheduledJobAttempt: 14 * DAY_MS,
} as const;

/** state-machine.ts's own terminal set (`RUN_TRANSITIONS[status].length === 0`) — duplicated here as a literal list because this file deletes by SQL WHERE, not by calling isTerminalRunStatus() per row. */
const TERMINAL_RUN_STATUSES: WorkflowRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "COMPENSATED", "DEAD_LETTER"];

export interface RetentionSweepResult {
  eventOutboxDeleted: number;
  eventProcessedDeleted: number;
  eventDeadLetterDeleted: number;
  scheduledJobDeadLetterDeleted: number;
  scheduledJobAttemptDeleted: number;
  workflowRunsDeleted: number;
  workflowStepRunsDeleted: number;
  workflowCheckpointsDeleted: number;
  workflowVariablesDeleted: number;
  ranAt: string;
}

/**
 * §60's actual cleanup — deletes everything past its own window above.
 * Safe to call directly (an admin action, a test, a one-off backfill) or
 * through the recurring job this file also registers below; the job
 * handler is a thin wrapper around this same function, not a second
 * implementation.
 */
export async function runRetentionSweep(now: Date = new Date()): Promise<RetentionSweepResult> {
  const outboxCutoff = new Date(now.getTime() - RETENTION_WINDOWS_MS.eventOutboxPublished);
  const processedCutoff = new Date(now.getTime() - RETENTION_WINDOWS_MS.eventProcessed);
  const deadLetterCutoff = new Date(now.getTime() - RETENTION_WINDOWS_MS.deadLetterResolved);
  const workflowRunCutoff = new Date(now.getTime() - RETENTION_WINDOWS_MS.workflowRunTerminal);
  const attemptCutoff = new Date(now.getTime() - RETENTION_WINDOWS_MS.scheduledJobAttempt);

  const [eventOutboxDeleted, eventProcessedDeleted, eventDeadLetterDeleted, scheduledJobDeadLetterDeleted, scheduledJobAttemptDeleted] = await Promise.all([
    db.delete(eventOutboxTable)
      .where(and(eq(eventOutboxTable.status, "PUBLISHED"), lt(eventOutboxTable.publishedAt, outboxCutoff)))
      .returning({ id: eventOutboxTable.id })
      .then((rows) => rows.length),

    db.delete(eventProcessedTable)
      .where(lt(eventProcessedTable.processedAt, processedCutoff))
      .returning({ id: eventProcessedTable.id })
      .then((rows) => rows.length),

    db.delete(eventDeadLetterTable)
      .where(and(inArray(eventDeadLetterTable.status, ["REPLAYED", "DISCARDED"]), lt(eventDeadLetterTable.resolvedAt, deadLetterCutoff)))
      .returning({ id: eventDeadLetterTable.id })
      .then((rows) => rows.length),

    db.delete(scheduledJobDeadLetterTable)
      .where(and(inArray(scheduledJobDeadLetterTable.status, ["REPLAYED", "DISCARDED"]), lt(scheduledJobDeadLetterTable.resolvedAt, deadLetterCutoff)))
      .returning({ id: scheduledJobDeadLetterTable.id })
      .then((rows) => rows.length),

    db.delete(scheduledJobAttemptTable)
      .where(lt(scheduledJobAttemptTable.startedAt, attemptCutoff))
      .returning({ id: scheduledJobAttemptTable.id })
      .then((rows) => rows.length),
  ]);

  // workflow_run's three child tables (step_run/checkpoint/variable) have
  // no FK/cascade — schema/workflow.ts's own header says so explicitly
  // ("No `.references()` and no composite primary keys") — so the
  // children must be deleted before the parent, in one transaction, or a
  // crash between the two steps would leave orphaned child rows with no
  // parent to ever sweep them by.
  const { workflowRunsDeleted, workflowStepRunsDeleted, workflowCheckpointsDeleted, workflowVariablesDeleted } = await db.transaction(async (trx) => {
    const expiredRuns = await trx.select({ id: workflowRunTable.id })
      .from(workflowRunTable)
      .where(and(inArray(workflowRunTable.status, TERMINAL_RUN_STATUSES), lt(workflowRunTable.updatedAt, workflowRunCutoff)));
    const runIds = expiredRuns.map((r) => r.id);

    if (runIds.length === 0) {
      return { workflowRunsDeleted: 0, workflowStepRunsDeleted: 0, workflowCheckpointsDeleted: 0, workflowVariablesDeleted: 0 };
    }

    const stepRuns = await trx.delete(workflowStepRunTable).where(inArray(workflowStepRunTable.runId, runIds)).returning({ id: workflowStepRunTable.id });
    const checkpoints = await trx.delete(workflowCheckpointTable).where(inArray(workflowCheckpointTable.runId, runIds)).returning({ id: workflowCheckpointTable.id });
    const variables = await trx.delete(workflowVariableTable).where(inArray(workflowVariableTable.runId, runIds)).returning({ id: workflowVariableTable.id });
    const runs = await trx.delete(workflowRunTable).where(inArray(workflowRunTable.id, runIds)).returning({ id: workflowRunTable.id });

    return {
      workflowRunsDeleted: runs.length,
      workflowStepRunsDeleted: stepRuns.length,
      workflowCheckpointsDeleted: checkpoints.length,
      workflowVariablesDeleted: variables.length,
    };
  });

  const result: RetentionSweepResult = {
    eventOutboxDeleted, eventProcessedDeleted, eventDeadLetterDeleted, scheduledJobDeadLetterDeleted, scheduledJobAttemptDeleted,
    workflowRunsDeleted, workflowStepRunsDeleted, workflowCheckpointsDeleted, workflowVariablesDeleted,
    ranAt: now.toISOString(),
  };

  logger.info(result, "mega_engine.retention_sweep.completed");
  const totalDeleted = eventOutboxDeleted + eventProcessedDeleted + eventDeadLetterDeleted + scheduledJobDeadLetterDeleted + scheduledJobAttemptDeleted + workflowRunsDeleted;
  if (totalDeleted > 0) {
    logBus.system(`Mega Engine: retention sweep deleted ${totalDeleted} row(s) — ${JSON.stringify(result)}`);
  }
  return result;
}

/** §57-E "cleanup" as a recurring job, so it runs on its own rather than needing an operator to remember to call runRetentionSweep() by hand. */
export const MEGA_ENGINE_RETENTION_JOB_TYPE = "mega-engine.retention-sweep";

/** Same "safe to call twice, a later call just overwrites" posture every other registerJobHandler() call site in this codebase already documents (scheduler-handler.ts, schedule-triggers.ts). */
export function registerRetentionSweepHandler(): void {
  registerJobHandler(
    MEGA_ENGINE_RETENTION_JOB_TYPE,
    async (_job: ScheduledJob<undefined>) => { await runRetentionSweep(); },
    { defaultMaxAttempts: 3, owner: "mega-engine", description: "§57-E/§60 — deletes rows past their own retention window across all three engines (see retention.ts's own RETENTION_WINDOWS_MS)." },
  );
}

/**
 * Call once at boot, same ordering as `startSchedulerWorker()` (must run
 * after the scheduler's own job-registry import is live, same as every
 * other `registerJobHandler()` caller). Daily at 03:00 UTC — an
 * arbitrary low-traffic-by-convention slot, not derived from any actual
 * load measurement (§56 — start simple).
 *
 * This is a singleton recurring job, not one-per-something the way
 * `schedule-triggers.ts`'s per-definition cron jobs are — there's only
 * ever one retention sweep, so its own job type doubles as its
 * `correlationId` for `hasActiveJobForCorrelation()`'s boot-time dedupe
 * guard (same guard, same reason: `scheduleCron()` itself is not
 * idempotent, so a restart without this check would accumulate a new
 * duplicate daily job on every boot).
 */
export async function registerRetentionSweepSchedule(): Promise<void> {
  registerRetentionSweepHandler();

  if (await hasActiveJobForCorrelation(MEGA_ENGINE_RETENTION_JOB_TYPE, MEGA_ENGINE_RETENTION_JOB_TYPE)) {
    logger.info({}, "mega_engine.retention_sweep.schedule_already_registered");
    return;
  }

  await scheduleCron({
    jobType: MEGA_ENGINE_RETENTION_JOB_TYPE,
    cron: "0 3 * * *",
    timezone: "UTC",
    correlationId: MEGA_ENGINE_RETENTION_JOB_TYPE,
  });
  logger.info({}, "mega_engine.retention_sweep.schedule_registered");
}
