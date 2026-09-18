import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import { startEventBusDispatcher, stopEventBusDispatcher } from "../event-bus";
import { startSchedulerWorker, stopSchedulerWorker } from "../scheduler";
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
 * Starts the orchestration layer only after the database migration gate has
 * completed. Registration/recovery precedes polling so a fresh deployment
 * does not claim work before its handlers and durable state are ready.
 */
export async function startMegaEngine(): Promise<void> {
  if (started || stopping) return;
  validateMegaEngineConfiguration();
  await db.execute(sql`SELECT 1`);

  registerWorkflowResumeHandler();
  registerMegaEngineAuditIntegration();
  await registerWorkflowEventTriggers();
  await registerWorkflowScheduleTriggers();
  await registerWorkflowDelayedTriggers();

  const recoveredRunIds = await recoverExpiredRunLeases();
  for (const runId of recoveredRunIds) {
    const run = await getRun(runId);
    if (!run) continue;
    const driver = run.status === "COMPENSATING" ? resumeCompensation(runId) : executeRun(runId);
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
  started = false;
  logBus.system("Mega Engine stopped accepting new work");
  logger.info("Mega Engine stopped");
}