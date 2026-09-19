import assert from "node:assert/strict";
import test from "node:test";
import { ApiDefenseEngine, DataSecurityEngine, ThreatIntelligenceEngine } from "./index";
import { SioraRuntime } from "./runtime";

test("SIORA keeps correlation IDs and returns deterministic engine order", async () => {
  const runtime = new SioraRuntime();
  runtime.register(new DataSecurityEngine());
  runtime.register(new ApiDefenseEngine());
  const evaluation = await runtime.dispatch({
    kind: "custom",
    name: "test.action",
    context: { actor: { userId: 7 }, request: { path: "/test" } },
    data: { password: "must-not-leak" },
    trace: { traceId: "trace-test", correlationId: "corr-test" },
  });
  assert.equal(evaluation.traceId, "trace-test");
  assert.deepEqual(evaluation.results.map((item) => item.engine), ["data-security", "api-defense"]);
  assert.equal(evaluation.signals[0]?.evidence?.fields instanceof Array, true);
});

test("expired threat indicators do not match and active indicators do", async () => {
  const runtime = new SioraRuntime();
  const threats = new ThreatIntelligenceEngine();
  runtime.register(threats);
  threats.upsert({ type: "ip", value: "203.0.113.7", severity: "high", confidence: "high", source: "test" });
  threats.upsert({ type: "ip", value: "203.0.113.8", severity: "high", confidence: "high", source: "test", expiresAt: new Date(Date.now() - 1000).toISOString() });
  const active = await runtime.dispatch({
    kind: "request",
    name: "test.request",
    context: { request: { ip: "203.0.113.7" } },
    data: {},
    trace: { traceId: "trace-threat" },
  });
  const expired = await runtime.dispatch({
    kind: "request",
    name: "test.request",
    context: { request: { ip: "203.0.113.8" } },
    data: {},
    trace: { traceId: "trace-expired" },
  });
  assert.equal(active.signals.some((item) => item.code === "KNOWN_INDICATOR_MATCH"), true);
  assert.equal(expired.signals.some((item) => item.code === "KNOWN_INDICATOR_MATCH"), false);
});