/**
 * scripts/src/test-policy-batch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 20 (Batch Authorization)
 * tests.
 *
 * Same shape as scripts/src/test-policy-pep.ts: DB-free, no real Express
 * server needed, runnable anywhere with
 *   npx tsx scripts/src/test-policy-batch.ts
 *
 * Covers:
 *   - authorizeMany(): one decision per item, in input order
 *   - authorizeMany(): resolves Subject/PolicyContext exactly ONCE per
 *     batch (never once per item) — the whole point of this phase
 *   - authorizeMany(): every item shares one requestId (one logical
 *     "check this list" request)
 *   - authorizeMany(): per-item `action` override alongside a batch-level
 *     default
 *   - authorizeMany(): throws at construction (before any engine call)
 *     when an item has no resolvable action
 *   - authorizeMany(): unauthenticated req.user -> UNAUTHENTICATED deny for
 *     every item, subject null, never throws
 *   - allowedKeys(): filters to ALLOW-only keys, preserving input order
 *
 * Run: npx tsx scripts/src/test-policy-batch.ts
 */

import assert from "node:assert/strict";
import type { Request } from "express";
import {
  PolicyEngine,
  PolicyInformationPoint,
  allow,
  deny,
  authorizeMany,
  allowedKeys,
  type Subject,
  type SubjectProvider,
  type SessionProvider,
  type AuthenticatedUserLike,
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

function fakeRequest(overrides: { user?: unknown; headers?: Record<string, string> } = {}): Request {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    ip: "203.0.113.5",
  } as unknown as Request;
}

async function main() {
  console.log("Policy Batch Authorization — Phase 20 tests");

  // ── Basic shape: one decision per item, in order ──────────────────────

  await test("authorizeMany(): even-id items ALLOW, odd-id items DENY, one result per item in order", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("even-only", (request) => {
      const id = Number((request.resource as { id?: string }).id);
      return id % 2 === 0 ? allow(request, "EXPLICIT_ALLOW") : deny(request, "EXPLICIT_DENY");
    });
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const outcome = await authorizeMany({
      req,
      engine,
      action: "marketplace.listing.edit",
      items: [
        { key: "1", resource: { type: "marketplace.listing", id: "1" } },
        { key: "2", resource: { type: "marketplace.listing", id: "2" } },
        { key: "3", resource: { type: "marketplace.listing", id: "3" } },
        { key: "4", resource: { type: "marketplace.listing", id: "4" } },
      ],
    });
    assert.equal(outcome.results.length, 4);
    assert.deepEqual(
      outcome.results.map((r) => r.key),
      ["1", "2", "3", "4"],
    );
    assert.deepEqual(
      outcome.results.map((r) => r.decision.effect),
      ["DENY", "ALLOW", "DENY", "ALLOW"],
    );
    assert.equal(outcome.subject?.userId, 1);
  });

  // ── The whole point of this phase: one subject/context resolution ─────

  await test("authorizeMany(): resolves Subject/PolicyContext exactly once per batch, not once per item", async () => {
    let getSubjectCalls = 0;
    let getSessionRecordCalls = 0;
    const subjectProvider: SubjectProvider = {
      async getSubject(user: AuthenticatedUserLike | null | undefined): Promise<Subject | null> {
        getSubjectCalls += 1;
        if (!user) return null;
        return { userId: user.userId, role: user.role, authType: user.authType };
      },
    };
    const sessionProvider: SessionProvider = {
      async getSessionRecord(jti: string) {
        getSessionRecordCalls += 1;
        return { jti, createdAt: new Date(Date.now() - 60_000) };
      },
    };
    const pip = new PolicyInformationPoint({ subject: subjectProvider, session: sessionProvider });
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => allow(request, "EXPLICIT_ALLOW"));
    const req = fakeRequest({ user: { userId: 7, role: "user", authType: "session" } });
    const outcome = await authorizeMany({
      req,
      engine,
      action: "sylo.vault.read",
      enrichment: { pip, sessionId: () => "sess-123" },
      items: Array.from({ length: 25 }, (_, i) => ({
        key: i,
        resource: { type: "sylo.vault_item", id: String(i) },
      })),
    });
    assert.equal(outcome.results.length, 25);
    assert.equal(getSubjectCalls, 1, "SubjectProvider.getSubject must be called exactly once per batch");
    assert.equal(getSessionRecordCalls, 1, "SessionProvider.getSessionRecord must be called exactly once per batch");
    assert.ok(outcome.results.every((r) => r.decision.effect === "ALLOW"));
  });

  // ── One shared requestId across the whole batch ────────────────────────

  await test("authorizeMany(): every item's decision shares the same requestId", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => allow(request, "EXPLICIT_ALLOW"));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const outcome = await authorizeMany({
      req,
      engine,
      action: "sylo.vault.read",
      items: [
        { key: "a", resource: { type: "sylo.vault_item", id: "a" } },
        { key: "b", resource: { type: "sylo.vault_item", id: "b" } },
      ],
    });
    const [first, second] = outcome.results;
    assert.equal(first.decision.requestId, second.decision.requestId);
  });

  // ── Per-item action override alongside a batch-level default ──────────

  await test("authorizeMany(): per-item action overrides the batch default", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("action-gate", (request) =>
      request.action === "sylo.vault.approve"
        ? deny(request, "EXPLICIT_DENY")
        : allow(request, "EXPLICIT_ALLOW"),
    );
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const outcome = await authorizeMany({
      req,
      engine,
      action: "sylo.vault.read",
      items: [
        { key: "read-one", resource: { type: "sylo.vault_item", id: "1" } },
        { key: "approve-one", action: "sylo.vault.approve", resource: { type: "sylo.vault_item", id: "1" } },
      ],
    });
    assert.equal(outcome.results[0].decision.effect, "ALLOW");
    assert.equal(outcome.results[1].decision.effect, "DENY");
  });

  // ── Construction-time failure, before any engine call ──────────────────

  await test("authorizeMany(): item with no resolvable action throws before evaluating anything", async () => {
    const engine = new PolicyEngine();
    let evaluateCalls = 0;
    const countingEngine = {
      evaluate: async (input: Parameters<typeof engine.evaluate>[0]) => {
        evaluateCalls += 1;
        return engine.evaluate(input);
      },
    };
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    await assert.rejects(
      () =>
        authorizeMany({
          req,
          engine: countingEngine,
          items: [{ key: "no-action", resource: { type: "sylo.vault_item", id: "1" } }],
        }),
      /has no "action"/,
    );
    assert.equal(evaluateCalls, 0);
  });

  // ── Unauthenticated: every item denies, never throws ───────────────────

  await test("authorizeMany(): unauthenticated req.user -> UNAUTHENTICATED deny for every item", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => allow(request, "EXPLICIT_ALLOW"));
    const req = fakeRequest();
    const outcome = await authorizeMany({
      req,
      engine,
      action: "sylo.vault.read",
      items: [
        { key: "1", resource: { type: "sylo.vault_item", id: "1" } },
        { key: "2", resource: { type: "sylo.vault_item", id: "2" } },
      ],
    });
    assert.equal(outcome.subject, null);
    assert.ok(outcome.results.every((r) => r.decision.effect === "DENY" && r.decision.reason === "UNAUTHENTICATED"));
  });

  // ── allowedKeys() convenience filter ────────────────────────────────────

  await test("allowedKeys(): returns only ALLOW keys, preserving input order", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("even-only", (request) => {
      const id = Number((request.resource as { id?: string }).id);
      return id % 2 === 0 ? allow(request, "EXPLICIT_ALLOW") : deny(request, "EXPLICIT_DENY");
    });
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const outcome = await authorizeMany({
      req,
      engine,
      action: "marketplace.listing.edit",
      items: [1, 2, 3, 4, 5, 6].map((n) => ({ key: n, resource: { type: "marketplace.listing", id: String(n) } })),
    });
    assert.deepEqual(allowedKeys(outcome), [2, 4, 6]);
  });

  console.log("\nAll Phase 20 batch authorization tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
