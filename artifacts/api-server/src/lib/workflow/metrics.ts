/**
 * lib/workflow/metrics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part E1 (§39 Observability's
 * `workflow.*` counters, feeding §61's Engine Health Model). Same
 * "in-process counters, no Prometheus/StatsD wiring" V1 posture
 * event-bus/metrics.ts and scheduler/metrics.ts already document for
 * themselves — read by lib/mega-engine/engine-health.ts, not by
 * run-store.ts's own callers.
 *
 * Reset on process restart; workflow_run's own `status` column (plus
 * workflow_step_run's per-attempt rows) remains the durable record of
 * what actually happened to any one run — same split the other two
 * metrics modules draw against their own tables.
 *
 * recordRunTransition() takes the target status and bumps the matching
 * §39 counter itself, so run-store.ts's transitionRun() (the one place
 * every run-status change already funnels through, per its own §17
 * assertRunTransition() guard) only has to make one call per transition
 * rather than every call site picking the right counter by hand.
 *
 * Extended in Part G1 (§39's own "Latency metrics" list) with
 * `runDurationMs`/`stepDurationMs` — see
 * CHANGES_MEGA_ENGINE_LATENCY_PHASE_G1.md for the full phase writeup.
 */
import { createLatencyHistogram } from "../latency-histogram";
import type { WorkflowMetricsSnapshot, WorkflowRunStatus } from "./types";

const counters = {
  runsStarted: 0,
  runsCompleted: 0,
  runsFailed: 0,
  runsTimedOut: 0,
  runsCancelled: 0,
};

// Part G1 — §39 Latency metrics (`workflow_duration`/`step_duration`).
const runDuration = createLatencyHistogram();
const stepDuration = createLatencyHistogram();

/** run-store.ts's startRun() calls this once per new run — §39's `workflow.started`. */
export function recordRunStarted(): void { counters.runsStarted++; }

/** run-store.ts's transitionRun() calls this once, only for a transition
 *  INTO a terminal status (any of the six — see state-machine.ts's
 *  isTerminalRunStatus()), with the elapsed ms since the run's own
 *  `startedAt` — §39's `workflow_duration`. Deliberately separate from
 *  recordRunTransition() below (which only fires for THREE of the ten
 *  statuses) since a duration sample is meaningful for every terminal
 *  outcome, not just the three §39 already counts by name. */
export function recordRunDuration(ms: number): void { runDuration.record(ms); }

/** engine.ts's runStep() calls this once per step-attempt, after
 *  dispatchAction() settles (success or failure) — §39's `step_duration`. */
export function recordStepDuration(ms: number): void { stepDuration.record(ms); }

/**
 * run-store.ts's transitionRun() calls this with the transition's target
 * status. Only COMPLETED/FAILED/TIMED_OUT map to a §39 counter (see
 * WorkflowMetricsSnapshot's own doc comment for why the other terminal
 * statuses are left uncounted for now); every other target status is a
 * deliberate no-op, not a missing case.
 */
export function recordRunTransition(to: WorkflowRunStatus): void {
  switch (to) {
    case "COMPLETED":
      counters.runsCompleted++;
      break;
    case "FAILED":
      counters.runsFailed++;
      break;
    case "TIMED_OUT":
      counters.runsTimedOut++;
      break;
    case "CANCELLED":
      counters.runsCancelled++;
      break;
    default:
      break;
  }
}

export function getWorkflowMetrics(): WorkflowMetricsSnapshot {
  return {
    ...counters,
    runDurationMs: runDuration.snapshot(),
    stepDurationMs: stepDuration.snapshot(),
  };
}
