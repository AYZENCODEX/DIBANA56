import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getEventBusMetrics } from "../event-bus";
import { getSchedulerMetrics } from "../scheduler";
import { getWorkflowMetrics } from "../workflow";
import { getEngineCapacity } from "./capacity";

export interface EngineOperationsSnapshot {
  checkedAt: string;
  worker: {
    eventDispatcher: { active: boolean; lastHeartbeatAt: string | null };
    scheduler: { active: boolean; lastHeartbeatAt: string | null };
  };
  queues: {
    eventOutbox: number;
    scheduler: number;
    eventDeadLetter: number;
    schedulerDeadLetter: number;
    workflowWaiting: number;
  };
  latency: {
    eventProcessingMs: number | null;
    schedulerLagMs: number | null;
    workflowMs: number | null;
  };
  retryCounts: {
    event: number;
    scheduler: number;
    workflow: number;
  };
  failureRate: {
    event: number;
    scheduler: number;
    workflow: number;
  };
  capacity: ReturnType<typeof getEngineCapacity>;
}

export function ratio(failures: number, total: number): number {
  return total > 0 ? Number((failures / total).toFixed(4)) : 0;
}

function avg(snapshot: { avgMs: number | null }): number | null {
  return snapshot.avgMs;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query);
  return Number((result.rows[0] as { count?: number })?.count ?? 0);
}

export async function getEngineOperationsSnapshot(): Promise<EngineOperationsSnapshot> {
  const [eventOutbox, scheduler, eventDlq, schedulerDlq, workflowWaiting] = await Promise.all([
    count(sql`SELECT count(*)::int AS count FROM event_outbox WHERE status IN ('PENDING', 'FAILED', 'PROCESSING')`),
    count(sql`SELECT count(*)::int AS count FROM scheduled_job WHERE status IN ('SCHEDULED', 'RETRYING', 'RUNNING')`),
    count(sql`SELECT count(*)::int AS count FROM event_dead_letter WHERE status = 'PENDING'`),
    count(sql`SELECT count(*)::int AS count FROM scheduled_job_dead_letter WHERE status = 'PENDING'`),
    count(sql`SELECT count(*)::int AS count FROM workflow_run WHERE status = 'WAITING'`),
  ]);

  const event = getEventBusMetrics();
  const schedulerMetrics = getSchedulerMetrics();
  const workflow = getWorkflowMetrics();

  return {
    checkedAt: new Date().toISOString(),
    worker: {
      eventDispatcher: {
        active: event.workerActive,
        lastHeartbeatAt: event.workerLastHeartbeatAt,
      },
      scheduler: {
        active: schedulerMetrics.workerActive,
        lastHeartbeatAt: schedulerMetrics.workerLastHeartbeatAt,
      },
    },
    queues: {
      eventOutbox,
      scheduler,
      eventDeadLetter: eventDlq,
      schedulerDeadLetter: schedulerDlq,
      workflowWaiting,
    },
    latency: {
      eventProcessingMs: avg(event.handlerLatencyMs),
      schedulerLagMs: avg(schedulerMetrics.schedulerLagMs),
      workflowMs: avg(workflow.runDurationMs),
    },
    retryCounts: {
      event: event.retried,
      scheduler: schedulerMetrics.jobsRetried,
      workflow: 0,
    },
    failureRate: {
      event: ratio(event.handlerFailures, event.dispatched),
      scheduler: ratio(schedulerMetrics.jobsFailed, schedulerMetrics.jobsExecuted + schedulerMetrics.jobsFailed),
      workflow: ratio(workflow.runsFailed, workflow.runsStarted),
    },
    capacity: getEngineCapacity(),
  };
}
