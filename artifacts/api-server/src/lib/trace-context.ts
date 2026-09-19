import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface EngineTraceContext {
  traceId: string;
  correlationId?: string;
  causationId?: string;
  eventId?: string;
  workflowRunId?: string;
  jobId?: string;
}

const traceStorage = new AsyncLocalStorage<EngineTraceContext>();

function headerValue(value: string | string[] | undefined, fallback?: string): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return fallback;
  const trimmed = candidate.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : fallback;
}

export function traceContextFromHeaders(headers: {
  "x-trace-id"?: string | string[];
  "x-correlation-id"?: string | string[];
  "x-causation-id"?: string | string[];
}): EngineTraceContext {
  const correlationId = headerValue(headers["x-correlation-id"]);
  return {
    traceId: headerValue(headers["x-trace-id"], correlationId) ?? newTraceId(),
    correlationId,
    causationId: headerValue(headers["x-causation-id"]),
  };
}

export function runWithTraceContext<T>(context: EngineTraceContext, callback: () => T): T {
  return traceStorage.run(context, callback);
}

export function getCurrentTraceContext(): EngineTraceContext | undefined {
  return traceStorage.getStore();
}

export function newTraceId(): string {
  return crypto.randomUUID();
}

export function ensureTraceId(traceId?: string, correlationId?: string): string {
  return traceId ?? correlationId ?? getCurrentTraceContext()?.traceId ?? newTraceId();
}

/** Stable JSON used only for idempotency keys; object key order must not change the key. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}