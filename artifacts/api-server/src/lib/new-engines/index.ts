import { randomUUID } from "node:crypto";
import { subEngineAudit } from "../sub-engines";
import { emitSubEngineEvent } from "../sub-engines/common";
import {
  canAccess, hashChain, stableJson, type ConsentDefinition, type ConsentRecord, type EngineAccessContext,
  type GraphEntity, type GraphRelationship, type IndexedDocument, type LineageEdge, type LineageNode,
  type ProvenanceRecord, type RegisteredSchema, type SchemaField, type SearchHit, type SearchQuery,
  type SourceRef, type TimeSeriesPoint,
} from "./contracts";

function now(): string { return new Date().toISOString(); }
function tokens(value: string): string[] { return value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}\-_]+/gu) ?? []; }
function audit(action: string, subjectId: string, metadata: Record<string, unknown>): void {
  subEngineAudit.record({ engine: "new-engines", action, subjectId, metadata });
  emitSubEngineEvent({ type: `new-engine.${action}`, payload: metadata, aggregate: { type: "new-engine", id: subjectId } });
}

export class SearchIndexEngine {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly rebuilds = new Map<string, { id: string; state: "running" | "completed"; cursor: number; total: number; version: number }>();
  private indexVersion = 1;

  upsert(document: IndexedDocument): IndexedDocument {
    const previous = this.documents.get(document.id);
    if (previous) {
      const { version: _version, updatedAt: _updatedAt, ...previousInput } = previous;
      if (stableJson(previousInput) === stableJson(document)) return { ...previous };
    }
    const next = { ...document, version: (previous?.version ?? 0) + 1, updatedAt: now() };
    this.documents.set(document.id, next);
    audit("search.document_indexed", document.id, { version: next.version, indexVersion: this.indexVersion, source: document.source });
    return { ...next };
  }

  remove(id: string): boolean { const removed = this.documents.delete(id); if (removed) audit("search.document_removed", id, {}); return removed; }

  query(query: SearchQuery, access: EngineAccessContext): { items: SearchHit[]; nextCursor?: string; indexVersion: number } {
    const requested = tokens(query.text ?? "");
    const tagFilter = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()));
    const scored = [...this.documents.values()]
      .filter((doc) => canAccess(doc, access) && (!query.type || doc.type === query.type))
      .filter((doc) => tagFilter.size === 0 || [...(doc.tags ?? []).map((tag) => tag.toLowerCase())].some((tag) => tagFilter.has(tag)))
      .map((doc) => {
        const titleTokens = tokens(doc.title);
        const bodyTokens = tokens(doc.body);
        const matched = requested.filter((term) => titleTokens.includes(term) || bodyTokens.includes(term));
        const score = requested.length === 0 ? 1 : (matched.length / requested.length) + matched.filter((term) => titleTokens.includes(term)).length * 0.25;
        const highlights = matched.slice(0, 5).map((term) => `${term} matched in indexed content`);
        return { ...doc, score, highlights };
      })
      .filter((doc) => requested.length === 0 || doc.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt!.localeCompare(a.updatedAt!));
    const offset = Math.max(0, Number(query.cursor ?? 0) || 0);
    const limit = Math.max(1, Math.min(100, query.limit ?? 20));
    return { items: scored.slice(offset, offset + limit), nextCursor: offset + limit < scored.length ? String(offset + limit) : undefined, indexVersion: this.indexVersion };
  }

  startRebuild(): { id: string; state: string; total: number; indexVersion: number } {
    this.indexVersion++;
    const rebuild = { id: randomUUID(), state: "running" as const, cursor: 0, total: this.documents.size, version: this.indexVersion };
    this.rebuilds.set(rebuild.id, rebuild);
    audit("search.rebuild_started", rebuild.id, { total: rebuild.total, indexVersion: rebuild.version });
    return { id: rebuild.id, state: rebuild.state, total: rebuild.total, indexVersion: rebuild.version };
  }

  rebuildStatus(id: string): { id: string; state: string; cursor: number; total: number; indexVersion: number } {
    const rebuild = this.rebuilds.get(id);
    if (!rebuild) throw new Error("Search rebuild not found");
    if (rebuild.state === "running") {
      rebuild.cursor = Math.min(rebuild.total, rebuild.cursor + 100);
      if (rebuild.cursor >= rebuild.total) rebuild.state = "completed";
    }
    return { ...rebuild };
  }

  stats(): { documents: number; indexVersion: number; rebuilds: number } { return { documents: this.documents.size, indexVersion: this.indexVersion, rebuilds: this.rebuilds.size }; }
}

export class KnowledgeGraphEngine {
  private readonly entities = new Map<string, GraphEntity>();
  private readonly relationships = new Map<string, GraphRelationship>();

  upsertEntity(input: Omit<GraphEntity, "version" | "updatedAt">): GraphEntity {
    const previous = this.entities.get(input.id);
    if (previous) {
      const { version: _version, updatedAt: _updatedAt, ...previousInput } = previous;
      if (stableJson(previousInput) === stableJson(input)) return { ...previous };
    }
    const next = { ...input, version: (previous?.version ?? 0) + 1, updatedAt: now() };
    this.entities.set(input.id, next);
    audit("knowledge.entity_upserted", input.id, { version: next.version, source: input.source });
    return { ...next };
  }

  upsertRelationship(input: Omit<GraphRelationship, "version" | "updatedAt">): GraphRelationship {
    if (!this.entities.has(input.from) || !this.entities.has(input.to)) throw new Error("Both relationship entities must exist");
    const previous = this.relationships.get(input.id);
    if (previous) {
      const { version: _version, updatedAt: _updatedAt, ...previousInput } = previous;
      if (stableJson(previousInput) === stableJson(input)) return { ...previous };
    }
    const next = { ...input, version: (previous?.version ?? 0) + 1, updatedAt: now() };
    this.relationships.set(input.id, next);
    audit("knowledge.relationship_upserted", input.id, { from: input.from, to: input.to, source: input.source });
    return { ...next };
  }

  getEntity(id: string, access: EngineAccessContext): GraphEntity | undefined {
    const entity = this.entities.get(id);
    return entity && canAccess(entity, access) ? { ...entity } : undefined;
  }

  traverse(startId: string, access: EngineAccessContext, options: { maxDepth?: number; relationshipType?: string } = {}): { entities: GraphEntity[]; relationships: GraphRelationship[] } {
    const start = this.getEntity(startId, access);
    if (!start) return { entities: [], relationships: [] };
    const visited = new Set([startId]);
    const foundEntities = [start];
    const foundRelationships: GraphRelationship[] = [];
    let frontier = [startId];
    for (let depth = 0; depth < Math.max(1, Math.min(10, options.maxDepth ?? 2)); depth++) {
      const next: string[] = [];
      for (const from of frontier) for (const relationship of this.relationships.values()) {
        if (relationship.from !== from || (options.relationshipType && relationship.type !== options.relationshipType)) continue;
        const target = this.getEntity(relationship.to, access);
        if (!target) continue;
        foundRelationships.push({ ...relationship });
        if (!visited.has(target.id)) { visited.add(target.id); foundEntities.push(target); next.push(target.id); }
      }
      frontier = next;
    }
    return { entities: foundEntities, relationships: foundRelationships };
  }

  stats(): { entities: number; relationships: number } { return { entities: this.entities.size, relationships: this.relationships.size }; }
}

export class SchemaRegistryEngine {
  private readonly schemas = new Map<string, RegisteredSchema[]>();

  register(input: { name: string; fields: Record<string, SchemaField>; compatibility?: RegisteredSchema["compatibility"]; migrationNotes?: string }): RegisteredSchema {
    const versions = this.schemas.get(input.name) ?? [];
    const compatibility = input.compatibility ?? "backward";
    const previous = versions.at(-1);
    if (previous && compatibility !== "none") {
      for (const [key, field] of Object.entries(previous.fields)) {
        if (compatibility === "backward" && field.required && (!input.fields[key] || input.fields[key].type !== field.type)) {
          throw new Error(`Breaking schema change: required field ${key} was removed or changed`);
        }
      }
    }
    const schema: RegisteredSchema = { name: input.name, version: versions.length + 1, fields: { ...input.fields }, status: "active", compatibility, migrationNotes: input.migrationNotes, createdAt: now() };
    if (previous) previous.status = "deprecated";
    versions.push(schema);
    this.schemas.set(input.name, versions);
    audit("schema.registered", input.name, { version: schema.version, compatibility });
    return { ...schema, fields: { ...schema.fields } };
  }

  get(name: string, version?: number): RegisteredSchema | undefined {
    const schema = version ? this.schemas.get(name)?.find((item) => item.version === version) : this.schemas.get(name)?.at(-1);
    return schema ? { ...schema, fields: { ...schema.fields } } : undefined;
  }

  validate(name: string, value: Record<string, unknown>, version?: number): { valid: boolean; errors: string[]; schema?: RegisteredSchema } {
    const schema = this.get(name, version);
    if (!schema) return { valid: false, errors: ["Schema not found"] };
    const errors: string[] = [];
    for (const [key, field] of Object.entries(schema.fields)) {
      const item = value[key];
      if (item === undefined || item === null) { if (field.required) errors.push(`${key} is required`); continue; }
      const actual = Array.isArray(item) ? "array" : typeof item;
      if (actual !== field.type) errors.push(`${key} must be ${field.type}`);
    }
    return { valid: errors.length === 0, errors, schema };
  }

  list(): RegisteredSchema[] { return [...this.schemas.values()].flatMap((items) => items.map((schema) => ({ ...schema, fields: { ...schema.fields } }))); }
}

export class DataLineageEngine {
  private readonly nodes = new Map<string, LineageNode>();
  private readonly edges = new Map<string, LineageEdge>();
  registerNode(node: LineageNode): LineageNode { this.nodes.set(node.id, { ...node }); audit("lineage.node_registered", node.id, { kind: node.kind }); return { ...node }; }
  recordFlow(edge: LineageEdge): LineageEdge { if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) throw new Error("Lineage endpoints must exist"); this.edges.set(edge.id, { ...edge }); audit("lineage.flow_recorded", edge.id, { from: edge.from, to: edge.to, runId: edge.runId }); return { ...edge }; }
  impact(startId: string, access: EngineAccessContext, direction: "downstream" | "upstream" = "downstream"): { nodes: LineageNode[]; edges: LineageEdge[] } {
    const root = this.nodes.get(startId);
    if (!root || !canAccess(root, access)) return { nodes: [], edges: [] };
    const seen = new Set([startId]); const nodes = [root]; const edges: LineageEdge[] = []; let frontier = [startId];
    while (frontier.length) {
      const next: string[] = [];
      for (const edge of this.edges.values()) {
        const matches = direction === "downstream" ? frontier.includes(edge.from) : frontier.includes(edge.to);
        if (!matches) continue;
        const targetId = direction === "downstream" ? edge.to : edge.from;
        const target = this.nodes.get(targetId);
        if (!target || !canAccess(target, access)) continue;
        edges.push({ ...edge });
        if (!seen.has(targetId)) { seen.add(targetId); nodes.push({ ...target }); next.push(targetId); }
      }
      frontier = next;
    }
    return { nodes, edges };
  }
  list(): { nodes: LineageNode[]; edges: LineageEdge[] } { return { nodes: [...this.nodes.values()].map((item) => ({ ...item })), edges: [...this.edges.values()].map((item) => ({ ...item })) }; }
}

export class ProvenanceEngine {
  private readonly records = new Map<string, ProvenanceRecord[]>();
  record(input: Omit<ProvenanceRecord, "id" | "previousHash" | "integrityHash" | "createdAt">): ProvenanceRecord {
    const key = `${input.subjectType}:${input.subjectId}`;
    const previous = this.records.get(key)?.at(-1);
    const base = { ...input, id: randomUUID(), previousHash: previous?.integrityHash, createdAt: now() };
    const record = { ...base, integrityHash: hashChain(base.previousHash, base) };
    const list = this.records.get(key) ?? []; list.push(record); this.records.set(key, list);
    audit("provenance.recorded", record.id, { subjectType: input.subjectType, subjectId: input.subjectId, integrityHash: record.integrityHash });
    return { ...record };
  }
  history(subjectType: string, subjectId: string): ProvenanceRecord[] { return [...(this.records.get(`${subjectType}:${subjectId}`) ?? [])].map((item) => ({ ...item })); }
  verify(subjectType: string, subjectId: string): { valid: boolean; records: number; failedAt?: string } {
    let previous: string | undefined;
    for (const record of this.records.get(`${subjectType}:${subjectId}`) ?? []) {
      const { integrityHash: _hash, ...base } = record;
      if (record.previousHash !== previous || hashChain(record.previousHash, base) !== record.integrityHash) return { valid: false, records: 0, failedAt: record.id };
      previous = record.integrityHash;
    }
    return { valid: true, records: this.records.get(`${subjectType}:${subjectId}`)?.length ?? 0 };
  }
}

export class TimeSeriesEngine {
  private readonly points: TimeSeriesPoint[] = [];
  private readonly idempotency = new Set<string>();
  append(point: TimeSeriesPoint): TimeSeriesPoint {
    if (!point.series || !Number.isFinite(point.value) || Number.isNaN(Date.parse(point.timestamp))) throw new Error("Invalid time-series point");
    if (point.idempotencyKey && this.idempotency.has(`${point.organizationId ?? "*"}:${point.idempotencyKey}`)) return { ...point };
    if (point.idempotencyKey) this.idempotency.add(`${point.organizationId ?? "*"}:${point.idempotencyKey}`);
    this.points.push({ ...point }); audit("timeseries.point_appended", point.series, { timestamp: point.timestamp, value: point.value });
    return { ...point };
  }
  query(series: string, from: string, to: string, access: EngineAccessContext, bucketMs?: number): Array<TimeSeriesPoint & { count?: number; average?: number; min?: number; max?: number }> {
    const items = this.points.filter((point) => point.series === series && Date.parse(point.timestamp) >= Date.parse(from) && Date.parse(point.timestamp) <= Date.parse(to) && (point.organizationId == null || point.organizationId === access.organizationId || access.isAdmin));
    if (!bucketMs || bucketMs < 1) return items.map((item) => ({ ...item }));
    const buckets = new Map<number, TimeSeriesPoint[]>();
    for (const point of items) { const key = Math.floor(Date.parse(point.timestamp) / bucketMs) * bucketMs; buckets.set(key, [...(buckets.get(key) ?? []), point]); }
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([key, bucket]) => ({ series, timestamp: new Date(key).toISOString(), value: bucket.reduce((sum, item) => sum + item.value, 0) / bucket.length, count: bucket.length, average: bucket.reduce((sum, item) => sum + item.value, 0) / bucket.length, min: Math.min(...bucket.map((item) => item.value)), max: Math.max(...bucket.map((item) => item.value)) }));
  }
  enforceRetention(before: string): number { const cutoff = Date.parse(before); const beforeCount = this.points.length; if (Number.isNaN(cutoff)) throw new Error("Invalid retention cutoff"); for (let index = this.points.length - 1; index >= 0; index--) if (Date.parse(this.points[index].timestamp) < cutoff) this.points.splice(index, 1); return beforeCount - this.points.length; }
}

export class ConsentEngine {
  private readonly definitions = new Map<string, ConsentDefinition[]>();
  private readonly records: ConsentRecord[] = [];
  define(input: Omit<ConsentDefinition, "version" | "createdAt">): ConsentDefinition {
    const versions = this.definitions.get(input.key) ?? [];
    const definition = { ...input, version: versions.length + 1, createdAt: now() };
    versions.push(definition); this.definitions.set(input.key, versions); audit("consent.defined", input.key, { version: definition.version });
    return { ...definition };
  }
  grant(input: { key: string; subjectUserId: number; organizationId?: number | null; source?: string; version?: number }): ConsentRecord {
    const definition = this.getDefinition(input.key, input.version);
    if (!definition) throw new Error("Consent definition not found");
    const grantedAt = now(); const record: ConsentRecord = { id: randomUUID(), key: input.key, version: definition.version, subjectUserId: input.subjectUserId, organizationId: input.organizationId, status: "granted", source: input.source, grantedAt, expiresAt: definition.expiresAfterDays ? new Date(Date.parse(grantedAt) + definition.expiresAfterDays * 86_400_000).toISOString() : undefined };
    this.records.push(record); audit("consent.granted", record.id, { key: record.key, version: record.version, subjectUserId: record.subjectUserId });
    return { ...record };
  }
  withdraw(key: string, subjectUserId: number, organizationId?: number | null): ConsentRecord {
    const active = this.effective(key, subjectUserId, organizationId);
    if (!active) throw new Error("No effective consent to withdraw");
    active.status = "withdrawn"; active.withdrawnAt = now(); audit("consent.withdrawn", active.id, { key, subjectUserId }); return { ...active };
  }
  effective(key: string, subjectUserId: number, organizationId?: number | null): ConsentRecord | undefined {
    const matching = this.records.filter((item) => item.key === key && item.subjectUserId === subjectUserId && item.organizationId === organizationId).sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
    const latest = matching[0]; if (!latest || latest.status !== "granted") return undefined;
    if (latest.expiresAt && Date.parse(latest.expiresAt) <= Date.now()) { latest.status = "expired"; return undefined; }
    return latest;
  }
  history(key: string, subjectUserId: number, organizationId?: number | null): ConsentRecord[] { return this.records.filter((item) => item.key === key && item.subjectUserId === subjectUserId && item.organizationId === organizationId).map((item) => ({ ...item })); }
  listDefinitions(): ConsentDefinition[] { return [...this.definitions.values()].flatMap((items) => items.map((item) => ({ ...item }))); }
  private getDefinition(key: string, version?: number): ConsentDefinition | undefined { return version ? this.definitions.get(key)?.find((item) => item.version === version) : this.definitions.get(key)?.at(-1); }
}

export const searchIndexEngine = new SearchIndexEngine();
export const knowledgeGraphEngine = new KnowledgeGraphEngine();
export const schemaRegistryEngine = new SchemaRegistryEngine();
export const dataLineageEngine = new DataLineageEngine();
export const provenanceEngine = new ProvenanceEngine();
export const timeSeriesEngine = new TimeSeriesEngine();
export const consentEngine = new ConsentEngine();

export type { ConsentDefinition, ConsentRecord, EngineAccessContext, GraphEntity, GraphRelationship, IndexedDocument, LineageEdge, LineageNode, ProvenanceRecord, RegisteredSchema, SchemaField, SearchHit, SearchQuery, SourceRef, TimeSeriesPoint };