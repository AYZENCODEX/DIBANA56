/**
 * Cross-subsystem operator links for J10.
 *
 * The three engines intentionally keep separate durable tables. This read-only
 * projection joins them by the identifiers already carried in event/job/run
 * envelopes instead of coupling their stores together.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface EngineLinks {
  correlationId: string;
  events: unknown[];
  jobs: unknown[];
  audits: unknown[];
}

export async function getEngineLinks(correlationId: string): Promise<EngineLinks> {
  const [events, jobs, audits] = await Promise.all([
    db.execute(sql`
      SELECT id, event_type, event_version, status, trace_id, causation_id,
             occurred_at, published_at, last_error
      FROM event_outbox
      WHERE correlation_id = ${correlationId}
      ORDER BY occurred_at DESC
      LIMIT 200
    `),
    db.execute(sql`
      SELECT id, job_type, status, run_at, attempts, max_attempts,
             trace_id, causation_id, last_error, locked_until
      FROM scheduled_job
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at DESC
      LIMIT 200
    `),
    db.execute(sql`
      SELECT id, action, actor_user_id, organization_id, subject_type,
             subject_id, event_id, workflow_run_id, job_id, trace_id,
             causation_id, created_at, metadata
      FROM engine_audit_log
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at DESC
      LIMIT 200
    `),
  ]);

  return {
    correlationId,
    events: events.rows,
    jobs: jobs.rows,
    audits: audits.rows,
  };
}