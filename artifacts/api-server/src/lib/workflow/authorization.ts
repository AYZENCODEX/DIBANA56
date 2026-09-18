/**
 * lib/workflow/authorization.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2: Workflow execution logic
 * (§22 Policy Engine Integration). Builds the one capability
 * actions.ts's `WorkflowActionContext.authorize` exposes to a handler —
 * see that file's header for the split ("this engine does not decide
 * which actions need authorization; it makes the PEP call available and
 * correct when a handler decides it does").
 *
 * ── Why not lib/policy/pep/authorize.ts's own `authorize()` ───────────────
 * That function (Phase 19) is built around an Express `Request` —
 * `req.user`, `policyContextFromRequest(req)`. A workflow run has no
 * `Request` by the time it executes: it may be resuming hours or days
 * after the HTTP request that triggered it ever completed (§22's own
 * "delayed workflows" case), quite possibly on a different worker
 * process entirely. This file is the non-Express equivalent of that same
 * `authorize()` shape — same `AuthorizingEngine.evaluate()` call
 * underneath (pep/types.ts's own structural interface, reused here
 * unmodified), same Decision/Subject/PolicyContext types, just built from
 * a WorkflowRun's durable, safe context instead of a live `req`.
 *
 * ── "User was admin yesterday -> workflow executes today -> still gets
 *    admin access" (§22's own failure case) ────────────────────────────────
 * workflow_run.context (types.ts's WorkflowContext) deliberately carries
 * only `userId` — never a role, never a cached Subject (see types.ts's
 * own doc comment on WorkflowContext, and context.ts's UNSAFE_KEY_PATTERN
 * denylist for the analogous variable-side rule). authorizeWorkflowAction()
 * below is the one place that userId is turned into a Subject, and it is
 * done via a caller-supplied `resolveSubject` looked up FRESH on every
 * call — never memoized across steps, never carried over from a prior
 * call in the same run. A workflow resuming days later gets whatever
 * role/verification/account-state the subject holds AT THAT MOMENT,
 * exactly like a brand-new HTTP request would.
 *
 * `resolveSubject` is injected (not constructed here) so this file stays
 * as DB-free as every other lib/workflow/*.ts module save run-store.ts/
 * context.ts/definition-store.ts (which own the workflow_* tables
 * specifically) — the real implementation a caller wires in is
 * `lib/policy/pip/drizzle-subject-provider.ts`'s `DrizzleSubjectProvider`
 * composed with a fresh `users` row fetch by id (that composition is Part
 * D's job, same "not wired into anything yet" posture every PIP provider
 * in lib/policy/pip/* already has per that directory's own headers).
 */
import { createPolicyContext } from "../policy/policy-context";
import type { AuthorizationDecision, ResourceRef, Subject } from "../policy/types";
import type { WorkflowRun } from "./types";

/** Structural subset of PolicyEngine/PrecedenceEngine's own evaluate() — identical to pep/types.ts's AuthorizingEngine, re-declared here (not imported) so this file has zero dependency on the pep/ (Express-shaped) directory. Both real engines already satisfy this. */
export interface WorkflowAuthorizingEngine {
  evaluate(input: { subject: Subject | null; action: string; resource: ResourceRef; context: ReturnType<typeof createPolicyContext> }): Promise<AuthorizationDecision>;
}

/** Resolves a fresh Subject for `userId` — see this file's header for why this must never be cached/reused across calls. Returns `null` for "no longer a valid subject" (deleted/suspended account, etc.), which authorizeWorkflowAction() below evaluates as an unauthenticated request — same fail-closed default-deny the Policy Engine already gives a `null` subject for any other caller. */
export type WorkflowSubjectResolver = (userId: number) => Promise<Subject | null>;

export interface AuthorizeWorkflowActionParams {
  engine: WorkflowAuthorizingEngine;
  resolveSubject: WorkflowSubjectResolver;
  run: WorkflowRun;
  action: string;
  resource: ResourceRef;
}

/**
 * The function actions.ts's dispatchAction() wires up as
 * `WorkflowActionContext.authorize`. Builds a fresh PolicyContext (no
 * `ip`/`sessionId` — a resumed workflow has neither; risk/session-aware
 * rules simply see those as absent, same as any other non-HTTP caller of
 * the Policy Engine), resolves the Subject fresh via `resolveSubject`,
 * and evaluates through the SAME PDP a Phase 19 PEP-guarded route would.
 * `run.context.correlationId`, when present, is propagated as the
 * PolicyContext's requestId so a workflow-triggered decision's audit
 * trail (Phase 1C/17) can still be tied back to whatever originally
 * caused the run, across however many days/resumes separate the two.
 */
export async function authorizeWorkflowAction(params: AuthorizeWorkflowActionParams): Promise<AuthorizationDecision> {
  const { engine, resolveSubject, run, action, resource } = params;

  const context = createPolicyContext({ requestId: run.context.correlationId });
  const userId = run.context.userId;
  const subject = userId !== undefined ? await resolveSubject(userId) : null;

  // engine.evaluate() (policy-engine.ts's PolicyEngine/PrecedenceEngine)
  // already validates the built request and fails closed on anything
  // malformed (resolveRequestOrEarlyDecision(), called internally) — no
  // need to duplicate that here.
  return engine.evaluate({ subject, action, resource, context });
}
