/**
 * lib/workflow/engine-types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2. `RunStepFn` is engine.ts's
 * runStep() primitive's own type, pulled out into its own file so
 * compensation.ts can accept one as a parameter (dependency injection —
 * see compensation.ts's header) without importing engine.ts and creating
 * engine.ts -> compensation.ts -> engine.ts cycle.
 */
import type { WorkflowRun, WorkflowStepDefinition } from "./types";

export interface CompensationState {
  completedStepIds: string[];
  attempts: number;
  lastError?: string;
}

export interface RunStepOutcome {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
}

/** Runs ONE step-attempt to completion (dispatches its action, does not itself handle retry/onFailure/compensation routing — see engine.ts's runStep() for what those layers add on top of this same primitive). */
export type RunStepFn = (run: WorkflowRun, step: WorkflowStepDefinition, attempt: number) => Promise<RunStepOutcome>;
