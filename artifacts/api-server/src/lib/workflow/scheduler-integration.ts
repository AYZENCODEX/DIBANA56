/**
 * lib/workflow/scheduler-integration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C2 (§24 Workflow Waiting).
 * The "worker released -> scheduler wakes workflow" half of §24's own
 * diagram: engine.ts's parkForWait() calls scheduleWorkflowResume() right
 * after persisting `next_resume_at` (never before — see engine.ts's own
 * ordering) so the DB row and its wakeup job are scheduled from the same
 * call path, same as job-store.ts's own scheduleJob() being the thing
 * that turns a durable row into something the worker will actually claim.
 *
 * `"workflow.resume"` is §34's own named example verbatim
 * (`registerJobHandler("workflow.resume", workflowResumeHandler)`) — the
 * actual `registerJobHandler()` call lives in ./scheduler-handler.ts, not
 * here, specifically so this file (which engine.ts imports) never
 * imports engine.ts back (see that file's own header for why the
 * registration is split out).
 */
import { scheduleJob } from "../scheduler";

export const WORKFLOW_RESUME_JOB_TYPE = "workflow.resume";

export interface WorkflowResumeJobPayload {
  runId: string;
  traceId?: string;
}

/** §29 "Workflow wakeup" — `workflowRunId + resumeAt`, exactly this call's two real arguments. `correlationId: runId` lets this job's own scheduler.job.* lifecycle events (worker.ts's §35 wiring) be traced back to the run they belong to without inspecting payload. */
export async function scheduleWorkflowResume(runId: string, resumeAt: Date): Promise<{ id: string }> {
  return scheduleJob<WorkflowResumeJobPayload>({
    jobType: WORKFLOW_RESUME_JOB_TYPE,
    runAt: resumeAt,
    payload: { runId },
    idempotencyKey: `workflow.resume:${runId}:${resumeAt.toISOString()}`,
    correlationId: runId,
    traceId: runId,
  });
}

export const WORKFLOW_COMPENSATE_JOB_TYPE = "workflow.compensate";

export async function scheduleWorkflowCompensation(runId: string, delayMs = 0, traceId?: string): Promise<{ id: string }> {
  return scheduleJob({
    jobType: WORKFLOW_COMPENSATE_JOB_TYPE,
    runAt: new Date(Date.now() + Math.max(0, delayMs)),
    payload: { runId, traceId },
    idempotencyKey: `workflow.compensate:${runId}:${Date.now() + Math.max(0, delayMs)}`,
    correlationId: runId,
    traceId: traceId ?? runId,
    maxAttempts: 1,
  });
}
