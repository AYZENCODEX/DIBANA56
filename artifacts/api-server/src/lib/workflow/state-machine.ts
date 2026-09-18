/**
 * lib/workflow/state-machine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core
 * (§17 Workflow State Machine). "Never infer workflow state solely from
 * logs" (§17's own closing line) is the reason this file exists as a
 * single choke point run-store.ts's every status-changing write goes
 * through, rather than each caller UPDATE-ing `status` directly the way a
 * less disciplined engine might: every legal transition is enumerated
 * here, once, so a future caller can't silently introduce an illegal one
 * (e.g. COMPLETED -> RUNNING) by writing a new UPDATE statement that
 * forgot to check first.
 */
import type { WorkflowRunStatus, WorkflowStepRunStatus } from "./types";

export class IllegalTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string, public readonly entity: "run" | "step") {
    super(`Illegal workflow ${entity} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * §17's diagram (`PENDING -> RUNNING -> WAITING -> RUNNING -> COMPLETED`)
 * plus its separately-listed failure states. Read as "from this status,
 * these are the only statuses a single transition may move to":
 *   - PENDING is the only entry point (run-store.ts's startRun()).
 *   - RUNNING can advance to WAITING (§24, between steps), finish
 *     (COMPLETED), fail terminally (FAILED/TIMED_OUT/DEAD_LETTER), begin
 *     unwinding (COMPENSATING), or be stopped (CANCELLED).
 *   - WAITING resumes to RUNNING (the scheduler wakeup, §24), or can
 *     still be cancelled/timed out while parked.
 *   - COMPENSATING resolves to COMPENSATED (§25) or, if compensation
 *     itself can't complete, DEAD_LETTER.
 *   - COMPLETED/CANCELLED/TIMED_OUT/COMPENSATED/DEAD_LETTER are terminal
 *     — no outgoing transitions. FAILED is also terminal for C1 (nothing
 *     yet auto-retries a whole run the way scheduler/worker.ts retries a
 *     job attempt; a failed RUN is a finished run, distinct from a failed
 *     STEP attempt, which the step state machine below does retry).
 */
const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["WAITING", "COMPLETED", "FAILED", "TIMED_OUT", "COMPENSATING", "CANCELLED", "DEAD_LETTER"],
  WAITING: ["RUNNING", "CANCELLED", "TIMED_OUT"],
  COMPENSATING: ["COMPENSATED", "DEAD_LETTER"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  COMPENSATED: [],
  DEAD_LETTER: [],
};

/** §18/§26 — a step attempt's own, narrower lifecycle: it never WAITs (only the run does) and, once it leaves PENDING, only ever moves forward. A retried step is a NEW row (new `attempt`, fresh PENDING) per workflow_step_run's UNIQUE(run_id, step_id, attempt) — see migration 113 — not a transition back to PENDING on the same row. */
const STEP_TRANSITIONS: Record<WorkflowStepRunStatus, readonly WorkflowStepRunStatus[]> = {
  PENDING: ["RUNNING", "SKIPPED"],
  RUNNING: ["COMPLETED", "FAILED"],
  FAILED: ["COMPENSATING"],
  COMPENSATING: ["COMPENSATED"],
  COMPLETED: [],
  SKIPPED: [],
  COMPENSATED: [],
};

/** Throws IllegalTransitionError if `from -> to` isn't a legal run transition; returns `to` on success (so a caller can write `.set({ status: assertRunTransition(current, next) })` inline). */
export function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): WorkflowRunStatus {
  if (!RUN_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to, "run");
  return to;
}

export function assertStepTransition(from: WorkflowStepRunStatus, to: WorkflowStepRunStatus): WorkflowStepRunStatus {
  if (!STEP_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to, "step");
  return to;
}

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function isTerminalStepStatus(status: WorkflowStepRunStatus): boolean {
  return STEP_TRANSITIONS[status].length === 0;
}
