/**
 * lib/workflow/actions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2: Workflow execution logic
 * (§21 Workflow Actions, §22 Policy Engine Integration). Same in-memory,
 * self-registering shape as event-bus/event-registry.ts and
 * scheduler/job-registry.ts (see either file's header) — an action handler
 * is code, versioned with the code that defines it, not runtime-editable
 * state. A `WorkflowStepDefinition.type` (types.ts) is the registry key.
 *
 * "The workflow engine orchestrates these actions. It does not
 * reimplement them" (§21) — this file is the orchestration boundary only:
 * it dispatches to whatever handler a domain module (organizations,
 * vault, notifications, credits, ...) registers, exactly the way
 * job-registry.ts dispatches to a domain-registered job handler. No
 * handler for any of §21's own named examples (SEND_NOTIFICATION,
 * CREATE_TASK, CONSUME_CREDITS, ...) is registered by this file itself —
 * that wiring is each domain module's own call, made when that module is
 * ready to expose itself as a workflow action (Part D / business-layer
 * concern, not C2's). ACTION_TYPE_EXAMPLES below is reference vocabulary
 * only (matches §21's own list verbatim) — NOT an enforced enum; a step's
 * `type` is validated only by "does the registry have a handler for this
 * key at dispatch time" (dispatchAction() below), the same posture
 * job-registry.ts already takes for job types (see that file's
 * scheduleJob() doc comment: unregistered is a controlled failure at
 * DISPATCH time, not a publish-time rejection — a handler module's import
 * order at boot isn't guaranteed either).
 *
 * ── §22 Policy Engine Integration ──────────────────────────────────────────
 * "Workflow Step -> Domain Service -> PEP -> Policy Engine -> ALLOW/DENY"
 * (§22's own diagram) places the PEP call INSIDE the domain service, same
 * as any other business-service call reached from an HTTP route today —
 * this engine does not (and structurally cannot, since it has no
 * knowledge of which actions touch protected resources or what their
 * ResourceRef looks like) decide on a handler's behalf whether a given
 * action needs authorization. What C2 owns instead is making sure a
 * handler CAN make that PEP call correctly when it needs to:
 * `WorkflowActionContext.authorize` (below) is that capability, backed by
 * ./authorization.ts's authorizeWorkflowAction() — which always resolves
 * the acting Subject FRESH at call time (never a Subject cached from
 * trigger time), satisfying §22's "re-evaluate authorization at execution
 * time" requirement for delayed/security-sensitive actions without this
 * file needing to know which actions those are.
 */
import type { ResourceRef, AuthorizationDecision } from "../policy/types";
import type { WorkflowContext, WorkflowRun, WorkflowStepDefinition, WorkflowStepRun } from "./types";

export class UnknownActionTypeError extends Error {
  constructor(public readonly actionType: string) {
    super(`Workflow action type "${actionType}" has no registered handler — see lib/workflow/actions.ts's registerAction()`);
    this.name = "UnknownActionTypeError";
  }
}

/**
 * J7 — action handlers can classify failures without coupling the workflow
 * engine to transport- or domain-specific error classes. Fail-closed means
 * an explicitly permanent failure is never retried by the engine.
 */
export class WorkflowActionError extends Error {
  readonly retryable: boolean;
  readonly code?: string;

  constructor(message: string, opts: { retryable?: boolean; code?: string } = {}) {
    super(message);
    this.name = "WorkflowActionError";
    this.retryable = opts.retryable ?? true;
    this.code = opts.code;
  }
}

/**
 * §22 — thrown by a handler's own `ctx.authorize()` call site (handler's
 * choice, not something dispatchAction() infers) when the Policy Engine
 * returned anything other than ALLOW. engine.ts treats this exactly like
 * any other handler-thrown error for retry/onFailure/compensation
 * purposes — a denied authorization is a normal step failure, not a
 * special engine-level outcome, because "was this action allowed" is
 * exactly as much a business-logic concern as "did the downstream API
 * call succeed".
 */
export class WorkflowActionDeniedError extends Error {
  constructor(public readonly decision: AuthorizationDecision) {
    super(`Workflow action denied by policy engine: ${decision.reason}${decision.message ? ` — ${decision.message}` : ""}`);
    this.name = "WorkflowActionDeniedError";
  }
}

/**
 * §24 — a handler throws this to request the RUN be parked without
 * holding a worker, instead of completing normally. See engine.ts's
 * handling of it (the step that throws is marked COMPLETED — it did its
 * job, which was to ask to wait — and the run itself moves to WAITING
 * with `resumeAt` persisted as `next_resume_at`). `reason` is carried
 * through onto workflow_run for observability only, no behavioral
 * meaning.
 */
export class WaitForResume {
  constructor(public readonly resumeAt: Date, public readonly reason?: string) {}
}

export class WorkflowStepTimeoutError extends WorkflowActionError {
  constructor(timeoutMs: number) {
    super(`workflow step exceeded timeout of ${timeoutMs}ms`, { retryable: true, code: "STEP_TIMEOUT" });
    this.name = "WorkflowStepTimeoutError";
  }
}

/** Handed to a handler for one step-attempt's execution. Nothing here is mutable by the handler beyond returning an output/throwing — same "handler is a pure orchestration target, not given raw DB access" boundary job-registry.ts's JobHandler draws for scheduler jobs. */
export interface WorkflowActionContext {
  run: WorkflowRun;
  step: WorkflowStepDefinition;
  stepRun: WorkflowStepRun;
  /** This step's own declared `input` (types.ts), as authored on the definition — opaque to the engine, meaningful only to this action type's handler. */
  input: Record<string, unknown> | undefined;
  /** Every workflow_variable currently recorded for this run (context.ts's getAllVariables()) — the accumulated outputs of steps that already ran. */
  variables: Record<string, unknown>;
  /** §19 — this run's safe context (userId/organizationId/resourceId/correlationId/input). */
  context: WorkflowContext;
  /** `${runId}:${stepId}:${attempt}` (or this step's own coarser key, if it supplied one) — §26. Pass through to any downstream call whose own effect must not be duplicated on a redelivered/retried dispatch. */
  idempotencyKey: string;
  /** Aborted when the declared step timeout elapses. Handlers doing external
   * work should pass this signal to their client where supported. */
  signal: AbortSignal;
  /**
   * §22 — the PEP call. A handler that changes a protected resource
   * SHOULD call this before doing so and throw WorkflowActionDeniedError
   * (or let this reject — see authorization.ts) on anything but ALLOW.
   * Optional to call at all: a handler whose action is not
   * security-sensitive (e.g. a pure read, or an action already scoped by
   * construction) is not required to invoke it — same as an HTTP route
   * handler is not required to call every available PEP helper for every
   * line of business logic, only the ones that actually gate a protected
   * resource.
   */
  authorize: (action: string, resource: ResourceRef) => Promise<AuthorizationDecision>;
}

export type WorkflowActionHandler = (ctx: WorkflowActionContext) => Promise<Record<string, unknown> | void>;

interface ActionHandlerDefinition {
  actionType: string;
  handler: WorkflowActionHandler;
  owner?: string;
  description?: string;
}

const registry = new Map<string, ActionHandlerDefinition>();

/** §21's own named list, verbatim — reference vocabulary only, see this file's header. Domain modules are free to register action types outside this list; nothing here enforces membership in it. */
export const ACTION_TYPE_EXAMPLES = [
  "SEND_NOTIFICATION",
  "CREATE_TASK",
  "UPDATE_TASK",
  "CONSUME_CREDITS",
  "CREATE_PROJECT",
  "EXPORT_PROJECT",
  "REQUEST_APPROVAL",
  "PUBLISH_CONTENT",
  "SEND_TELEGRAM",
  "CREATE_VAULT_SHARE",
  "REVOKE_VAULT_SHARE",
] as const;

/** Does not throw on re-registration (hot reload/tests re-import modules) — same posture as event-registry.ts's registerEvent()/job-registry.ts's registerJobHandler(). */
export function registerAction(actionType: string, handler: WorkflowActionHandler, opts?: { owner?: string; description?: string }): void {
  registry.set(actionType, { actionType, handler, ...opts });
}

export function isActionRegistered(actionType: string): boolean {
  return registry.has(actionType);
}

export function listRegisteredActions(): ActionHandlerDefinition[] {
  return Array.from(registry.values());
}

/**
 * §21's dispatch. Throws UnknownActionTypeError immediately for an
 * unregistered type — engine.ts's caller treats this exactly like any
 * other handler throw (retry / onFailure / compensation path), so an
 * unregistered action type fails its step the same "controlled failure,
 * observable" way §34 asks scheduler job dispatch to (not a silent
 * no-op, not a crash of the whole run loop).
 */
export async function dispatchAction(actionType: string, ctx: WorkflowActionContext): Promise<Record<string, unknown> | void> {
  const def = registry.get(actionType);
  if (!def) throw new UnknownActionTypeError(actionType);
  return def.handler(ctx);
}
