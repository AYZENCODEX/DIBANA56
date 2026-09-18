/**
 * scripts/src/test-policy-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 1A: Foundation / PDP Core
 * tests.
 *
 * Same shape as scripts/src/test-oidc-client-validation.ts: DB-free,
 * runnable anywhere with nothing but
 *   npx tsx scripts/src/test-policy-engine.ts
 *
 * Covers exactly the roadmap's Phase 01 test list:
 *   - authenticated allow
 *   - unauthenticated deny
 *   - invalid context deny
 *   - evaluation failure deny
 *   - deterministic repeated evaluation
 *   - correlation ID propagation
 * plus deny-overrides precedence, since that's the combining algorithm the
 * engine promises and nothing else in this file would catch a regression in
 * it.
 *
 * Run: npx tsx scripts/src/test-policy-engine.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  allow,
  deny,
  type AuthorizationDecision,
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

const aliceSubject: Subject = { userId: 1, role: "user", authType: "session" };

function baseInput(overrides: Partial<BuildAuthorizationRequestInput> = {}): BuildAuthorizationRequestInput {
  return {
    subject: aliceSubject,
    action: "read",
    resource: { type: "sylo.vault_item", id: 42, ownerId: 1 },
    ...overrides,
  };
}

async function main() {
  console.log("Policy Engine — Phase 1A tests");

  await test("authenticated + an allowing rule → ALLOW", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
  });

  await test("no rules registered at all → default DENY (NO_MATCHING_POLICY)", async () => {
    const engine = new PolicyEngine();
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("every rule abstains (returns null) → default DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("abstains", () => null);
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("unauthenticated subject (null) → DENY (UNAUTHENTICATED), rules never consulted", async () => {
    let called = false;
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (req) => {
      called = true;
      return allow(req, "EXPLICIT_ALLOW");
    });
    const decision = await engine.evaluate(baseInput({ subject: null }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
    assert.equal(called, false, "a rule ran for an unauthenticated request");
  });

  await test("invalid context (empty action) → DENY (INVALID_AUTHORIZATION_CONTEXT)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput({ action: "" }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "INVALID_AUTHORIZATION_CONTEXT");
  });

  await test("invalid context (malformed subject) → DENY (INVALID_AUTHORIZATION_CONTEXT)", async () => {
    const engine = new PolicyEngine();
    const decision = await engine.evaluate(
      baseInput({ subject: { userId: -1, role: "user", authType: "session" } }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "INVALID_AUTHORIZATION_CONTEXT");
  });

  await test("a throwing rule → DENY (POLICY_EVALUATION_ERROR), never propagates", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("boom", () => {
      throw new Error("simulated rule crash");
    });
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    assert.equal(decision.policyId, "boom");
  });

  await test("deny-overrides: DENY beats an earlier ALLOW regardless of registration order", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("allow-first", (req) => allow(req, "EXPLICIT_ALLOW"));
    engine.registerRule("deny-second", (req) => deny(req, "EXPLICIT_DENY"));
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "EXPLICIT_DENY");
  });

  await test("deterministic: identical input evaluated twice yields identical effect/reason", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("allow-first", (req) => allow(req, "EXPLICIT_ALLOW"));
    engine.registerRule("deny-second", (req) => deny(req, "EXPLICIT_DENY"));
    const input = baseInput({ context: { requestId: "fixed-correlation-id" } });
    const first = await engine.evaluate(input);
    const second = await engine.evaluate(input);
    assert.equal(first.effect, second.effect);
    assert.equal(first.reason, second.reason);
    assert.equal(first.requestId, second.requestId);
  });

  await test("correlation ID: a caller-supplied requestId is propagated onto the decision", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput({ context: { requestId: "trace-abc-123" } }));
    assert.equal(decision.requestId, "trace-abc-123");
  });

  await test("correlation ID: an auto-generated requestId is still propagated (non-empty, present)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (req) => allow(req, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput());
    assert.equal(typeof decision.requestId, "string");
    assert.ok(decision.requestId.length > 0);
  });

  await test("correlation ID: even an INVALID_AUTHORIZATION_CONTEXT decision carries a requestId", async () => {
    const engine = new PolicyEngine();
    const decision: AuthorizationDecision = await engine.evaluate(
      baseInput({ action: "", context: { requestId: "trace-invalid-1" } }),
    );
    assert.equal(decision.requestId, "trace-invalid-1");
  });

  console.log("\nAll Phase 1A policy engine tests passed.");
}

main().catch((err) => {
  console.error("\nPolicy engine Phase 1A test suite FAILED.");
  console.error(err);
  process.exitCode = 1;
});
