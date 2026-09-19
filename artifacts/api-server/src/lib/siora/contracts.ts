import { randomUUID } from "node:crypto";
import type { EngineTraceContext } from "../trace-context";

export type SioraSeverity = "info" | "low" | "medium" | "high" | "critical";
export type SioraConfidence = "low" | "medium" | "high";
export type SioraEventKind = "request" | "authentication" | "session" | "action" | "custom";
export type SioraDecision = "allow" | "monitor" | "step_up" | "restrict" | "deny";

export type SioraActor = {
  userId?: number | null;
  organizationId?: number | null;
  role?: string;
  authType?: string;
  accountAgeDays?: number;
  verified?: boolean;
};

export type SioraRequest = {
  method?: string;
  path?: string;
  endpoint?: string;
  ip?: string;
  userAgent?: string;
  deviceId?: string;
  traceId?: string;
  correlationId?: string;
};

export type SioraContext = {
  actor?: SioraActor;
  request?: SioraRequest;
  session?: {
    id?: string;
    createdAt?: string;
    lastSeenAt?: string;
    expiresAt?: string;
    previousIp?: string;
    previousDeviceId?: string;
  };
  metadata?: Record<string, unknown>;
};

export type SioraEvent = {
  id: string;
  kind: SioraEventKind;
  name: string;
  occurredAt: string;
  context: SioraContext;
  data: Record<string, unknown>;
  trace: Pick<EngineTraceContext, "traceId" | "correlationId" | "causationId">;
};

export type SioraSignal = {
  engine: string;
  code: string;
  severity: SioraSeverity;
  confidence: SioraConfidence;
  score: number;
  reason: string;
  evidence?: Record<string, unknown>;
  createdAt: string;
};

export type SioraEngineResult = {
  engine: string;
  signals: SioraSignal[];
  decision?: SioraDecision;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
};

export type SioraEvaluation = {
  eventId: string;
  traceId: string;
  decision: SioraDecision;
  signals: SioraSignal[];
  results: SioraEngineResult[];
  responseActionId?: string;
  completedAt: string;
};

export type SioraEngine = {
  name: string;
  priority: number;
  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult | Promise<SioraEngineResult>;
};

export type SioraEngineTools = {
  now(): number;
  scoreToSeverity(score: number): SioraSeverity;
  confidenceFromSignals(signals: SioraSignal[]): SioraConfidence;
  emit(signal: Omit<SioraSignal, "createdAt">): SioraSignal;
  getRecentEvents(filter: (event: SioraEvent) => boolean, limit?: number): SioraEvent[];
  getSignals(filter: (signal: SioraSignal) => boolean, limit?: number): SioraSignal[];
  cacheKey(namespace: string, key: string): string;
};

export function newSioraEvent(
  input: Omit<SioraEvent, "id" | "occurredAt"> & { id?: string; occurredAt?: string },
): SioraEvent {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    context: sanitizeContext(input.context),
    data: sanitizeRecord(input.data),
    trace: {
      traceId: input.trace.traceId,
      correlationId: input.trace.correlationId,
      causationId: input.trace.causationId,
    },
  };
}

const SECRET_KEY = /(password|passphrase|secret|token|api[_-]?key|private[_-]?key|cookie|authorization|credential)/i;

export function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      result[key] = "[REDACTED]";
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      result[key] = sanitizeRecord(item as Record<string, unknown>);
    } else if (Array.isArray(item)) {
      result[key] = item.map((entry) =>
        entry && typeof entry === "object" ? sanitizeRecord(entry as Record<string, unknown>) : entry,
      );
    } else if (typeof item === "string" && item.length > 512) {
      result[key] = item.slice(0, 512);
    } else {
      result[key] = item;
    }
  }
  return result;
}

export function sanitizeContext(context: SioraContext): SioraContext {
  return {
    actor: context.actor ? { ...context.actor } : undefined,
    request: context.request ? { ...context.request, userAgent: context.request.userAgent?.slice(0, 512) } : undefined,
    session: context.session ? { ...context.session } : undefined,
    metadata: context.metadata ? sanitizeRecord(context.metadata) : undefined,
  };
}