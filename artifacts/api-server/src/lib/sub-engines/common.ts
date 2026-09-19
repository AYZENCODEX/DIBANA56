import { createHash, randomUUID } from "node:crypto";

export type Scope = {
  organizationId?: number | null;
  userId?: number | null;
  environment?: string;
};

export type AuditEvent = {
  id: string;
  engine: string;
  action: string;
  actorUserId?: number | null;
  organizationId?: number | null;
  subjectId?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export interface AuditSink {
  record(event: Omit<AuditEvent, "id" | "createdAt">): void;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  record(event: Omit<AuditEvent, "id" | "createdAt">): void {
    this.events.push({ ...event, id: randomUUID(), createdAt: new Date() });
  }

  list(engine?: string): AuditEvent[] {
    return this.events.filter((event) => !engine || event.engine === engine);
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export function scopeKey(scope: Scope): string {
  return [
    scope.environment ?? "default",
    scope.organizationId == null ? "*" : String(scope.organizationId),
    scope.userId == null ? "*" : String(scope.userId),
  ].join(":");
}

export function requireOrganization(scope: Scope): number {
  if (!Number.isInteger(scope.organizationId) || scope.organizationId == null) {
    throw new EngineError("organizationId is required for this operation", "ORGANIZATION_REQUIRED", 403);
  }
  return scope.organizationId;
}

export function deterministicPercent(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  return digest.readUInt32BE(0) % 100;
}

export function clone<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
}

export function nowMs(): number {
  return Date.now();
}