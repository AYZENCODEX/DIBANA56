/**
 * lib/workflow/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core
 * (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md §15-19 Workflow
 * Engine/Definition/State Machine/Durable State/Context, §26 Workflow
 * Idempotency). Types only — see event-bus/types.ts's and scheduler/
 * types.ts's headers for why that separation matters here too.
 *
 * Part C2 update: §20's WorkflowCondition (./conditions.ts) is now a real
 * type, and WorkflowStepDefinition.condition below references it —
 * everything else in this file is unchanged from C1. §21's action
 * registry handler signature and §25's compensation bookkeeping live in
 * ./actions.ts and ./compensation.ts respectively, not here, same
 * "types.ts stays pure data shapes" split C1 already established.
 */

import type { WorkflowCondition } from "./conditions";
import type { LatencySnapshot } from "../latency-histogram";

/** §17 — the full run lifecycle. See state-machine.ts for which transitions are legal. */
export type WorkflowRunStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "COMPENSATING"
  | "COMPENSATED"
  | "DEAD_LETTER";

/** Per-step-attempt lifecycle — §18/§26. Narrower than the run's own status: a step never WAITs (only the run does, between steps — §24) and never goes PENDING again once it has, so SKIPPED/COMPENSATING/COMPENSATED cover the failure-path cases §25 asks for. */
export type WorkflowStepRunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "COMPENSATING"
  | "COMPENSATED";

/** §23 — the five supported trigger kinds. Only the *shape* of a trigger is defined here; actually firing one (subscribing to an event, registering a schedule, exposing the API route, evaluating a manual-trigger permission) is Part D "Event Bus ↔ Workflow" / "Workflow ↔ Scheduler" integration wiring, not C1's job. */
export type WorkflowTrigger =
  | { kind: "event"; eventType: string }
  | { kind: "api" }
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "delayed"; afterMs: number; relativeToEventType?: string }
  | { kind: "manual" };

/** §21 — a step's retry shape. Enforcing it (counting attempts, computing backoff, deciding dead-letter) is Part C2's execution-loop job, same split as scheduler/retry.ts vs. worker.ts; this is just the declarative policy a definition can attach to a step. */
export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
}

/**
 * §16 — one step in a definition. `condition`/`onSuccess`/`onFailure`/
 * `compensation` all reference OTHER step ids by string — C1 validates
 * those references exist (definition-store.ts's validateDefinition()) but
 * does not evaluate conditions or invoke actions/compensation; that's
 * §20/§21/§25's job (Part C2). `type` is an action-registry key (§21's
 * SEND_NOTIFICATION/CREATE_TASK/... list) — opaque to C1, meaningful only
 * once C2's action registry exists to look it up.
 */
export interface WorkflowStepDefinition {
  id: string;
  type: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: RetryPolicy;
  onSuccess?: string;
  onFailure?: string;
  compensation?: string;
  /**
   * §20 (Part C2) — evaluated by engine.ts before dispatching this step's
   * action. `false` transitions this step-run PENDING -> SKIPPED (the
   * exact transition state-machine.ts's STEP_TRANSITIONS already reserved
   * for this since C1) and the run proceeds via `onSuccess` (or falls
   * through, same as a normal success) without ever invoking an action
   * handler. Omit for an unconditional step (C1's only behavior, still
   * the default).
   */
  condition?: WorkflowCondition;
}

/** §16 — a versioned workflow definition. `id`+`version` together identify one row (workflow_definition's UNIQUE(workflow_id, version)); `id` alone identifies the workflow across its version history. */
export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStepDefinition[];
  maxRuntimeMs?: number;
  metadata?: Record<string, unknown>;
}

/** ACTIVE | DEPRECATED — see migration 113's header. */
export type WorkflowDefinitionStatus = "ACTIVE" | "DEPRECATED";

/**
 * §19 — the *safe* context a run carries for its whole lifetime. Deliberately
 * narrow: this is the identity/trigger data a run is started with, not its
 * mutable working state (step outputs/variables live in workflow_variable —
 * see context.ts's getVariable()/setVariable(), kept as a separate table
 * precisely so this type can stay small and auditable for the "never persist
 * raw secrets" rule §19 states). `input` is caller-supplied trigger payload;
 * validate/sanitize it same as any other untrusted input before trusting it
 * inside a step.
 */
export interface WorkflowContext {
  userId?: number;
  organizationId?: number;
  resourceId?: string;
  correlationId?: string;
  input?: Record<string, unknown>;
}

/** §17/§18 — a run, as the engine hands it around. Mirrors the workflow_run row but with Date objects instead of ISO strings, same ScheduledJob/rowToJob convention scheduler/job-store.ts uses. */
export interface WorkflowRun {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: WorkflowRunStatus;
  currentStepId?: string;
  context: WorkflowContext;
  traceId?: string;
  correlationId?: string;
  causationId?: string;
  maxRuntimeMs?: number;
  lastError?: string;
  startedAt?: Date;
  completedAt?: Date;
  nextResumeAt?: Date;
  compensationState?: Record<string, unknown>;
  compensationAttempts: number;
  maxCompensationAttempts: number;
  executionOwner?: string;
  executionLeaseUntil?: Date;
  executionVersion: number;
  createdAt: Date;
}

/** §18/§26 — one step-attempt row, as the engine hands it around. */
export interface WorkflowStepRun {
  id: number;
  runId: string;
  stepId: string;
  attempt: number;
  status: WorkflowStepRunStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
}

/** run-store.ts's startRun() params. `definitionVersion` pins to a specific version; omit it to resolve the newest ACTIVE version for `definitionId` at start time (see definition-store.ts's getActiveDefinition()). */
export interface StartWorkflowRunParams {
  definitionId: string;
  definitionVersion?: number;
  context?: WorkflowContext;
  traceId?: string;
  correlationId?: string;
  causationId?: string;
}

/** §26 — `${runId}:${stepId}:${attempt}`, the default idempotency key every step-run row gets unless a step's own definition supplies a coarser one (see types.ts's WorkflowStepDefinition — not yet consumed anywhere in C1, since nothing dispatches actions yet). */
export function buildIdempotencyKey(runId: string, stepId: string, attempt: number): string {
  return `${runId}:${stepId}:${attempt}`;
}

/**
 * Part E1 (§39 Observability) — metrics.ts's own in-process snapshot
 * shape. Only the four run-lifecycle counters §39 actually lists
 * (`workflow.started`/`.completed`/`.failed`/`.timed_out`) — same
 * "start simple, only what's specified" posture scheduler/metrics.ts's
 * SchedulerMetricsSnapshot follows; CANCELLED/COMPENSATED/DEAD_LETTER
 * aren't in §39's list and so aren't counted here either.
 */
export interface WorkflowMetricsSnapshot {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsTimedOut: number;
  runsCancelled: number;
  /** §39 Latency metrics, Part G1 — total wall-clock duration of a run,
   *  `startedAt` to the moment it reaches ANY terminal status (not just
   *  COMPLETED — a FAILED/CANCELLED/etc. run still took real time and is
   *  just as useful a duration sample; see run-store.ts's own recording
   *  site, gated on `isTerminalRunStatus()`, not on which terminal status
   *  specifically). `null`-averaged (via LatencySnapshot.avgMs) until at
   *  least one run has actually finished. */
  runDurationMs: LatencySnapshot;
  /** §39 Latency metrics, Part G1 — duration of one step's
   *  `dispatchAction()` call (engine.ts's runStep()), recorded whether the
   *  step succeeded or failed — independent of outcome, same reasoning as
   *  EventBusMetricsSnapshot.handlerLatencyMs. Does NOT include a step's
   *  own condition evaluation (§20, cheap/synchronous) or the surrounding
   *  step-run row transitions — only the action handler's own execution
   *  time, the part a domain module's handler code actually controls. */
  stepDurationMs: LatencySnapshot;
}
