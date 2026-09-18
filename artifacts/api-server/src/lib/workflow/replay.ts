/**
 * lib/workflow/replay.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part F1 (§65's "F: Reliability/
 * security"; concretely, §58's Workflow test list's own "replay" /
 * "cancellation" rows, and the "workflow replay" line under §58's
 * Security test list). Event Bus (Part A) and Scheduler (Part B1) have
 * had dead-letter replay since their own phases — `event-bus/
 * dead-letter.ts`'s `replayDeadLetter()`, `scheduler/dead-letter.ts`'s
 * `replayDeadLetter()` — but nothing analogous has ever existed for a
 * stuck/failed Workflow run. This file is that missing third piece.
 *
 * A workflow run's "replay" can't be event-bus/scheduler dead-letter
 * replay's simple "re-insert one row" — a run is a whole multi-step
 * process, not a single queued unit of work — so this reduces to
 * `run-store.ts`'s own `startRun()` (a fresh run, same definition +
 * context, `causationId` pointing at the run being replayed, same "the
 * new record is caused by the original" convention both dead-letter
 * `replayDeadLetter()`s already use) immediately followed by
 * `engine.ts`'s `executeRun()` — i.e. exactly what
 * `workflow/schedule-triggers.ts`'s own trigger-job handler already does
 * to start any fresh run, reused here instead of duplicated.
 */
import { getRun, startRun } from "./run-store";
import { executeRun, type WorkflowRuntimeEnv } from "./engine";
import type { WorkflowRunStatus } from "./types";

/**
 * Only a run that DIDN'T finish the way it was supposed to is
 * replayable. `COMPLETED`/`COMPENSATED` are successful terminal
 * outcomes — replaying one isn't "recovery", it's re-running a business
 * process that already did its job once, which risks duplicate
 * real-world side effects (§54's own concurrency-controls list exists
 * precisely to prevent this kind of double-effect) for no reliability
 * benefit. `PENDING`/`RUNNING`/`WAITING`/`COMPENSATING` aren't terminal
 * at all — replaying a run that might still be actively progressing
 * makes no sense and `state-machine.ts`'s own `RUN_TRANSITIONS` would
 * never produce a legitimate reason to reach for this on one of those.
 */
const REPLAYABLE_STATUSES: readonly WorkflowRunStatus[] = ["FAILED", "TIMED_OUT", "CANCELLED", "DEAD_LETTER"];

export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`Run "${runId}" not found`);
    this.name = "RunNotFoundError";
  }
}

export class RunNotReplayableError extends Error {
  constructor(public readonly runId: string, public readonly status: WorkflowRunStatus) {
    super(`Run "${runId}" is ${status} — only ${REPLAYABLE_STATUSES.join("/")} runs can be replayed`);
    this.name = "RunNotReplayableError";
  }
}

/**
 * Starts and immediately drives a fresh run of the SAME
 * `definitionId`/`definitionVersion` the original run used (not
 * whatever is currently ACTIVE — `startRun()`'s own `definitionVersion`
 * param already supports pinning to an exact version, same as
 * `getDefinition(id, version)`'s branch in that file), carrying the
 * original run's `context`/`correlationId` forward so the replayed run's
 * business data matches what actually failed, not a stale/default
 * context. `env` is the same `WorkflowRuntimeEnv` fail-closed-by-default
 * shape every other caller of `executeRun()` already threads through
 * (see `engine.ts`'s own doc comment) — an admin caller with no real
 * policy engine assembled yet gets the same safe `{}` default any other
 * caller does, not a bypass.
 *
 * Runs the new run's execution loop INLINE (`await executeRun(...)`,
 * not fire-and-forget) — same choice `workflow/schedule-triggers.ts`'s
 * own trigger-job handler already makes for a fresh run it starts;
 * `executeRun()` itself returns as soon as the run either finishes or
 * parks into WAITING, so this doesn't block on however long the whole
 * business process eventually takes to complete, only on however far it
 * gets before its first wait/finish.
 */
export async function replayRun(runId: string, env: WorkflowRuntimeEnv = {}): Promise<{ newRunId: string }> {
  const run = await getRun(runId);
  if (!run) throw new RunNotFoundError(runId);
  if (!REPLAYABLE_STATUSES.includes(run.status)) throw new RunNotReplayableError(runId, run.status);

  const { id: newRunId } = await startRun({
    definitionId: run.definitionId,
    definitionVersion: run.definitionVersion,
    context: run.context,
    correlationId: run.correlationId,
    causationId: run.id,
  });

  await executeRun(newRunId, env);
  return { newRunId };
}
