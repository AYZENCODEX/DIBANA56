/**
 * lib/scheduler/dead-letter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Scheduler's equivalent of event-bus/dead-letter.ts — a job that
 * exhausted retry.ts's backoff (attempts >= its own max_attempts), or
 * referenced an unregistered job type (§34: "must fail safely and become
 * observable"), lands here with its payload so an operator can inspect
 * and replay it (§57-E "dead-letter tools", carried into every engine's
 * V1 order the same way).
 */
import { db, scheduledJobDeadLetterTable, scheduledJobTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../logger";
import { logBus } from "../log-bus";
import { defaultMaxAttemptsFor } from "./job-registry";

export async function moveToDeadLetter(params: {
  jobId: string;
  jobType: string;
  payload: Record<string, unknown> | undefined;
  attempts: number;
  lastError: string;
}): Promise<void> {
  const { jobId, jobType, payload, attempts, lastError } = params;
  try {
    await db.insert(scheduledJobDeadLetterTable).values({ jobId, jobType, payload, attempts, lastError });
  } catch (err: any) {
    const isUniqueViolation = err?.code === "23505" || /duplicate key/i.test(String(err?.message ?? ""));
    if (!isUniqueViolation) throw err;
  }
  logger.warn({ jobId, jobType, attempts }, "Job moved to dead letter");
  logBus.warn(`Scheduler: job "${jobType}" (${jobId}) dead-lettered after ${attempts} attempt(s): ${lastError}`);
}

export async function listDeadLetters(filter?: { jobType?: string; status?: "PENDING" | "REPLAYED" | "DISCARDED" }) {
  const conditions = [];
  if (filter?.jobType) conditions.push(eq(scheduledJobDeadLetterTable.jobType, filter.jobType));
  if (filter?.status) conditions.push(eq(scheduledJobDeadLetterTable.status, filter.status));
  return conditions.length
    ? db.select().from(scheduledJobDeadLetterTable).where(and(...conditions))
    : db.select().from(scheduledJobDeadLetterTable);
}

/**
 * Re-inserts a NEW scheduled_job row (fresh id, run_at = now — "replay
 * immediately" is the useful default for an operator who just fixed
 * whatever was failing) rather than resurrecting the old row, same
 * reasoning as event-bus/dead-letter.ts's replayDeadLetter(). Marks the
 * dead-letter row REPLAYED, doesn't delete it (§60).
 */
export async function replayDeadLetter(id: number): Promise<{ newJobId: string }> {
  const [row] = await db.select().from(scheduledJobDeadLetterTable).where(eq(scheduledJobDeadLetterTable.id, id)).limit(1);
  if (!row) throw new Error(`Dead letter row ${id} not found`);
  if (row.status !== "PENDING") throw new Error(`Dead letter row ${id} is already ${row.status}`);

  const newJobId = crypto.randomUUID();

  await db.transaction(async (trx) => {
    await trx.insert(scheduledJobTable).values({
      id: newJobId,
      jobType: row.jobType,
      runAt: new Date(),
      payload: row.payload,
      maxAttempts: defaultMaxAttemptsFor(row.jobType),
    });
    await trx.update(scheduledJobDeadLetterTable).set({ status: "REPLAYED", resolvedAt: new Date() })
      .where(eq(scheduledJobDeadLetterTable.id, id));
  });

  logBus.system(`Scheduler: replayed dead letter #${id} ("${row.jobType}") as new job ${newJobId}`);
  return { newJobId };
}

export async function discardDeadLetter(id: number): Promise<void> {
  await db.update(scheduledJobDeadLetterTable).set({ status: "DISCARDED", resolvedAt: new Date() })
    .where(and(eq(scheduledJobDeadLetterTable.id, id), eq(scheduledJobDeadLetterTable.status, "PENDING")));
}
