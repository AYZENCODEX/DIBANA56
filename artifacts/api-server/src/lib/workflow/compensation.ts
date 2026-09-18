/**
 * lib/workflow/compensation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2: Workflow execution logic
 * (§25 Workflow Compensation).
 *
 * ── Why a compensating step is just another step, not a new concept ───────
 * A definition's `compensation` field (types.ts's WorkflowStepDefinition,
 * C1) is a STEP ID — it points at a real, fully-formed entry in the same
 * `steps[]` array, with its own `type`/`input`/`retry` like any other
 * step. Running a compensation is therefore exactly "run this other
 * already-defined step", via the same runStep() primitive engine.ts uses
 * for the forward path — this file owns only the WALK (which steps, in
 * which order), not a second execution mechanism.
 *
 * ── Why this never touches a COMPLETED step-run's own status ───────────────
 * state-machine.ts's STEP_TRANSITIONS makes COMPLETED terminal (no
 * outgoing transition) — deliberately: a step-run row is an immutable
 * historical fact ("this attempt succeeded"), not something compensation
 * un-does in place. Compensating step B's effect means EXECUTING step B's
 * own designated compensation step (a NEW step-run row, its own fresh
 * PENDING -> RUNNING -> COMPLETED/FAILED lifecycle) — B's original
 * COMPLETED row is untouched and stays exactly as accurate as it always
 * was.
 *
 * ── Order: reverse of completion, §25's own example ────────────────────────
 * "C fails -> compensate B -> compensate A" — this walks this run's
 * COMPLETED step-runs newest-first (workflow_step_run.id descending,
 * insertion order) and, for each one whose OWN step definition declares a
 * `compensation` step id, runs that compensation step. A completed step
 * with no `compensation` field is skipped outright — §25's own "do not
 * pretend every action is reversible": silence here is the correct,
 * intended behavior for an irreversible action, not a gap.
 *
 * ── Stop on first compensation failure ──────────────────────────────────
 * V1 does not retry or re-order a failed compensation attempt — a
 * compensation step still gets its own `retry` policy honored (via the
 * shared runStep() primitive), but once THAT is exhausted, this file
 * stops walking and reports failure; engine.ts moves the run straight to
 * DEAD_LETTER (state-machine.ts's COMPENSATING -> DEAD_LETTER) rather
 * than guessing whether it's still safe to keep unwinding earlier steps
 * whose own compensations might now be operating on inconsistent state.
 */
import { getStepRuns, insertStepRetry, updateCompensationState } from "./run-store";
import type { WorkflowDefinition, WorkflowRun } from "./types";
import type { CompensationState, RunStepFn } from "./engine-types";

export interface CompensationResult {
  ok: boolean;
  /** Step ids (compensation-step ids, not the original failed step's id) that ran successfully, in the order they ran. */
  compensated: string[];
  /** Set only when ok is false — the compensation step id whose own execution failed. */
  failedAt?: string;
  error?: string;
}

/**
 * Walks `run`'s completed step-runs in reverse and executes each one's
 * declared compensation step, via `runStep` (engine.ts's own step-runner,
 * passed in rather than imported to avoid a circular import between
 * engine.ts and this file — engine.ts is the only real caller).
 */
export async function runCompensation(run: WorkflowRun, definition: WorkflowDefinition, runStep: RunStepFn): Promise<CompensationResult> {
  const stepRuns = await getStepRuns(run.id);
  const completedNewestFirst = stepRuns.filter((s) => s.status === "COMPLETED").sort((a, b) => b.id - a.id);

  const stepById = new Map(definition.steps.map((s) => [s.id, s]));
  const compensated: string[] = [];
  const persisted = (run.compensationState ?? {}) as Partial<CompensationState>;
  const seen = new Set<string>(persisted.completedStepIds ?? []);
  const state: CompensationState = {
    completedStepIds: [...seen],
    attempts: run.compensationAttempts,
    lastError: persisted.lastError,
  };

  for (const stepRun of completedNewestFirst) {
    if (seen.has(stepRun.stepId)) continue;
    seen.add(stepRun.stepId);

    const originalStep = stepById.get(stepRun.stepId);
    const compensationStepId = originalStep?.compensation;
    if (!compensationStepId) continue; // §25 — not every action is reversible; skip and move on

    const compensationStep = stepById.get(compensationStepId);
    if (!compensationStep) continue; // definition-store.ts's validateDefinition() already guards against this at publish time; defensive only

    // A compensation worker can crash after the handler returns but before
    // the state checkpoint is written. Reuse a durable COMPLETED attempt,
    // otherwise create the next attempt instead of colliding with the unique
    // (run, step, attempt) key.
    const priorCompensationRuns = stepRuns.filter((s) => s.stepId === compensationStepId);
    if (priorCompensationRuns.some((s) => s.status === "COMPLETED")) {
      state.completedStepIds.push(stepRun.stepId);
      await updateCompensationState(run.id, state);
      continue;
    }

    const maxAttempts = compensationStep.retry?.maxAttempts ?? 1;
    let outcome;
    let attempt = Math.max(0, ...priorCompensationRuns.map((s) => s.attempt)) + 1;
    do {
      state.inProgressStepId = stepRun.stepId;
      state.inProgressCompensationStepId = compensationStepId;
      state.lastError = undefined;
      await updateCompensationState(run.id, state);
      await insertStepRetry(run.id, compensationStepId, attempt, compensationStep.input);
      outcome = await runStep(run, compensationStep, attempt);
      if (outcome.ok) break;
      if (outcome.retryable === false || attempt >= maxAttempts) {
        state.lastError = outcome.error;
        state.failedStepId = stepRun.stepId;
        state.retryable = outcome.retryable !== false;
        state.inProgressStepId = undefined;
        state.inProgressCompensationStepId = undefined;
        await updateCompensationState(run.id, state, state.lastError);
        return { ok: false, compensated, failedAt: compensationStepId, error: outcome.error };
      }
      attempt += 1;
    } while (true);

    compensated.push(compensationStepId);
    // Persist the ORIGINAL forward step id. On resume this is what prevents
    // the same reversible effect from being compensated twice.
    state.completedStepIds.push(stepRun.stepId);
    state.inProgressStepId = undefined;
    state.inProgressCompensationStepId = undefined;
    state.failedStepId = undefined;
    state.retryable = undefined;
    await updateCompensationState(run.id, state);
  }

  return { ok: true, compensated };
}
