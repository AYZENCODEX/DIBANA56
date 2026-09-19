import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import {
  startEventBusDispatcher, stopEventBusDispatcher, waitForEventBusIdle,
} from "../event-bus";
import { startSchedulerWorker, stopSchedulerWorker, waitForSchedulerIdle } from "../scheduler";
import {
  executeRun,
  getRun,
  recoverExpiredRunLeases,
  registerWorkflowDelayedTriggers,
  registerWorkflowEventTriggers,
  registerWorkflowResumeHandler,
  registerWorkflowScheduleTriggers,
  resumeCompensation,
} from "../workflow";
import { registerMegaEngineAuditIntegration } from "./audit-integration";
import { registerRetentionSweepSchedule } from "./retention";
import { registerAyzenDomainEvents } from "./domain-events";
import { PolicyEngine } from "../policy/policy-engine";
import { createResourceOwnershipRule } from "../policy/resource";
import { DrizzleSubjectProvider } from "../policy/pip/drizzle-subject-provider";
import type { WorkflowRuntimeEnv } from "../workflow";
import { registerSubEngineIntegration } from "../sub-engines/integration";

let started = false;
let stopping = false;

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function validateMegaEngineConfiguration(): void {
  positiveEnv("ENGINE_EVENT_BATCH_SIZE", 25);
  positiveEnv("ENGINE_SCHEDULER_BATCH_SIZE", 25);
  positiveEnv("ENGINE_WORKFLOW_LEASE_MS", 60_000);
}

/**
 * J9 — delayed work must evaluate the current identity, not the role that
 * existed when the workflow was created. The engine deliberately starts with
 * the same ownership rule used by the live PEP routes; additional domain
 * rules can be registered without changing workflow execution.
 */
function createWorkflowRuntimeEnv(): WorkflowRuntimeEnv {
  const policyEngine = new PolicyEngine();
  policyEngine.registerRule("resource-ownership", createResourceOwnershipRule());
  const subjectProvider = new DrizzleSubjectProvider();

  return {
    policyEngine,
    resolveSubject: async (userId) => {
      const [user] = await db.select({ id: usersTable.id, role: usersTable.role })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      if (!user) return null;
      return subjectProvider.getSubject({ userId: user.id, role: String(user.role ?? "user"), authType: "session" });
    },
  };
}

/**
 * Starts the orchestration layer only after the database migration gate has
 * completed. Registration/recovery precedes polling so a fresh deployment
 * does not claim work before its handlers and durable state are ready.
 */
export async function startMegaEngine(): Promise<void> {
  if (started || stopping) return;
  stopping = false;
  validateMegaEngineConfiguration();
  await db.execute(sql`SELECT 1`);

  const workflowRuntimeEnv = createWorkflowRuntimeEnv();
  registerWorkflowResumeHandler(workflowRuntimeEnv);
  registerAyzenDomainEvents();
  registerMegaEngineAuditIntegration();
  await registerSubEngineIntegration();
  await registerWorkflowEventTriggers(workflowRuntimeEnv);
  await registerWorkflowScheduleTriggers(workflowRuntimeEnv);
  await registerWorkflowDelayedTriggers(workflowRuntimeEnv);

  const recoveredRunIds = await recoverExpiredRunLeases();
  for (const runId of recoveredRunIds) {
    const run = await getRun(runId);
    if (!run) continue;
    const driver = run.status === "COMPENSATING"
      ? resumeCompensation(runId, undefined, workflowRuntimeEnv)
      : executeRun(runId, workflowRuntimeEnv);
    driver.catch((err) => logger.error({ err, runId }, "Mega Engine recovered run failed"));
  }

  startEventBusDispatcher();
  startSchedulerWorker();
  await registerRetentionSweepSchedule();
  started = true;
  logBus.system(`✅ Mega Engine started (recovered ${recoveredRunIds.length} run(s))`);
  logger.info({ recoveredRunCount: recoveredRunIds.length }, "Mega Engine started");
}

/**
 * Stops claiming new event/job work before the HTTP server closes. Existing
 * handlers are allowed to settle; durable leases make an interrupted handler
 * recoverable on the next boot.
 */
export async function stopMegaEngine(): Promise<void> {
  if (!started || stopping) return;
  stopping = true;
  stopEventBusDispatcher();
  stopSchedulerWorker();
  const [eventIdle, schedulerIdle] = await Promise.all([
    waitForEventBusIdle(),
    waitForSchedulerIdle(),
  ]);
  started = false;
  logBus.system("Mega Engine stopped accepting new work");
  logger.info({ eventIdle, schedulerIdle }, "Mega Engine stopped");
  stopping = false;
}