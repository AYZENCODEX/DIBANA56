import crypto from "crypto";
import { db, engineAuditLogTable } from "@workspace/db";
import type { EventEnvelope } from "../event-bus";

const SENSITIVE_KEY = /(secret|password|token|credential|private.?key|seed.?phrase|authorization|cookie)/i;

function safe(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safe(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100)
    .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : safe(item, depth + 1)]));
}

export async function writeEngineAudit(params: {
  action: string;
  envelope?: EventEnvelope;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const envelope = params.envelope;
  await db.insert(engineAuditLogTable).values({
    id: crypto.randomUUID(),
    action: params.action,
    actorUserId: envelope?.actor?.userId,
    organizationId: envelope?.actor?.organizationId,
    subjectType: envelope?.aggregate?.type,
    subjectId: envelope?.aggregate?.id,
    eventId: envelope?.id,
    workflowRunId: typeof envelope?.payload === "object" && envelope?.payload ? String((envelope.payload as Record<string, unknown>).runId ?? "") || undefined : undefined,
    jobId: typeof envelope?.payload === "object" && envelope?.payload ? String((envelope.payload as Record<string, unknown>).jobId ?? "") || undefined : undefined,
    traceId: envelope?.traceId,
    correlationId: envelope?.correlationId,
    causationId: envelope?.causationId,
    metadata: safe(params.metadata ?? envelope?.metadata ?? {}) as Record<string, unknown>,
  });
}