import { createHash } from "node:crypto";
import type { Scope } from "../sub-engines/common";

export type EngineAccessContext = Scope & {
  roles?: string[];
  isAdmin?: boolean;
};

export type SourceRef = {
  sourceType: string;
  sourceId: string;
  locator?: string;
};

export type IndexedDocument = {
  id: string;
  organizationId?: number | null;
  ownerUserId?: number | null;
  type: string;
  title: string;
  body: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: SourceRef;
  version?: number;
  updatedAt?: string;
};

export type SearchQuery = {
  text?: string;
  type?: string;
  tags?: string[];
  limit?: number;
  cursor?: string;
  mode?: "full_text" | "semantic" | "hybrid";
};

export type SearchHit = IndexedDocument & { score: number; highlights: string[] };

export type GraphEntity = {
  id: string;
  type: string;
  label: string;
  organizationId?: number | null;
  ownerUserId?: number | null;
  properties?: Record<string, unknown>;
  source?: SourceRef;
  version: number;
  updatedAt: string;
};

export type GraphRelationship = {
  id: string;
  from: string;
  to: string;
  type: string;
  organizationId?: number | null;
  properties?: Record<string, unknown>;
  source?: SourceRef;
  version: number;
  updatedAt: string;
};

export type SchemaField = { type: "string" | "number" | "boolean" | "object" | "array"; required?: boolean };
export type RegisteredSchema = {
  name: string;
  version: number;
  fields: Record<string, SchemaField>;
  status: "active" | "deprecated";
  compatibility: "backward" | "forward" | "full" | "none";
  migrationNotes?: string;
  createdAt: string;
};

export type LineageNode = {
  id: string;
  kind: "source" | "dataset" | "transformation" | "destination";
  label: string;
  organizationId?: number | null;
  ownerUserId?: number | null;
  source?: SourceRef;
  retentionUntil?: string;
};

export type LineageEdge = {
  id: string;
  from: string;
  to: string;
  transformation?: string;
  runId?: string;
  organizationId?: number | null;
  source?: SourceRef;
  createdAt: string;
};

export type ProvenanceRecord = {
  id: string;
  subjectType: string;
  subjectId: string;
  action: string;
  actorUserId?: number | null;
  organizationId?: number | null;
  decision?: string;
  evidence?: SourceRef[];
  metadata?: Record<string, unknown>;
  previousHash?: string;
  integrityHash: string;
  createdAt: string;
};

export type TimeSeriesPoint = {
  series: string;
  timestamp: string;
  value: number;
  dimensions?: Record<string, string>;
  idempotencyKey?: string;
  organizationId?: number | null;
};

export type ConsentDefinition = {
  key: string;
  version: number;
  purpose: string;
  required: boolean;
  text: string;
  expiresAfterDays?: number;
  createdAt: string;
};

export type ConsentRecord = {
  id: string;
  key: string;
  version: number;
  subjectUserId: number;
  organizationId?: number | null;
  status: "granted" | "withdrawn" | "expired";
  source?: string;
  grantedAt: string;
  withdrawnAt?: string;
  expiresAt?: string;
};

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function hashChain(previousHash: string | undefined, value: unknown): string {
  return createHash("sha256").update(`${previousHash ?? ""}:${stableJson(value)}`).digest("hex");
}

export function canAccess(record: { organizationId?: number | null; ownerUserId?: number | null }, access: EngineAccessContext): boolean {
  if (access.isAdmin) return true;
  if (record.ownerUserId != null && record.ownerUserId === access.userId) return true;
  if (record.organizationId == null) return record.ownerUserId == null;
  return record.organizationId === access.organizationId;
}

export function boundedLimit(value: unknown, fallback = 50, maximum = 200): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}