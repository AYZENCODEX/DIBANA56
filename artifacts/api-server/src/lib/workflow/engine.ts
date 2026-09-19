/**
 * lib/workflow/engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2: Workflow execution logic
 * (§20 Conditions, §21 Action registry/dispatch, §22 Policy Engine
 * Integration, §24 Waiting/scheduler-wakeup, §25 Compensation execution —
 * exactly migration 113's own list of what C1 deliberately left out).
 * This is the "actual step-by-step execution loop that dispatches actions
 * and evaluates conditions" run-store.ts's own header already named as
 * this file's job, same C1 -> C2 split worker.ts draws for scheduler
 * (job-store.ts only inserts a row; worker.ts claims/dispatches it).
 *
 * ── Loop invariant ──────────────────────────────────────────────────────
 * Whenever a run's `status` is RUNNING and `current_step_id` is set,
 * there is exactly one PENDING workflow_step_run row for
 * (run.id, current_step_id) — the attempt about to execute. Every place
 * this file changes `current_step_id` (advanceOrComplete(), parkForWait())
 * either inserts that row first or clears `current_step_id` to `null`
 * (advanceCurrentStep()'s own explicit-null contract — see run-store.ts)
 * when there is nothing next. run-store.ts's getPendingStepRun() is how
 * the loop recovers that row on each iteration, including after a crash/
 * restart mid-loop (§18's own durability requirement) — nothing here
 * holds loop state only in memory.
 *
 * ── Status vs. step pointer ─────────────────────────────────────────────
 * `current_step_id` advances every step; `status` only changes at real
 * state-machine boundaries (WAITING, COMPLETED, FAILED, COMPENSATING,
 * ...). advanceCurrentStep() (run-store.ts) is the deliberately separate,
 * compare-and-set primitive for the former; transitionRun()
 * (state-machine.ts-checked) is still the only way the latter ever changes —
 * this file never bypasses transitionRun() for a status change.
 *
 * ── §24/§11: waiting and step-retry backoff share one mechanism ───────────
 * Both are "park the run, let a scheduler job wake it later" — the exact
 * WAITING/next_resume_at/scheduler-wakeup path §24 describes. A step
 * retry backoff is not a second, separate parking mechanism: it reuses
 * parkForWait() with `current_step_id` left pointing at the SAME step
 * (its freshly-inserted retry-attempt row), whereas an explicit
 * WaitForResume from a handler reuses it with `current_step_id` advanced
 * to that step's `onSuccess`. See parkForWait()'s own doc comment.
 */
import { getRun, getStepRuns, transitionRun, transitionStepRun, insertStepRetry, advanceCurrentStep, getPendingStepRun, DefinitionNotFoundError, updateCompensationState, claimRunExecution, heartbeatRunExecution, releaseRunExecution } from "./run-store";
import { getDefinition } from "./definition-store";
import { getAllVariables, setVariable, recordCheckpoint } from "./context";
import { evaluateCondition } from "./conditions";
import { dispatchAction, WaitForResume, WorkflowActionDeniedError, WorkflowActionError, WorkflowStepTimeoutError, UnknownActionTypeError } from "./actions";
import { authorizeWorkflowAction } from "./authorization";
import { runCompensation } from "./compensation";
import { scheduleWorkflowResume, scheduleWorkflowCompensation } from "./scheduler-integration";
import { nextAttemptDelayMs } from "../scheduler";
import { UnsafeVariableKeyError } from "./context";
import { logger } from "../logger";
import crypto from "crypto";
import { recordStepDuration } from "./metrics";
import type { WorkflowActionContext } from "./actions";
import type { WorkflowAuthorizingEngine, WorkflowSubjectResolver } from "./authorization";
import type { WorkflowDefinition, WorkflowRun, WorkflowStepDefinition } from "./types";
import type { RunStepOutcome } from "./engine-types";

const EXECUTION_OWNER = `workflow-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * §22 — what a run needs in order for `WorkflowActionContext.authorize`
 * to actually work. Both optional: a run whose action handlers never
 * call `ctx.authorize()` needs neither; one that does and wasn't given
 * them gets a clear configuration error at that call site (fail-closed —
 * see authorization.ts's own header) rather than silently skipping the
 * PEP call.
 */
export interface WorkflowRuntimeEnv {
  policyEngine?: WorkflowAuthorizingEngine;
  resolveSubject?: WorkflowSubjectResolver;
}

type StepOutcome =
  | { kind: "ok"; output?: Record<string, unknown> }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "waiting"; resumeAt: Date; reason?: string };

function classifyStepError(err: unknown): { message: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof WorkflowActionError) return { message, retryable: err.retryable };
  if (err instanceof UnknownActionTypeError || err instanceof WorkflowActionDeniedError) {
    return { message, retryable: false };
  }
  // Ordinary handler failures are assumed transient. Domain handlers can
  // opt out explicitly with WorkflowActionError({ retryable: false }).
  return { message, retryable: true };
}

/**
 * Runs ONE step-attempt: finds its already-inserted PENDING row (the
 * loop invariant — see file header), transitions it RUNNING, builds its
 * WorkflowActionContext (including the `authorize` closure — §22), and
 * dispatches via actions.ts. Does NOT itself decide retry/onFailure/
 * compensation routing — that is the main loop's/compensation.ts's job;
 * this is the shared primitive both call (engine-types.ts's RunStepFn is
 * this function's own type, extracted so compensation.ts can accept it
 * without importing this file — see that file's header).
 *
 * Deliberately lets a thrown WaitForResume propagate uncaught (does not
 * convert it into `{ ok: false }`) — the main loop's runStepSafely()
 * below is what distinguishes it from a real failure. A caller that
 * doesn't specifically catch WaitForResume (compensation.ts's use of
 * this same function) will see it as an ordinary thrown error, which is
 * the correct, documented behavior there too (§25: a compensation step
 * cannot itself pause — see compensation.ts's header for what happens if
 * one tries).
 */
export async function runStep(run: WorkflowRun, step: WorkflowStepDefinition, attempt: number, env: WorkflowRuntimeEnv): Promise<RunStepOutcome> {
  const stepRun = await getPendingStepRun(run.id, step.id);
  if (!stepRun || stepRun.attempt !== attempt) {
    throw new Error(`runStep: no PENDING step-run row for ${run.id}:${step.id}:${attempt} — see this file's "Loop invariant" header`);
  }

  await transitionStepRun(stepRun.id, "RUNNING", { startedAt: new Date() });

  const variables = await getAllVariables(run.id);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ctx: WorkflowActionContext = {
    run,
    step,
    stepRun,
    input: step.input,
    variables,
    context: run.context,
    idempotencyKey: stepRun.idempotencyKey,
    signal: controller.signal,
    authorize: async (action, resource) => {
      if (!env.policyEngine || !env.resolveSubject) {
        throw new Error(
          `Workflow step "${step.id}" called ctx.authorize() but this run was started without a policyEngine/resolveSubject — see engine.ts's WorkflowRuntimeEnv`,
        );
      }
      const decision = await authorizeWorkflowAction({ engine: env.policyEngine, resolveSubject: env.resolveSubject, run, action, resource });
      if (decision.effect !== "ALLOW") throw new WorkflowActionDeniedError(decision);
      return decision;
    },
  };

  let output: Record<string, unknown> | undefined;
  // Part G1 — §39's `step_duration`: wraps only dispatchAction() itself,
  // not the condition evaluation or step-run row transitions around it
  // (see WorkflowMetricsSnapshot.stepDurationMs's own doc comment).
  const actionStartedAt = Date.now();
  try {
    const action = dispatchAction(step.type, ctx);
    const timed = step.timeoutMs && step.timeoutMs > 0
      ? new Promise<Record<string, unknown> | void>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new WorkflowStepTimeoutError(step.timeoutMs!));
          }, step.timeoutMs);
        })
      : undefined;
    output = (await (timed ? Promise.race([action, timed]) : action)) ?? undefined;
  } catch (err) {
    if (err instanceof WaitForResume) throw err; // waiting, not settled — no duration sample (see this function's own doc comment)
    recordStepDuration(Date.now() - actionStartedAt);
    const failure = classifyStepError(err);
    await transitionStepRun(stepRun.id, "FAILED", { error: failure.message, finishedAt: new Date() });
    return { ok: false, error: failure.message, retryable: failure.retryable };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  recordStepDuration(Date.now() - actionStartedAt);

  await transitionStepRun(stepRun.id, "COMPLETED", { output, finishedAt: new Date() });

  if (output) {
    try {
      // §18/§19 — this step's output becomes a run variable, keyed by
      // step id, the same "safe variables/step outputs" workflow_variable
      // slot context.ts already exists to hold.
      await setVariable(run.id, step.id, output);
    } catch (err) {
      if (err instanceof UnsafeVariableKeyError) {
        // §19's denylist fired on THIS step's own id — extremely unlikely
        // (a step would have to be named e.g. "password") but not a
        // reason to fail an otherwise-successful step; the output simply
        // isn't carried forward as a variable.
        logger.warn({ runId: run.id, stepId: step.id, err: err.message }, "Workflow step output not persisted as a variable — step id matches §19's secret-key denylist");
      } else {
        throw err;
      }
    }
  }

  return { ok: true, output: output ?? undefined };
}

async function runStepSafely(run: WorkflowRun, step: WorkflowStepDefinition, attempt: number, env: WorkflowRuntimeEnv): Promise<StepOutcome> {
  try {
    const result = await runStep(run, step, attempt, env);
    return result.ok ? { kind: "ok", output: result.output } : { kind: "failed", error: result.error ?? "unknown error", retryable: result.retryable !== false };
  } catch (err) {
    if (err instanceof WaitForResume) return { kind: "waiting", resumeAt: err.resumeAt, reason: err.reason };
    throw err; // anything else escaping runStep() is a bug in runStep() itself, which is supposed to convert every non-wait failure into `{ ok: false }` — surface it rather than silently swallow.
  }
}

/** §20 — the flat data object a step's `condition` is evaluated against. `context`/`variables` kept as separate namespaces (rather than merged flat) so a run's own userId/organizationId/etc. can never collide with a same-named step-output variable. */
function buildConditionData(run: WorkflowRun, variables: Record<string, unknown>): Record<string, unknown> {
  return { context: run.context as unknown as Record<string, unknown>, variables };
}

/** Moves `current_step_id` to `nextStepId` (or clears it) and, when there IS a next step, inserts its fresh attempt-1 PENDING row first — restoring the loop invariant before the pointer moves. `undefined` means "nothing next" (the run is about to complete). */
async function advanceOrComplete(run: WorkflowRun, definition: WorkflowDefinition, nextStepId: string | undefined): Promise<void> {
  if (nextStepId) {
    const nextStep = definition.steps.find((s) => s.id === nextStepId);
    await insertStepRetry(run.id, nextStepId, 1, nextStep?.input);
  }
  await advanceCurrentStep(run.id, nextStepId ?? null, undefined, "RUNNING");
  await recordCheckpoint(run.id, { currentStepId: nextStepId ?? null }, nextStepId);
}

/**
 * §24 (+ §11 for the retry-backoff reuse — see file header). Parks the
 * run: moves `current_step_id` to whatever should be current on resume
 * (the caller is responsible for that row already being PENDING — see
 * this function's two call sites below, each of which satisfies that
 * differently), transitions the run to WAITING with `next_resume_at`,
 * records a checkpoint, and schedules the scheduler-side wakeup job. The
 * worker is released the moment this returns — the caller's loop stops
 * (returns) right after, same as §24's own diagram.
 */
async function parkForWait(run: WorkflowRun, resumeAt: Date, currentStepId: string | undefined, reason: string | undefined): Promise<void> {
  await advanceCurrentStep(run.id, currentStepId ?? null, undefined, "RUNNING");
  await transitionRun(run.id, "WAITING", { nextResumeAt: resumeAt });
  await recordCheckpoint(run.id, { waiting: true, resumeAt: resumeAt.toISOString(), reason: reason ?? null }, currentStepId);
  await scheduleWorkflowResume(run.id, resumeAt);
}

/**
 * J1 — run-level `maxRuntimeMs` enforcement
 * (`workflow_run.max_runtime_ms`, copied from `workflow_definition.max_runtime_ms`
 * at `startRun()` time) and deterministic transition to TIMED_OUT. Step-level
 * `timeoutMs` is enforced by `runStep()` with an AbortSignal.
 *
 * A no-op (`false`) whenever `maxRuntimeMs` isn't set (most runs — it's
 * an optional field on both the definition and the run) or `startedAt`
 * isn't set yet (a run that hasn't left PENDING has no clock running
 * against it). Otherwise compares wall-clock elapsed since `startedAt`
 * against the budget and, if exceeded, transitions straight to the
 * state machine's existing `TIMED_OUT` terminal status (already legal
 * from both `RUNNING` and `WAITING` — see state-machine.ts's
 * `RUN_TRANSITIONS`, unchanged by this phase) and reports `true` so the
 * caller stops driving the run any further. Deliberately does NOT
 * distinguish "timed out while actively running a step" from "timed out
 * while WAITING between steps" — §17's own status list has one
 * `TIMED_OUT`, not two, and `lastError` below records which case it was
 * for an operator's benefit without the state machine itself needing a
 * finer-grained status.
 *
 * `transitionRun()`'s own G1 logic already records `workflow_duration`
 * for any terminal status reached (not just COMPLETED — see that
 * function's own comment), so a `TIMED_OUT` run's duration is captured
 * for free; G2's reverse-publishing deliberately does NOT fire a
 * `workflow.failed`/`.completed` bus event for `TIMED_OUT` (see that
 * phase's own CHANGES doc — "TIMED_OUT specifically is NOT in this
 * phase's three... not a missing case"), so this function doesn't
 * publish one either — `recordRunTransition()` (metrics.ts, Part E1)
 * already counts it as an in-process counter, consistent with that
 * earlier, deliberate scoping decision rather than reopening it here.
 */
async function checkRunTimeout(run: WorkflowRun): Promise<boolean> {
  if (!run.maxRuntimeMs || !run.startedAt) return false;
  const elapsedMs = Date.now() - run.startedAt.getTime();
  if (elapsedMs < run.maxRuntimeMs) return false;

  await transitionRun(run.id, "TIMED_OUT", {
    lastError: `run exceeded maxRuntimeMs (${run.maxRuntimeMs}ms budget, ${elapsedMs}ms elapsed) at step "${run.currentStepId ?? "(none)"}"`,
    completedAt: new Date(),
  });
  return true;
}

async function anyCompensableCompletedStep(runId: string, definition: WorkflowDefinition): Promise<boolean> {
  const stepRuns = await getStepRuns(runId);
  const stepById = new Map(definition.steps.map((s) => [s.id, s]));
  return stepRuns.some((s) => s.status === "COMPLETED" && Boolean(stepById.get(s.stepId)?.compensation));
}

/**
 * §25 — a step's own FAILED terminal outcome (attempts exhausted, no
 * `onFailure` branch). If nothing completed so far in this run declared
 * a `compensation` step, there is nothing to unwind — the run just FAILS
 * (§25: "do not pretend every action is reversible"). Otherwise the run
 * moves through COMPENSATING (state-machine.ts) while compensation.ts
 * walks backward; COMPENSATED on success, DEAD_LETTER if the
 * compensation itself fails (or throws — e.g. a compensation step
 * attempting its own WaitForResume, which compensation.ts's RunStepFn
 * usage does not support, see that file's header).
 */
async function failOrCompensate(run: WorkflowRun, definition: WorkflowDefinition, env: WorkflowRuntimeEnv, lastError: string): Promise<void> {
  const compensable = await anyCompensableCompletedStep(run.id, definition);
  if (!compensable) {
    await transitionRun(run.id, "FAILED", { lastError });
    return;
  }

  await transitionRun(run.id, "COMPENSATING", { lastError });
  await scheduleWorkflowCompensation(run.id, 0, run.traceId, 0);
  await resumeCompensation(run.id, definition, env);
}

export async function resumeCompensation(runId: string, definition?: WorkflowDefinition, env: WorkflowRuntimeEnv = {}): Promise<void> {
  const current = await getRun(runId);
  if (!current || current.status !== "COMPENSATING") return;
  if (!(await claimRunExecution(runId, EXECUTION_OWNER))) return;
  try {
    await resumeCompensationWithLease(runId, definition, env);
  } finally {
    await releaseRunExecution(runId, EXECUTION_OWNER);
  }
}

async function resumeCompensationWithLease(runId: string, definition: WorkflowDefinition | undefined, env: WorkflowRuntimeEnv): Promise<void> {
  const current = await getRun(runId);
  if (!current || current.status !== "COMPENSATING") return;
  const resolvedDefinition = definition ?? await getDefinition(current.definitionId, current.definitionVersion);
  if (!resolvedDefinition) throw new DefinitionNotFoundError(current.definitionId, current.definitionVersion);
  const attempts = current.compensationAttempts + 1;
  if (attempts > current.maxCompensationAttempts) {
    await transitionRun(runId, "DEAD_LETTER", { lastError: `maximum compensation attempts (${current.maxCompensationAttempts}) exceeded` });
    return;
  }
  await updateCompensationState(runId, {
    completedStepIds: ((current.compensationState as { completedStepIds?: string[] } | undefined)?.completedStepIds ?? []),
    attempts,
  });
  const attempted = (await getRun(runId))!;
  try {
    const result = await runCompensation(attempted, resolvedDefinition, (r, s, a) => runStep(r, s, a, env));
    if (result.ok) {
      await transitionRun(runId, "COMPENSATED");
    } else if (attempts < attempted.maxCompensationAttempts) {
      await updateCompensationState(runId, {
        completedStepIds: ((attempted.compensationState as { completedStepIds?: string[] } | undefined)?.completedStepIds ?? []),
        attempts,
        lastError: `compensation failed at step "${result.failedAt}": ${result.error}`,
      }, `compensation failed at step "${result.failedAt}": ${result.error}`);
      await scheduleWorkflowCompensation(runId, nextAttemptDelayMs(attempts), attempted.traceId, attempts);
    } else {
      await transitionRun(runId, "DEAD_LETTER", { lastError: `compensation failed at step "${result.failedAt}": ${result.error}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempts < attempted.maxCompensationAttempts) {
      await updateCompensationState(runId, {
        completedStepIds: ((attempted.compensationState as { completedStepIds?: string[] } | undefined)?.completedStepIds ?? []),
        attempts,
        lastError: message,
      }, message);
      await scheduleWorkflowCompensation(runId, nextAttemptDelayMs(attempts), attempted.traceId, attempts);
    } else {
      await transitionRun(runId, "DEAD_LETTER", { lastError: message });
    }
  }
}

/**
 * The execution loop. Safe to call repeatedly / from multiple triggers
 * for the same run (startRun()'s caller, a scheduler resume, a manual
 * retry endpoint) — each iteration re-reads the run's current DB state
 * rather than trusting anything held in memory across calls, so a
 * redundant call on an already-WAITING or already-terminal run is a
 * harmless no-op (the very first status check below returns immediately).
 *
 * Transitions PENDING -> RUNNING itself (startRun() deliberately leaves
 * a new run in PENDING — see run-store.ts's own header); a caller that
 * wants "create and immediately run" calls startRun() then this,
 * back-to-back.
 */
export async function executeRun(runId: string, env: WorkflowRuntimeEnv = {}): Promise<void> {
  const initial = await getRun(runId);
  if (!initial) throw new Error(`executeRun: run "${runId}" not found`);
  if (!(await claimRunExecution(runId, EXECUTION_OWNER))) return;

  const heartbeat = setInterval(() => {
    heartbeatRunExecution(runId, EXECUTION_OWNER).catch((err) =>
      logger.warn({ runId, err }, "Workflow execution lease heartbeat failed"),
    );
  }, 15_000);
  try {
  if (initial.status === "PENDING") {
    await transitionRun(runId, "RUNNING", { startedAt: new Date() });
  } else if (initial.status === "WAITING") {
    await transitionRun(runId, "RUNNING", { nextResumeAt: null });
  }

  const first = await getRun(runId);
  if (!first || first.status !== "RUNNING") return; // terminal/gone — nothing to drive

  const definition = await getDefinition(first.definitionId, first.definitionVersion);
  if (!definition) throw new DefinitionNotFoundError(first.definitionId, first.definitionVersion);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const run = await getRun(runId);
    if (!run || run.status !== "RUNNING") return;

    // Part H2 — checked once per loop iteration (before dispatching the
    // next step), so a run that's been RUNNING through many steps
    // without ever hitting WAITING is still caught, not just one
    // resumed from a scheduler wakeup (see resumeRun()'s own H2 check
    // for the WAITING-side half of this same enforcement).
    if (await checkRunTimeout(run)) return;

    if (!run.currentStepId) {
      await transitionRun(runId, "COMPLETED", { completedAt: new Date() });
      return;
    }

    const step = definition.steps.find((s) => s.id === run.currentStepId);
    if (!step) {
      await transitionRun(runId, "FAILED", { lastError: `run references unknown step "${run.currentStepId}"` });
      return;
    }

    const pending = await getPendingStepRun(runId, step.id);
    if (!pending) {
      // Loop invariant violated — should be unreachable given every
      // writer of current_step_id in this file inserts the row first.
      // Fail the run observably rather than looping forever.
      await transitionRun(runId, "FAILED", { lastError: `no pending step-run for step "${step.id}" — workflow engine invariant violation` });
      return;
    }

    // §20 — condition gate.
    if (step.condition) {
      const data = buildConditionData(run, await getAllVariables(runId));
      if (!evaluateCondition(step.condition, data)) {
        await transitionStepRun(pending.id, "SKIPPED", { finishedAt: new Date() });
        await advanceOrComplete(run, definition, step.onSuccess);
        continue;
      }
    }

    const outcome = await runStepSafely(run, step, pending.attempt, env);

    // Part I1 (§65 "H: Production hardening" follow-on, tracked as its
    // own phase since it's a materially different problem from H1-H3 —
    // see this phase's CHANGES doc) — mid-step cancellation. There is
    // still no cooperative cancellation in this action-dispatch model
    // (H2's own header names this same limitation for step-level
    // `timeoutMs`), so an admin's `cancelRun()` call can never actually
    // interrupt the `dispatchAction()` call `runStepSafely()` above was
    // just awaiting — that part is unchanged and not attempted here.
    // What WAS actually broken: every write this loop makes once a
    // step's outcome comes back — `advanceOrComplete()`'s
    // `advanceCurrentStep()` (an unguarded write that would silently
    // keep moving `current_step_id` forward on an already-CANCELLED
    // row), `parkForWait()`'s WAITING transition, `failOrCompensate()`'s
    // FAILED/COMPENSATING transition — assumed the run was still in the
    // same RUNNING status this iteration's own top-of-loop check saw.
    // An admin cancelling the run WHILE that step's action was in
    // flight breaks that assumption: `transitionRun()`'s own
    // `assertRunTransition()` (state-machine.ts) would correctly see
    // the row is now CANCELLED — a terminal status with no legal
    // outgoing transitions — and throw `IllegalTransitionError`,
    // UNCAUGHT, out of whatever called `executeRun()`/`resumeRun()` (an
    // HTTP handler, or `worker.ts`'s dispatch of a `workflow.resume`
    // job, which would then retry/dead-letter a run that was cancelled
    // on purpose, not one that failed). Re-reading live status here,
    // once, right after the step settles, closes both the silent-
    // clobber path and the throw-crash path at their one common choke
    // point, rather than patching each of the three call sites below
    // separately. The step ITSELF already durably recorded its own
    // COMPLETED/FAILED outcome inside `runStep()`'s own
    // `transitionStepRun()` calls regardless (§18 durability — a step
    // doesn't get retroactively un-run); this check only stops the
    // RUN's own bookkeeping from advancing past the point it was
    // cancelled at.
    const liveRun = await getRun(runId);
    if (!liveRun || liveRun.status !== "RUNNING") {
      logger.info(
        { runId, stepId: step.id, outcome: outcome.kind, runStatus: liveRun?.status ?? "(gone)" },
        "Workflow run left RUNNING while its current step was in flight — discarding this step's outcome-driven transition (Part I1 mid-step cancellation)",
      );
      return;
    }

    if (outcome.kind === "waiting") {
      // §24 — explicit pause. The step that requested it already
      // COMPLETED inside runStep() (it did its job: asking to wait) —
      // what's next is whatever this step's own onSuccess names, ready
      // to run the moment the scheduler wakes this run back up.
      if (step.onSuccess) {
        const nextStep = definition.steps.find((s) => s.id === step.onSuccess);
        await insertStepRetry(runId, step.onSuccess, 1, nextStep?.input);
      }
      await parkForWait(run, outcome.resumeAt, step.onSuccess, outcome.reason);
      return;
    }

    if (outcome.kind === "ok") {
      await advanceOrComplete(run, definition, step.onSuccess);
      continue;
    }

    // outcome.kind === "failed"
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    if (outcome.retryable && pending.attempt < maxAttempts) {
      const backoffMs = step.retry?.backoffMs ?? nextAttemptDelayMs(pending.attempt);
      await insertStepRetry(runId, step.id, pending.attempt + 1, step.input);
      await parkForWait(run, new Date(Date.now() + Math.max(0, backoffMs)), step.id, "step retry backoff");
      return;
    }

    if (step.onFailure) {
      await advanceOrComplete(run, definition, step.onFailure);
      continue;
    }

    await failOrCompensate(run, definition, env, outcome.error);
    return;
  }
  } finally {
    clearInterval(heartbeat);
    await releaseRunExecution(runId, EXECUTION_OWNER);
  }
}

/**
 * §24's scheduler-wakeup entry point — what "workflow.resume"
 * (scheduler-integration.ts's registered job handler) calls. Transitions
 * WAITING -> RUNNING (state-machine.ts) and hands off to executeRun()
 * for the rest of the loop; a run that isn't actually WAITING (already
 * resumed by a redelivered/duplicate wakeup — the scheduler's own
 * lease/claim model, §30, mostly prevents this, but a job handler must
 * still be safe to invoke twice per §34's JobHandler contract) is a
 * harmless no-op.
 */
export async function resumeRun(runId: string, env: WorkflowRuntimeEnv = {}): Promise<void> {
  const run = await getRun(runId);
  if (!run || run.status !== "WAITING") return;

  // Part H2 — checked BEFORE the WAITING -> RUNNING transition below,
  // so a run whose scheduled wakeup arrives after its own maxRuntimeMs
  // budget has already elapsed (e.g. a long WAITING backoff/delay, or a
  // scheduler that fell behind) times out directly from WAITING (a
  // state-machine-legal transition on its own — see state-machine.ts's
  // RUN_TRANSITIONS) rather than briefly entering RUNNING first only to
  // be cut off by the main loop's own H2 check a moment later.
  if (await checkRunTimeout(run)) return;

  // executeRun owns the WAITING -> RUNNING transition after it wins the
  // durable lease. This closes the race where two wakeups both transition
  // the run before either execution loop can claim it.
  await executeRun(runId, env);
}
