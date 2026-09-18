import crypto from "crypto";

export interface EngineTraceContext {
  traceId: string;
  correlationId?: string;
  causationId?: string;
  eventId?: string;
  workflowRunId?: string;
  jobId?: string;
}

export function newTraceId(): string {
  return crypto.randomUUID();
}

export function ensureTraceId(traceId?: string, correlationId?: string): string {
  return traceId ?? correlationId ?? newTraceId();
}

/** Stable JSON used only for idempotency keys; object key order must not change the key. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}