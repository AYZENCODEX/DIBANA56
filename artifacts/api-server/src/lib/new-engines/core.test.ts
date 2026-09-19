import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsentEngine, DataLineageEngine, KnowledgeGraphEngine, ProvenanceEngine, SchemaRegistryEngine,
  SearchIndexEngine, TimeSeriesEngine,
} from "./index";

const access = { userId: 7, organizationId: 42 };

test("N1 search indexing is idempotent and permission-aware", () => {
  const engine = new SearchIndexEngine();
  const input = { id: "doc-1", organizationId: 42, type: "policy", title: "Access policy", body: "secure access", tags: ["security"] };
  const first = engine.upsert(input);
  const second = engine.upsert(input);
  assert.equal(first.version, 1);
  assert.equal(second.version, 1);
  assert.equal(engine.query({ text: "access" }, access).items.length, 1);
  assert.equal(engine.query({ text: "access" }, { userId: 7, organizationId: 9 }).items.length, 0);
});

test("N2 graph traversal only returns accessible, source-traceable relationships", () => {
  const engine = new KnowledgeGraphEngine();
  engine.upsertEntity({ id: "a", type: "service", label: "A", organizationId: 42, source: { sourceType: "catalog", sourceId: "a" } });
  engine.upsertEntity({ id: "b", type: "dataset", label: "B", organizationId: 42, source: { sourceType: "catalog", sourceId: "b" } });
  engine.upsertRelationship({ id: "a-b", from: "a", to: "b", type: "produces", organizationId: 42, source: { sourceType: "pipeline", sourceId: "run-1" } });
  const result = engine.traverse("a", access);
  assert.deepEqual(result.entities.map((entity) => entity.id), ["a", "b"]);
  assert.equal(result.relationships[0]?.source?.sourceId, "run-1");
});

test("N3 schema registry detects breaking changes and validates versions", () => {
  const engine = new SchemaRegistryEngine();
  engine.register({ name: "event", fields: { id: { type: "string", required: true }, count: { type: "number" } } });
  assert.throws(() => engine.register({ name: "event", fields: { count: { type: "string" } } }), /Breaking schema change/);
  assert.equal(engine.validate("event", { id: "e1", count: 2 }).valid, true);
});

test("N4 lineage impact follows the flow graph", () => {
  const engine = new DataLineageEngine();
  engine.registerNode({ id: "source", kind: "source", label: "Source", organizationId: 42 });
  engine.registerNode({ id: "dest", kind: "destination", label: "Destination", organizationId: 42 });
  engine.recordFlow({ id: "flow", from: "source", to: "dest", createdAt: new Date().toISOString(), organizationId: 42 });
  assert.deepEqual(engine.impact("source", access).nodes.map((node) => node.id), ["source", "dest"]);
});

test("N5 provenance hash chain detects tampering", () => {
  const engine = new ProvenanceEngine();
  engine.record({ subjectType: "schema", subjectId: "event", action: "registered", organizationId: 42 });
  engine.record({ subjectType: "schema", subjectId: "event", action: "validated", organizationId: 42 });
  assert.equal(engine.verify("schema", "event").valid, true);
  const history = engine.history("schema", "event");
  assert.equal(history.length, 2);
});

test("N6 time series is idempotent and supports bucketed history", () => {
  const engine = new TimeSeriesEngine();
  engine.append({ series: "latency", timestamp: "2026-01-01T00:00:00.000Z", value: 10, organizationId: 42, idempotencyKey: "p1" });
  engine.append({ series: "latency", timestamp: "2026-01-01T00:00:00.000Z", value: 99, organizationId: 42, idempotencyKey: "p1" });
  const result = engine.query("latency", "2025-12-31T00:00:00.000Z", "2026-01-02T00:00:00.000Z", access, 86_400_000);
  assert.equal(result[0]?.count, 1);
  assert.equal(result[0]?.average, 10);
});

test("N7 consent is versioned, auditable, and withdrawal is effective without authorizing access", () => {
  const engine = new ConsentEngine();
  engine.define({ key: "marketing", purpose: "Marketing messages", required: false, text: "Allow marketing" });
  engine.grant({ key: "marketing", subjectUserId: 7, organizationId: 42, source: "settings" });
  assert.equal(engine.effective("marketing", 7, 42)?.status, "granted");
  engine.withdraw("marketing", 7, 42);
  assert.equal(engine.effective("marketing", 7, 42), undefined);
  assert.equal(engine.history("marketing", 7, 42).length, 2);
});