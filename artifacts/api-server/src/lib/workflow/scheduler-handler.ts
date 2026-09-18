/**
 * lib/workflow/scheduler-handler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2 (§24 + §34). The other
 * half of scheduler-integration.ts: registers the actual
 * `"workflow.resume"` job handler (§34's own named
 * `workflowResumeHandler`) against the scheduler's job-registry.ts.
 *
 * Deliberately NOT self-registered at module import time, unlike every
 * other registerX() call in this codebase's event-bus/scheduler modules
 * (event-registry.ts's DEFAULT_EVENT_TYPES, etc.) — a workflow run's
 * `ctx.authorize()` capability (§22, actions.ts) needs a real
 * `WorkflowAuthorizingEngine` + `WorkflowSubjectResolver` the app has
 * already assembled (a `PolicyEngine` with its rules registered, a
 * `DrizzleSubjectProvider` composed with a fresh `users` row fetch — see
 * authorization.ts's own header), and nothing in this codebase
 * constructs those yet, same "engine, not endpoint" / "ready to be
 * wired up by a future phase" posture every `lib/policy/pip/*` provider
 * and `lib/policy/pep/*` middleware already documents about itself.
 * `registerWorkflowResumeHandler()` is that future wiring point: the
 * app's own boot code (Part D / AyzenMegaEngine.start(), §36) calls it
 * once with whatever `WorkflowRuntimeEnv` it has actually assembled.
 */
import { registerJobHandler, type ScheduledJob } from "../scheduler";
import { resumeRun, type WorkflowRuntimeEnv } from "./engine";
import { WORKFLOW_RESUME_JOB_TYPE, type WorkflowResumeJobPayload } from "./scheduler-integration";

/**
 * Call once at boot with the app's real policy engine + subject
 * resolver (or with `{}` if this deployment runs no workflow actions
 * that ever call `ctx.authorize()` — see engine.ts's WorkflowRuntimeEnv
 * doc comment for that fail-closed default). Safe to call more than
 * once (re-registration is a no-op overwrite, same posture every other
 * registerX() in this codebase already has) — a later call simply
 * replaces the env earlier-registered runs' FUTURE wakeups will use.
 */
export function registerWorkflowResumeHandler(env: WorkflowRuntimeEnv = {}): void {
  registerJobHandler<WorkflowResumeJobPayload>(
    WORKFLOW_RESUME_JOB_TYPE,
    async (job: ScheduledJob<WorkflowResumeJobPayload>) => {
      const runId = job.payload?.runId;
      if (!runId) throw new Error(`"${WORKFLOW_RESUME_JOB_TYPE}" job ${job.id} has no runId in its payload`);
      await resumeRun(runId, env);
    },
    { defaultMaxAttempts: 5, owner: "workflow", description: '§34 workflowResumeHandler — wakes a WAITING workflow run (§24) or a backed-off step retry.' },
  );
}
