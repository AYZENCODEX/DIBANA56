/**
 * lib/workflow/run-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core
 * (§17 State Machine, §18 Durable State, §26 Idempotency). The write/read
 * side of a run — same split scheduler/job-store.ts draws for jobs
 * (this file owns getting a run onto, and off of, the table; the actual
 * step-by-step execution loop that dispatches actions and evaluates
 * conditions is Part C2's engine.ts, same way worker.ts is scheduler's
 * separate execution half).
 *
 * startRun(params, tx) takes the same optional transaction handle
 * publisher.ts's publishEvent() and scheduler/job-store.ts's scheduleJob()
 * do, for the same reason: a run is very often started as a direct
 * consequence of a business write or an event handler, and should land
 * durably in the same commit as whatever triggered it.
 */
import crypto from "crypto";
import { z } from "zod/v4";
import { db, workflowRunTable, workflowStepRunTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getActiveDefinition, getDefinition } from "./definition-store";
import { assertRunTransition, assertStepTransition, isTerminalRunStatus } from "./state-machine";
import { recordRunStarted, recordRunTransition, recordRunDuration } from "./metrics";
import { buildIdempotencyKey } from "./types";
import { registerEvent, publishEvent } from "../event-bus";
import { cancelJobsForCorrelation } from "../scheduler";
import { WORKFLOW_RESUME_JOB_TYPE } from "./scheduler-integration";
import type { StartWorkflowRunParams, WorkflowContext, WorkflowRun, WorkflowRunStatus, WorkflowStepRun, WorkflowStepRunStatus } from "./types";
import type { CompensationState } from "./engine-types";
import { ensureTraceId, getCurrentTraceContext } from "../trace-context";
import { logger } from "../logger";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Part G2 — §39's opening list item, carried forward untouched through
// D2/E1/E2/E3's own "Still open" sections every time: "Workflow -> Event
// Bus (reverse direction): run lifecycle (workflow.started/.completed/
// .failed) publishing as its own event — still not registered." This is
// that registration. Self-registered here (not added to event-registry.ts's
// own DEFAULT_EVENT_TYPES list) — same "individual domain modules... take
// over registering their own types" convention scheduler/worker.ts's own
// scheduler.job.* registrations already established for a sibling engine
// reaching the bus in the same reverse direction (worker.ts's own header:
// "Self-registered here... matches that file's header").
//
// Deliberately only these three, not every WorkflowRunStatus — this is the
// exact scope §39/D2/E1/E2/E3 have all named, word for word, every time
// this item was carried forward. CANCELLED/TIMED_OUT/COMPENSATED/
// DEAD_LETTER/etc. stay in-process-counter-only for now
// (recordRunTransition() in metrics.ts already covers COMPLETED/FAILED/
// TIMED_OUT there; TIMED_OUT specifically is NOT in this phase's three —
// not a missing case, the same "start simple, only what's specified"
// posture every metrics module in this codebase already documents for
// itself). A future phase can widen this list; this one does not guess
// ahead of what's actually been asked for (Rule 17).
registerEvent({
  type: "workflow.started",
  version: 1,
  owner: "workflow",
  schema: z.object({ runId: z.string(), definitionId: z.string(), definitionVersion: z.number() }),
});
registerEvent({
  type: "workflow.completed",
  version: 1,
  owner: "workflow",
  schema: z.object({ runId: z.string(), definitionId: z.string(), definitionVersion: z.number() }),
});
registerEvent({
  type: "workflow.failed",
  version: 1,
  owner: "workflow",
  // `lastError` optional — a FAILED transition's `patch.lastError` is
  // itself optional (see transitionRun()'s own Pick<...> type), so this
  // schema mirrors that rather than assuming every FAILED transition
  // supplies one.
  schema: z.object({ runId: z.string(), definitionId: z.string(), definitionVersion: z.number(), lastError: z.string().optional() }),
});
registerEvent({
  type: "workflow.cancelled",
  version: 1,
  owner: "workflow",
  schema: z.object({ runId: z.string(), definitionId: z.string(), definitionVersion: z.number(), lastError: z.string().optional() }),
});
registerEvent({
  type: "workflow.timed_out",
  version: 1,
  owner: "workflow",
  schema: z.object({ runId: z.string(), definitionId: z.string(), definitionVersion: z.number(), lastError: z.string().optional() }),
});

export class DefinitionNotFoundError extends Error {
  constructor(workflowId: string, version?: number) {
    super(version ? `Workflow definition "${workflowId}" version ${version} not found` : `No ACTIVE version of workflow definition "${workflowId}" found`);
    this.name = "DefinitionNotFoundError";
  }
}

function rowToRun(row: typeof workflowRunTable.$inferSelect): WorkflowRun {
  return {
    id: row.id,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    status: row.status as WorkflowRunStatus,
    currentStepId: row.currentStepId ?? undefined,
    context: row.context as WorkflowContext,
    traceId: row.traceId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    causationId: row.causationId ?? undefined,
    maxRuntimeMs: row.maxRuntimeMs ?? undefined,
    lastError: row.lastError ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    nextResumeAt: row.nextResumeAt ?? undefined,
    compensationState: row.compensationState ?? undefined,
    compensationAttempts: row.compensationAttempts,
    maxCompensationAttempts: row.maxCompensationAttempts,
    executionOwner: row.executionOwner ?? undefined,
    executionLeaseUntil: row.executionLeaseUntil ?? undefined,
    executionVersion: row.executionVersion,
    createdAt: row.createdAt,
  };
}

const EXECUTION_LEASE_MS = 60_000;

/**
 * J8 — atomically claims a run for one worker. This is intentionally a
 * database compare-and-set rather than an in-memory mutex: scheduler
 * redelivery, multiple API instances, and deployment restarts all share the
 * same durable guard.
 */
export async function claimRunExecution(runId: string, owner: string, leaseMs = EXECUTION_LEASE_MS): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + Math.max(5_000, leaseMs));
  const result = await db.update(workflowRunTable)
    .set({ executionOwner: owner, executionLeaseUntil: until, executionVersion: sql`${workflowRunTable.executionVersion} + 1`, updatedAt: now })
    .where(and(
      eq(workflowRunTable.id, runId),
       inArray(workflowRunTable.status, ["PENDING", "RUNNING", "WAITING", "COMPENSATING"]),
      sql`(${workflowRunTable.executionOwner} IS NULL OR ${workflowRunTable.executionLeaseUntil} IS NULL OR ${workflowRunTable.executionLeaseUntil} < ${now})`,
    ))
    .returning({ id: workflowRunTable.id });
  return result.length > 0;
}

export async function heartbeatRunExecution(runId: string, owner: string, leaseMs = EXECUTION_LEASE_MS): Promise<boolean> {
  const until = new Date(Date.now() + Math.max(5_000, leaseMs));
  const result = await db.update(workflowRunTable)
    .set({ executionLeaseUntil: until, updatedAt: new Date() })
    .where(and(eq(workflowRunTable.id, runId), eq(workflowRunTable.executionOwner, owner), inArray(workflowRunTable.status, ["RUNNING", "COMPENSATING"])))
    .returning({ id: workflowRunTable.id });
  return result.length > 0;
}

export async function releaseRunExecution(runId: string, owner: string): Promise<void> {
  await db.update(workflowRunTable)
    .set({ executionOwner: null, executionLeaseUntil: null, updatedAt: new Date() })
    .where(and(eq(workflowRunTable.id, runId), eq(workflowRunTable.executionOwner, owner)));
}

function rowToStepRun(row: typeof workflowStepRunTable.$inferSelect): WorkflowStepRun {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    attempt: row.attempt,
    status: row.status as WorkflowStepRunStatus,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    idempotencyKey: row.idempotencyKey,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Creates a run in PENDING and its first step-run row (also PENDING, for
 * `steps[0]` — §16's steps array order is the entry point; there is no
 * separate "start step" field in WorkflowDefinition). Does NOT transition
 * the run to RUNNING or execute anything — that first RUNNING transition,
 * and every step dispatch after it, belongs to Part C2's execution loop,
 * same way scheduler/job-store.ts's scheduleJob() only inserts a row and
 * leaves claiming/dispatching to worker.ts.
 */
export async function startRun(params: StartWorkflowRunParams, tx?: DbTx): Promise<{ id: string }> {
  const def = params.definitionVersion
    ? await getDefinition(params.definitionId, params.definitionVersion)
    : await getActiveDefinition(params.definitionId);
  if (!def) throw new DefinitionNotFoundError(params.definitionId, params.definitionVersion);

  const id = crypto.randomUUID();
  const executor = tx ?? db;
  const firstStep = def.steps[0];
  const requestContext = getCurrentTraceContext();
  const correlationId = params.correlationId ?? requestContext?.correlationId;
  const causationId = params.causationId ?? requestContext?.causationId;

  try {
    await executor.insert(workflowRunTable).values({
      id,
      definitionId: def.id,
      definitionVersion: def.version,
      status: "PENDING",
      currentStepId: firstStep.id,
      context: (params.context ?? {}) as Record<string, unknown>,
      traceId: ensureTraceId(params.traceId, correlationId),
      correlationId,
      causationId,
      maxRuntimeMs: def.maxRuntimeMs,
    });
  } catch (err: any) {
    // Part H1 (migration 114) — the durable, cross-restart backstop
    // triggers.ts's own header named verbatim: a UNIQUE(definition_id,
    // causation_id) partial index (only when causationId is present —
    // see that migration's own header for why a plain unique index
    // would be wrong). Two possible callers of this race: the same
    // process's in-memory dedupe set (triggers.ts's startedForEvent /
    // schedule-triggers.ts's alreadyScheduled) missed it because it was
    // reset by a restart, OR two different process instances both
    // handled the same redelivered envelope before either committed —
    // same "which insert won the race doesn't matter, the outcome is
    // the same fact either way" posture event-bus/idempotency.ts's own
    // markProcessed() already documents for itself. Only treated as
    // this specific, expected race when params.causationId was actually
    // supplied — that's the only condition under which this partial
    // index could ever fire, so anything else re-throws un-swallowed.
    // Deliberately queries via the bare `db` pool, not `executor` — if a
    // caller passed `tx` and the insert above failed inside it, Postgres
    // has already put that transaction into its aborted state (any
    // further statement on the SAME tx would itself fail with "current
    // transaction is aborted" until rollback), so the lookup needs a
    // fresh connection regardless of whether the caller supplied one.
    // Note this means a `tx`-supplied caller that races on
    // (definitionId, causationId) still gets its OWN transaction
    // aborted by the failed insert, even though this function itself
    // recovers — that caller's surrounding transaction will fail on
    // COMMIT and needs to retry the whole operation, same as any other
    // constraint violation inside a caller-supplied transaction. Neither
    // of this phase's two actual callers (triggers.ts, schedule-
    // triggers.ts) pass a `tx`, so this edge case doesn't arise for the
    // scenario H1 was scoped to fix; a `tx`-supplied caller hitting this
    // same race is a pre-existing, separate condition this phase doesn't
    // newly introduce (without the constraint, that caller would
    // previously have silently created a duplicate run instead).
    const isUniqueViolation = err?.code === "23505" || /duplicate key/i.test(String(err?.message ?? ""));
    if (isUniqueViolation && params.causationId) {
      const [existing] = await db.select({ id: workflowRunTable.id }).from(workflowRunTable)
        .where(and(eq(workflowRunTable.definitionId, def.id), eq(workflowRunTable.causationId, params.causationId)))
        .limit(1);
      // Should always be found (that's exactly what the constraint just
      // reported), but if some other 23505 on this table raced in
      // between the failed insert and this lookup, fall through and
      // re-throw rather than returning a fabricated id.
      if (existing) return { id: existing.id };
    }
    throw err;
  }

  await executor.insert(workflowStepRunTable).values({
    runId: id,
    stepId: firstStep.id,
    attempt: 1,
    status: "PENDING",
    input: firstStep.input,
    idempotencyKey: buildIdempotencyKey(id, firstStep.id, 1),
  });

  recordRunStarted();

  // Part G2 — workflow.started. Passed the SAME optional `tx` this
  // function itself took, same reasoning as publisher.ts's own header:
  // when the caller gave us a transaction, the run's insert above and
  // this event's outbox row land in the same commit, so "a run exists"
  // and "a workflow.started event exists" can never disagree. When no
  // `tx` was given, this is the weaker, publisher.ts-documented
  // best-effort guarantee — same as every other optional-`tx` call site
  // in this codebase.
  await publishEvent(
    {
      type: "workflow.started",
      payload: { runId: id, definitionId: def.id, definitionVersion: def.version },
      correlationId,
      causationId,
      traceId: ensureTraceId(params.traceId, correlationId),
    },
    tx,
  );

  return { id };
}

export async function getRun(id: string): Promise<WorkflowRun | undefined> {
  const [row] = await db.select().from(workflowRunTable).where(eq(workflowRunTable.id, id)).limit(1);
  return row ? rowToRun(row) : undefined;
}

/**
 * Part F1 (§57-F Reliability, §58's "admin-only operations" test
 * surface) — the list-side counterpart getRun() never needed until now:
 * every prior caller of this file already knew the one `id` it wanted
 * (a job handler resuming a specific run, a definition looking up its
 * own runs isn't a thing this codebase does). An admin console browsing
 * "what's stuck" needs to filter/page instead. Newest-first — an
 * operator almost always wants recent activity, not the oldest row.
 */
export async function listRuns(
  filter?: { status?: WorkflowRunStatus; definitionId?: string; correlationId?: string },
  limit = 50,
): Promise<WorkflowRun[]> {
  const conditions = [];
  if (filter?.status) conditions.push(eq(workflowRunTable.status, filter.status));
  if (filter?.definitionId) conditions.push(eq(workflowRunTable.definitionId, filter.definitionId));
  if (filter?.correlationId) conditions.push(eq(workflowRunTable.correlationId, filter.correlationId));

  const rows = conditions.length
    ? await db.select().from(workflowRunTable).where(and(...conditions)).orderBy(desc(workflowRunTable.createdAt)).limit(limit)
    : await db.select().from(workflowRunTable).orderBy(desc(workflowRunTable.createdAt)).limit(limit);

  return rows.map(rowToRun);
}

export async function getStepRuns(runId: string): Promise<WorkflowStepRun[]> {
  const rows = await db.select().from(workflowStepRunTable).where(eq(workflowStepRunTable.runId, runId)).orderBy(workflowStepRunTable.id);
  return rows.map(rowToStepRun);
}

/**
 * Part C2 (engine.ts) — the step-run row engine.ts's main loop is about
 * to execute for `stepId`. By this file's own loop invariant (see
 * engine.ts's header), there is at most one PENDING row per (runId,
 * stepId) at any time — the most recent attempt, whether this is that
 * step's very first attempt or a retry's fresh row (insertStepRetry()
 * above always makes a NEW row rather than reusing the failed one).
 */
export async function getPendingStepRun(runId: string, stepId: string): Promise<WorkflowStepRun | undefined> {
  const rows = await db.select().from(workflowStepRunTable)
    .where(and(eq(workflowStepRunTable.runId, runId), eq(workflowStepRunTable.stepId, stepId), eq(workflowStepRunTable.status, "PENDING")))
    .orderBy(workflowStepRunTable.id);
  return rows.length ? rowToStepRun(rows[rows.length - 1]) : undefined;
}

/**
 * Part C2 (engine.ts) — advances `current_step_id` WITHOUT touching
 * `status`. Deliberately NOT part of transitionRun(): the run's STATUS
 * stays RUNNING across a step-to-step advance (state-machine.ts's
 * RUN_TRANSITIONS has no RUNNING -> RUNNING entry, and shouldn't — the
 * state machine governs STATUS changes, not the step pointer, which
 * moves far more often than status does within a single RUNNING span).
 * `null` clears it (Drizzle only omits a column from the UPDATE for a
 * literal `undefined`, never for `null` — engine.ts relies on this to
 * mean "no next step", distinct from "leave whatever was there").
 */
export async function advanceCurrentStep(runId: string, stepId: string | null, tx?: DbTx): Promise<void> {
  const executor = tx ?? db;
  await executor.update(workflowRunTable)
    .set({ currentStepId: stepId, updatedAt: new Date() })
    .where(eq(workflowRunTable.id, runId));
}

/**
 * §17-checked status update — goes through assertRunTransition() so an
 * illegal jump (e.g. a caller accidentally trying to move a COMPLETED run
 * back to RUNNING) throws here instead of silently corrupting the state
 * machine. `patch` carries whatever else that transition should also set
 * in the same UPDATE (e.g. `completedAt` alongside COMPLETED, `nextResumeAt`
 * alongside WAITING) — see this function's callers in Part C2's engine.ts.
 */
export async function transitionRun(
  id: string,
  to: WorkflowRunStatus,
  // Part C2 — `currentStepId`/`nextResumeAt` additionally accept an
  // explicit `null` (on top of Pick<WorkflowRun, ...>'s own `string |
  // undefined` / `Date | undefined`) so a caller can actually CLEAR
  // either column in the same UPDATE as a status change — e.g.
  // resumeRun() clearing `next_resume_at` on WAITING -> RUNNING.
  // `undefined` still means "leave unchanged" (omitted from the SQL
  // SET), matching advanceCurrentStep()'s own explicit-null contract
  // (see that function's doc comment) — this is the same rule extended
  // to transitionRun()'s patch.
  patch?: Partial<Pick<WorkflowRun, "lastError" | "startedAt" | "completedAt">> & {
    currentStepId?: string | null;
    nextResumeAt?: Date | null;
  },
  tx?: DbTx,
): Promise<void> {
  const current = await getRun(id);
  if (!current) throw new Error(`transitionRun: run "${id}" not found`);
  assertRunTransition(current.status, to);

  const executor = tx ?? db;
  await executor.update(workflowRunTable)
    .set({ status: to, ...patch, ...(isTerminalRunStatus(to) ? { executionOwner: null, executionLeaseUntil: null } : {}), updatedAt: new Date() })
    .where(eq(workflowRunTable.id, id));

  recordRunTransition(to);

  // Part G1 — §39's `workflow_duration`: total wall-clock duration of a
  // run, `startedAt` to the moment it reaches ANY terminal status (not
  // just COMPLETED — see WorkflowMetricsSnapshot.runDurationMs's own doc
  // comment). `current.startedAt` is the value BEFORE this transition's
  // own `patch` is applied, which is what we want here: a run reaching a
  // terminal status already has its `startedAt` set from the earlier
  // PENDING -> RUNNING transition, not from this update.
  if (isTerminalRunStatus(to) && current.startedAt) {
    recordRunDuration(Date.now() - current.startedAt.getTime());
  }

  // Part G2 — workflow.completed/.failed. Same `tx` this function itself
  // took, same reasoning as startRun()'s own workflow.started call above.
  // `correlationId` is the run's own (preserves the trace chain from
  // however the run was started); `causationId` is the run's own `id` —
  // this status change on THIS run is what directly caused the event,
  // there being no more specific "triggering event id" available inside
  // the engine's synchronous transition path.
  if (to === "COMPLETED") {
    await publishEvent(
      {
        type: "workflow.completed",
        payload: { runId: id, definitionId: current.definitionId, definitionVersion: current.definitionVersion },
        traceId: current.traceId,
        correlationId: current.correlationId,
        causationId: id,
      },
      tx,
    );
  } else if (to === "FAILED") {
    await publishEvent(
      {
        type: "workflow.failed",
        payload: { runId: id, definitionId: current.definitionId, definitionVersion: current.definitionVersion, lastError: patch?.lastError },
        traceId: current.traceId,
        correlationId: current.correlationId,
        causationId: id,
      },
      tx,
    );
  } else if (to === "CANCELLED" || to === "TIMED_OUT") {
    await publishEvent(
      {
        type: to === "CANCELLED" ? "workflow.cancelled" : "workflow.timed_out",
        payload: { runId: id, definitionId: current.definitionId, definitionVersion: current.definitionVersion, lastError: patch?.lastError },
        traceId: current.traceId,
        correlationId: current.correlationId,
        causationId: id,
      },
      tx,
    );
  }
}

export async function updateCompensationState(
  runId: string,
  state: CompensationState,
  lastError?: string,
  tx?: DbTx,
): Promise<void> {
  const executor = tx ?? db;
  await executor.update(workflowRunTable).set({
    compensationState: state as unknown as Record<string, unknown>,
    compensationAttempts: state.attempts,
    ...(lastError === undefined ? {} : { lastError }),
    updatedAt: new Date(),
  }).where(eq(workflowRunTable.id, runId));
}

/** Same §17-checked pattern as transitionRun(), for one step-run row. */
export async function transitionStepRun(
  stepRunId: number,
  to: WorkflowStepRunStatus,
  patch?: Partial<Pick<WorkflowStepRun, "output" | "error" | "startedAt" | "finishedAt">>,
  tx?: DbTx,
): Promise<void> {
  const [row] = await db.select().from(workflowStepRunTable).where(eq(workflowStepRunTable.id, stepRunId)).limit(1);
  if (!row) throw new Error(`transitionStepRun: step run ${stepRunId} not found`);
  assertStepTransition(row.status as WorkflowStepRunStatus, to);

  const executor = tx ?? db;
  await executor.update(workflowStepRunTable)
    .set({ status: to, ...patch })
    .where(eq(workflowStepRunTable.id, stepRunId));
}

/**
 * Inserts the next attempt row for a step that needs a retry — a NEW row
 * per migration 113's UNIQUE(run_id, step_id, attempt), not an UPDATE of
 * the failed one, so every attempt's own record (and idempotency key) is
 * preserved. `attempt` is the failed row's attempt + 1.
 */
export async function insertStepRetry(runId: string, stepId: string, attempt: number, input: Record<string, unknown> | undefined, tx?: DbTx): Promise<{ id: number }> {
  const executor = tx ?? db;
  const [row] = await executor.insert(workflowStepRunTable).values({
    runId, stepId, attempt, status: "PENDING", input,
    idempotencyKey: buildIdempotencyKey(runId, stepId, attempt),
  }).returning({ id: workflowStepRunTable.id });
  return row;
}

/**
 * Cancels a run that hasn't reached a terminal state. Only PENDING/
 * RUNNING/WAITING are cancellable per state-machine.ts's RUN_TRANSITIONS
 * — a run already COMPLETED/FAILED/etc. is left untouched, same
 * "only mutate it if it's still safe to" guard scheduler/job-store.ts's
 * cancelJob() uses. Returns whether this call was the one that cancelled it.
 *
 * Part I2 — also cancels this run's `workflow.resume` scheduler job, if
 * one is currently scheduled (only true for a WAITING run — see
 * scheduler-integration.ts's own doc comment for why `correlationId:
 * runId` makes it findable this way without this file needing the
 * job's own id). Deliberately unconditional rather than gated on
 * `current.status === "WAITING"`: `cancelJobsForCorrelation()` is
 * itself a safe no-op when nothing matches (a PENDING/actively-RUNNING
 * run has no resume job scheduled yet), so checking the run's own
 * status first would only add a second read for no behavioral
 * difference. This was previously a harmless-but-wasteful gap, not a
 * correctness bug: `resumeRun()`'s own `if (run.status !== "WAITING")
 * return` guard already no-ops safely whenever that job eventually
 * fired anyway (see CHANGES_MEGA_ENGINE_MIDSTEP_CANCELLATION_PHASE_I1.md's
 * "Still open" list) — this phase just stops scheduling a dispatch that
 * both sides already know will do nothing.
 */
export async function cancelRun(id: string, opts?: { reason?: string; actorUserId?: number }): Promise<boolean> {
  const cancellable: WorkflowRunStatus[] = ["PENDING", "RUNNING", "WAITING"];
  const updated = await db.update(workflowRunTable)
    .set({ status: "CANCELLED", lastError: opts?.reason ?? "Cancelled by operator", cancellationReason: opts?.reason ?? "Cancelled by operator", ...(opts?.actorUserId === undefined ? {} : { cancellationActorUserId: opts.actorUserId }), updatedAt: new Date() })
    .where(and(eq(workflowRunTable.id, id), inArray(workflowRunTable.status, cancellable)))
    .returning({ id: workflowRunTable.id });
  if (updated.length > 0) {
    await cancelJobsForCorrelation(WORKFLOW_RESUME_JOB_TYPE, id);
    const cancelled = await getRun(id);
    if (cancelled) {
      recordRunTransition("CANCELLED");
      try {
        await publishEvent({
          type: "workflow.cancelled",
          payload: {
            runId: cancelled.id,
            definitionId: cancelled.definitionId,
            definitionVersion: cancelled.definitionVersion,
            lastError: cancelled.lastError,
          },
          traceId: cancelled.traceId,
          correlationId: cancelled.correlationId,
          causationId: cancelled.id,
          actor: opts?.actorUserId ? { userId: opts.actorUserId, organizationId: cancelled.context.organizationId } : undefined,
        });
      } catch (err) {
        // Cancellation is already durably committed. Keep the state change
        // authoritative and surface a repairable outbox failure instead of
        // turning a successful cancellation into an HTTP error.
        logger.error({ err, runId: id }, "Workflow cancellation event publication failed");
      }
    }
  }
  return updated.length > 0;
}

/**
 * J13 startup recovery. A process can die after claiming a run but before it
 * releases its lease. Clearing only expired leases keeps the run's durable
 * state intact; the caller can then re-drive the same run from its current
 * pending/running step.
 */
export async function recoverExpiredRunLeases(): Promise<string[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.update(workflowRunTable)
      .set({ executionOwner: null, executionLeaseUntil: null, updatedAt: new Date() })
      .where(and(
        inArray(workflowRunTable.status, ["RUNNING", "COMPENSATING"]),
        sql`${workflowRunTable.executionLeaseUntil} IS NOT NULL`,
        sql`${workflowRunTable.executionLeaseUntil} < now()`,
      ))
      .returning({ id: workflowRunTable.id });
    const ids = rows.map((row) => row.id);
    if (ids.length) {
      // A crash can leave its current action attempt RUNNING. Re-arm that
      // durable attempt with the same idempotency key; handlers are required
      // to make that key safe for external effects.
      await tx.update(workflowStepRunTable)
        .set({ status: "PENDING", startedAt: null, error: "Recovered after worker lease expiry" })
        .where(and(inArray(workflowStepRunTable.runId, ids), eq(workflowStepRunTable.status, "RUNNING")));
    }
    return ids;
  });
}
