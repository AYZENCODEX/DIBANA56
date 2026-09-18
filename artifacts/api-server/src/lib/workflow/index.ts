/**
 * lib/workflow/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Mega Engine — Phase 8 blueprint, Parts C1 (Workflow durable core), C2
 * (Conditions, Action registry, execution loop, Waiting/scheduler-
 * wakeup, Compensation, Policy Engine integration), D1 (Event Bus ↔
 * Workflow — §23's "event" trigger kind), D2 (Workflow ↔ Scheduler —
 * §23's "schedule"/"delayed" trigger kinds), E1 (§39 workflow.*
 * metrics, feeding §61's Engine Health Model), and F1 (§58's "replay" /
 * "cancellation" workflow test rows — run listing + replay). Barrel
 * export — domain modules should import from "../workflow" (this
 * file), not reach into individual files here, same as scheduler/
 * index.ts growing from B1 to B2 on the same file.
 */
export type {
  WorkflowRunStatus, WorkflowStepRunStatus, WorkflowTrigger, RetryPolicy,
  WorkflowStepDefinition, WorkflowDefinition, WorkflowDefinitionStatus,
  WorkflowContext, WorkflowRun, WorkflowStepRun, StartWorkflowRunParams,
  WorkflowMetricsSnapshot,
} from "./types";
export { buildIdempotencyKey } from "./types";

// Part E1 — §39 workflow.* metrics.
export { getWorkflowMetrics } from "./metrics";

export {
  InvalidDefinitionError, validateDefinition, publishDefinition,
  deprecateDefinition, getDefinition, getActiveDefinition, listDefinitionVersions,
  listActiveEventTriggeredDefinitions, listActiveScheduleTriggeredDefinitions, listActiveDelayedTriggeredDefinitions,
} from "./definition-store";

export {
  IllegalTransitionError, assertRunTransition, assertStepTransition,
  isTerminalRunStatus, isTerminalStepStatus,
} from "./state-machine";

export {
  DefinitionNotFoundError, startRun, getRun, listRuns, getStepRuns, getPendingStepRun,
  transitionRun, transitionStepRun, insertStepRetry, advanceCurrentStep, cancelRun,
  updateCompensationState, recoverExpiredRunLeases,
} from "./run-store";

export {
  UnsafeVariableKeyError, setVariable, getVariable, getAllVariables,
  recordCheckpoint, getLatestCheckpoint,
} from "./context";

// Part C2 — §20 Conditions.
export {
  InvalidConditionError, validateCondition, evaluateCondition,
} from "./conditions";
export type { WorkflowCondition } from "./conditions";

// Part C2 — §21 Action registry/dispatch.
export {
  UnknownActionTypeError, WorkflowActionDeniedError, WaitForResume,
  registerAction, isActionRegistered, listRegisteredActions, dispatchAction,
  ACTION_TYPE_EXAMPLES,
} from "./actions";
export type { WorkflowActionHandler, WorkflowActionContext } from "./actions";

// Part C2 — §22 Policy Engine integration.
export { authorizeWorkflowAction } from "./authorization";
export type {
  WorkflowAuthorizingEngine, WorkflowSubjectResolver, AuthorizeWorkflowActionParams,
} from "./authorization";

// Part C2 — §25 Compensation.
export { runCompensation } from "./compensation";
export type { CompensationResult } from "./compensation";
export type { RunStepFn, RunStepOutcome } from "./engine-types";

// Part C2 — the execution loop itself (§20/§21/§22/§24/§25 wired
// together), and §24's scheduler-side wakeup.
export { runStep, executeRun, resumeRun, resumeCompensation } from "./engine";
export type { WorkflowRuntimeEnv } from "./engine";
export { WORKFLOW_RESUME_JOB_TYPE, WORKFLOW_COMPENSATE_JOB_TYPE, scheduleWorkflowResume, scheduleWorkflowCompensation } from "./scheduler-integration";
export type { WorkflowResumeJobPayload } from "./scheduler-integration";
export { registerWorkflowResumeHandler } from "./scheduler-handler";

// Part D1 — §23 Event trigger (Event Bus ↔ Workflow).
export { registerWorkflowEventTriggers } from "./triggers";

// Part D2 — §23 Schedule + Delayed triggers (Workflow ↔ Scheduler).
export {
  WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE, WORKFLOW_DELAYED_TRIGGER_JOB_TYPE,
  registerWorkflowTriggerJobHandlers, registerWorkflowScheduleTriggers, registerWorkflowDelayedTriggers,
} from "./schedule-triggers";
export type { WorkflowTriggerJobPayload } from "./schedule-triggers";

// Part F1 — §58 "replay"/"cancellation" workflow test rows.
export { replayRun, RunNotFoundError, RunNotReplayableError } from "./replay";
