/**
 * scripts/src/test-policy-audit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-audit.ts
 *
 * Uses an in-memory `FakeAuditWriter` (implements the same
 * `AuthorizationAuditWriter` interface `DrizzleAuthorizationAuditWriter`
 * does) — same "one shared interface, real provider + fake provider both
 * honor it" shape every prior Drizzle-adjacent phase's own test file
 * already establishes (see e.g. test-policy-registry.ts's header).
 *
 * Covers:
 *   - toAuditEntry(): product derivation from a real "product.resource.
 *     action" key, undefined for an opaque Phase-01-style action
 *   - toAuditEntry(): subject reference fields populated from a real
 *     Subject, and left undefined (not thrown) for an unauthenticated
 *     request (request undefined entirely, and request.subject === null)
 *   - toAuditEntry(): policyId/policyVersion/requiredAssurance/risk/
 *     assuranceMethods passthrough, each independently absent when not on
 *     the source decision/request
 *   - toAuditEntry(): assuranceMethods is undefined (not []) for a subject
 *     with an empty array on file
 *   - toAuditEntry(): decisionId is always populated (a fresh, distinct
 *     value each call) and requestId/timestamp/reasonCode/decision are
 *     always copied verbatim
 *   - toAuditEntry(): never includes ip/sessionId/scopes anywhere on the
 *     built entry, even when the source request/subject carry them
 *   - end-to-end via a real PolicyEngine wired with
 *     createAuthorizationAuditObserver(): exactly one audit row written
 *     per evaluate() call, for ALLOW, DENY, STEP_UP, and
 *     APPROVAL_REQUIRED effects alike, and for an UNAUTHENTICATED
 *     (subject: null) request too
 *   - the written row's latencyMs is a present, non-negative number
 *     (Phase 17's engine-level `stampLatency()` addition)
 *   - a throwing writer never surfaces as, or blocks, evaluate()'s own
 *     resolved decision (fail-closed posture preserved: the AUTHORIZATION
 *     decision itself is completely unaffected by an audit-write failure)
 *   - two engines, one with the audit observer wired and one without,
 *     produce byte-for-byte identical decisions (minus latencyMs's own
 *     natural jitter) for the same input — wiring an audit observer must
 *     never change what is authorized
 *
 * Run: npx tsx scripts/src/test-policy-audit.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  allow,
  deny,
  stepUp,
  approvalRequired,
  toAuditEntry,
  createAuthorizationAuditObserver,
  type AuthorizationAuditEntry,
  type AuthorizationAuditWriter,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type BuildAuthorizationRequestInput,
  type Subject,
} from "../../artifacts/api-server/src/lib/policy";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

class FakeAuditWriter implements AuthorizationAuditWriter {
  entries: AuthorizationAuditEntry[] = [];
  async write(entry: AuthorizationAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class ThrowingAuditWriter implements AuthorizationAuditWriter {
  async write(): Promise<void> {
    throw new Error("simulated audit backend outage");
  }
}

const aliceSubject: Subject = {
  userId: 1,
  role: "user",
  authType: "session",
  organizationId: 7,
  scopes: ["should", "never", "appear", "on", "an", "audit", "entry"],
  riskLevel: "medium",
  assuranceMethods: ["password", "totp"],
};

function baseInput(overrides: Partial<BuildAuthorizationRequestInput> = {}): BuildAuthorizationRequestInput {
  return {
    subject: aliceSubject,
    action: "sylo.vault.read",
    resource: { type: "sylo.vault_item", id: 42, ownerId: 1 },
    context: { ip: "203.0.113.9", sessionId: "sess-secret-1" },
    ...overrides,
  };
}

/** Minimal decision/request pair builder for the pure toAuditEntry() unit
 *  tests below — bypasses the engine entirely so these tests pin down
 *  toAuditEntry()'s own mapping rules in isolation. */
function buildRequest(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    subject: aliceSubject,
    action: "sylo.vault.read",
    resource: { type: "sylo.vault_item", id: 42, ownerId: 1 },
    context: { requestId: "req-fixed-1", timestamp: new Date("2026-01-01T00:00:00Z"), ip: "203.0.113.9", sessionId: "sess-secret-1" },
    ...overrides,
  };
}

async function main() {
  console.log("Policy Authorization Audit — Phase 17 tests");

  // ── toAuditEntry(): product derivation ──────────────────────────────────
  await test("product derived from a real product.resource.action key", () => {
    const request = buildRequest({ action: "sylo.vault.read" });
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.product, "sylo");
    assert.equal(entry.action, "sylo.vault.read");
  });

  await test("product is undefined for an opaque, non-grammar action", () => {
    const request = buildRequest({ action: "read" });
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.product, undefined);
  });

  await test("product is undefined for a malformed 3-segment action (invalid characters)", () => {
    const request = buildRequest({ action: "Sylo.Vault.READ" });
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.product, undefined);
  });

  // ── toAuditEntry(): subject reference ───────────────────────────────────
  await test("subject reference fields populated from a real Subject", () => {
    const request = buildRequest();
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.subjectUserId, 1);
    assert.equal(entry.subjectRole, "user");
    assert.equal(entry.subjectAuthType, "session");
    assert.equal(entry.subjectOrganizationId, 7);
  });

  await test("subject reference fields are all undefined when request is undefined entirely", () => {
    const decision: AuthorizationDecision = {
      effect: "DENY",
      reason: "INVALID_AUTHORIZATION_CONTEXT",
      requestId: "req-invalid-1",
      evaluatedAt: new Date(),
    };
    const entry = toAuditEntry(decision, undefined);
    assert.equal(entry.subjectUserId, undefined);
    assert.equal(entry.subjectRole, undefined);
    assert.equal(entry.subjectAuthType, undefined);
    assert.equal(entry.product, undefined);
    assert.equal(entry.resourceType, undefined);
    assert.equal(entry.action, undefined);
    assert.equal(entry.requestId, "req-invalid-1");
  });

  await test("subject reference fields are all undefined for an unauthenticated (subject: null) request", () => {
    const request = buildRequest({ subject: null });
    const decision = deny(request, "UNAUTHENTICATED");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.subjectUserId, undefined);
    assert.equal(entry.subjectRole, undefined);
    // resource/action are still captured — the request itself was valid,
    // only the subject was absent.
    assert.equal(entry.action, "sylo.vault.read");
  });

  // ── toAuditEntry(): passthrough fields ───────────────────────────────────
  await test("policyId/policyVersion passthrough from the decision", () => {
    const request = buildRequest();
    const decision = allow(request, "EXPLICIT_ALLOW", { policyId: "rbac.sylo.vault.read", policyVersion: 3 });
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.policyId, "rbac.sylo.vault.read");
    assert.equal(entry.policyVersion, 3);
  });

  await test("policyId/policyVersion are undefined when absent on the decision", () => {
    const request = buildRequest();
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.policyId, undefined);
    assert.equal(entry.policyVersion, undefined);
  });

  await test("requiredAssurance passthrough for a STEP_UP decision", () => {
    const request = buildRequest();
    const decision = stepUp(request, { requiredAssurance: "L3" });
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.decision, "STEP_UP");
    assert.equal(entry.requiredAssurance, "L3");
  });

  await test("risk copied from subject.riskLevel", () => {
    const request = buildRequest();
    const decision = deny(request, "HIGH_RISK_DENIED");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.risk, "medium");
  });

  await test("risk is undefined when the subject has no riskLevel on file", () => {
    const request = buildRequest({ subject: { userId: 1, role: "user", authType: "session" } });
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.risk, undefined);
  });

  await test("assuranceMethods copied (as a fresh array) from a subject that has some on file", () => {
    const request = buildRequest();
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.deepEqual(entry.assuranceMethods, ["password", "totp"]);
  });

  await test("assuranceMethods is undefined (not []) for a subject with an empty array on file", () => {
    const request = buildRequest({ subject: { ...aliceSubject, assuranceMethods: [] } });
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.assuranceMethods, undefined);
  });

  await test("approvalRequired() decisions map to decision: APPROVAL_REQUIRED", () => {
    const request = buildRequest();
    const decision = approvalRequired(request, { policyId: "approval.ryft.payment.approve" });
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.decision, "APPROVAL_REQUIRED");
    assert.equal(entry.reasonCode, "APPROVAL_REQUIRED");
  });

  // ── toAuditEntry(): identity + timestamp fields ─────────────────────────
  await test("decisionId is populated and distinct across two calls for the same decision", () => {
    const request = buildRequest();
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entryA = toAuditEntry(decision, request);
    const entryB = toAuditEntry(decision, request);
    assert.equal(typeof entryA.decisionId, "string");
    assert.ok(entryA.decisionId.length > 0);
    assert.notEqual(entryA.decisionId, entryB.decisionId);
  });

  await test("requestId/timestamp/reasonCode copied verbatim from the decision", () => {
    const request = buildRequest();
    const decision = deny(request, "RESOURCE_LOCKED");
    const entry = toAuditEntry(decision, request);
    assert.equal(entry.requestId, decision.requestId);
    assert.equal(entry.timestamp, decision.evaluatedAt);
    assert.equal(entry.reasonCode, "RESOURCE_LOCKED");
  });

  // ── toAuditEntry(): never leaks sensitive data ──────────────────────────
  await test("never carries ip/sessionId/scopes anywhere on the built entry", () => {
    const request = buildRequest();
    const decision = allow(request, "EXPLICIT_ALLOW");
    const entry = toAuditEntry(decision, request) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("203.0.113.9"), "must not leak ip");
    assert.ok(!serialized.includes("sess-secret-1"), "must not leak sessionId");
    assert.ok(!serialized.includes("should"), "must not leak subject.scopes");
    assert.equal("ip" in entry, false);
    assert.equal("sessionId" in entry, false);
    assert.equal("scopes" in entry, false);
  });

  // ── End-to-end via a real PolicyEngine ──────────────────────────────────
  await test("end-to-end: one audit row per evaluate() call, for ALLOW", async () => {
    const writer = new FakeAuditWriter();
    const engine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(writer) });
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput());
    // notifyObserver() is fire-and-forget; give the microtask queue one
    // tick so the (synchronously-resolving) fake writer's write() lands.
    await Promise.resolve();
    assert.equal(decision.effect, "ALLOW");
    assert.equal(writer.entries.length, 1);
    assert.equal(writer.entries[0].decision, "ALLOW");
    assert.equal(writer.entries[0].requestId, decision.requestId);
  });

  await test("end-to-end: DENY, STEP_UP, APPROVAL_REQUIRED, and UNAUTHENTICATED each produce exactly one row", async () => {
    const cases: Array<{ label: string; rule: (req: AuthorizationRequest) => AuthorizationDecision | null; input?: Partial<BuildAuthorizationRequestInput>; expected: string }> = [
      { label: "deny", rule: (req) => deny(req, "EXPLICIT_DENY"), expected: "DENY" },
      { label: "stepUp", rule: (req) => stepUp(req, { requiredAssurance: "L3" }), expected: "STEP_UP" },
      { label: "approval", rule: (req) => approvalRequired(req), expected: "APPROVAL_REQUIRED" },
    ];
    for (const c of cases) {
      const writer = new FakeAuditWriter();
      const engine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(writer) });
      engine.registerRule(c.label, c.rule);
      await engine.evaluate(baseInput());
      await Promise.resolve();
      assert.equal(writer.entries.length, 1, `${c.label}: expected exactly one audit row`);
      assert.equal(writer.entries[0].decision, c.expected, `${c.label}: wrong decision on audit row`);
    }

    // Unauthenticated: no rule ever runs, engine short-circuits before the
    // rule loop — an audit row must still be written (Rule 10).
    const writer = new FakeAuditWriter();
    const engine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(writer) });
    await engine.evaluate(baseInput({ subject: null }));
    await Promise.resolve();
    assert.equal(writer.entries.length, 1);
    assert.equal(writer.entries[0].decision, "DENY");
    assert.equal(writer.entries[0].reasonCode, "UNAUTHENTICATED");
    assert.equal(writer.entries[0].subjectUserId, undefined);
  });

  await test("written row's latencyMs is a present, non-negative number", async () => {
    const writer = new FakeAuditWriter();
    const engine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(writer) });
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    await engine.evaluate(baseInput());
    await Promise.resolve();
    const entry = writer.entries[0];
    assert.equal(typeof entry.latencyMs, "number");
    assert.ok((entry.latencyMs as number) >= 0);
  });

  // ── Fail-closed posture: a throwing writer never affects evaluate() ─────
  await test("a throwing audit writer never surfaces as, or blocks, evaluate()'s own decision", async () => {
    const engine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(new ThrowingAuditWriter()) });
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
  });

  await test("a throwing audit writer does not affect a DENY decision either", async () => {
    const engine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(new ThrowingAuditWriter()) });
    engine.registerRule("always-deny", (req) => deny(req, "EXPLICIT_DENY"));
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "DENY");
  });

  // ── Wiring the audit observer never changes what is authorized ─────────
  await test("wiring an audit observer does not change the decision reached, beyond latencyMs", async () => {
    const plainEngine = new PolicyEngine();
    const auditedEngine = new PolicyEngine({ onDecision: createAuthorizationAuditObserver(new FakeAuditWriter()) });
    for (const engine of [plainEngine, auditedEngine]) {
      engine.registerRule("owner-only", (req) =>
        req.resource.ownerId === req.subject?.userId ? allow(req, "EXPLICIT_ALLOW") : deny(req, "EXPLICIT_DENY"),
      );
    }
    const input = baseInput({ context: { requestId: "trace-parity-1" } });
    const a = await plainEngine.evaluate(input);
    const b = await auditedEngine.evaluate(input);
    const { latencyMs: _a, ...aRest } = a;
    const { latencyMs: _b, ...bRest } = b;
    assert.deepEqual(aRest, bRest);
  });

  console.log("\nAll Phase 17 authorization audit tests passed.");
}

main().catch((err) => {
  console.error("\nAuthorization audit Phase 17 test suite FAILED.");
  console.error(err);
  process.exitCode = 1;
});
