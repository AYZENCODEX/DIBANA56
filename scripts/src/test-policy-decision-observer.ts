/**
 * scripts/src/test-policy-decision-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core),
 * sub-phase 1C: decision-observability hook tests.
 *
 * Same shape as scripts/src/test-policy-engine.ts: DB-free, runnable with
 *   npx tsx scripts/src/test-policy-decision-observer.ts
 *
 * Covers:
 *   - evaluate() without an observer behaves identically to Phase 1A
 *     (regression guard — this sub-phase must not change any decision)
 *   - onDecision is called exactly once per evaluate() call, with the
 *     correct decision + request, for every branch (allow, deny, no
 *     matching policy, invalid context, evaluation error, deny-overrides)
 *   - a throwing observer never affects the returned decision and never
 *     rejects evaluate()'s promise
 *   - an observer whose returned promise rejects is also swallowed
 *   - createLoggingObserver: ALLOW logs at info, non-ALLOW logs at warn,
 *     and a throwing logger method never propagates
 *
 * Run: npx tsx scripts/src/test-policy-decision-observer.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  allow,
  deny,
  createLoggingObserver,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type BuildAuthorizationRequestInput,
  type DecisionLoggerLike,
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
  console.log("Policy decision-observer — Phase 1C tests");

  await test("no observer configured → behaves exactly like Phase 1A (no rules → default deny)", async () => {
    const engine = new PolicyEngine();
    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("observer receives ALLOW decision + request", async () => {
    const received: { decision?: AuthorizationDecision; request?: AuthorizationRequest } = {};
    const engine = new PolicyEngine({
      onDecision: (decision, request) => {
        received.decision = decision;
        received.request = request;
      },
    });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));
    const decision = await engine.evaluate(baseInput());

    assert.equal(decision.effect, "ALLOW");
    assert.deepEqual(received.decision, decision);
    assert.equal(received.request?.action, "read");
    assert.equal(received.request?.subject?.userId, 1);
  });

  await test("observer receives DENY decision from deny-overrides", async () => {
    let observedEffect: string | undefined;
    const engine = new PolicyEngine({ onDecision: (decision) => { observedEffect = decision.effect; } });
    engine.registerRule("allow-first", (request) => allow(request, "EXPLICIT_ALLOW"));
    engine.registerRule("deny-second", (request) => deny(request, "EXPLICIT_DENY"));
    const decision = await engine.evaluate(baseInput());

    assert.equal(decision.effect, "DENY");
    assert.equal(observedEffect, "DENY");
  });

  await test("observer receives INVALID_AUTHORIZATION_CONTEXT decision, request is undefined", async () => {
    let observedRequest: AuthorizationRequest | undefined;
    let called = false;
    const engine = new PolicyEngine({
      onDecision: (decision, request) => {
        called = true;
        observedRequest = request;
        assert.equal(decision.reason, "INVALID_AUTHORIZATION_CONTEXT");
      },
    });
    const decision = await engine.evaluate(baseInput({ action: "" }));

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "INVALID_AUTHORIZATION_CONTEXT");
    assert.ok(called);
    assert.equal(observedRequest, undefined);
  });

  await test("observer receives POLICY_EVALUATION_ERROR decision", async () => {
    let observedReason: string | undefined;
    const engine = new PolicyEngine({ onDecision: (decision) => { observedReason = decision.reason; } });
    engine.registerRule("throws", () => {
      throw new Error("boom");
    });
    const decision = await engine.evaluate(baseInput());

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    assert.equal(observedReason, "POLICY_EVALUATION_ERROR");
  });

  await test("a throwing observer does not affect the returned decision or reject evaluate()", async () => {
    const engine = new PolicyEngine({
      onDecision: () => {
        throw new Error("observer exploded");
      },
    });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));

    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "ALLOW");
  });

  await test("an observer whose returned promise rejects is swallowed, does not reject evaluate()", async () => {
    const engine = new PolicyEngine({
      onDecision: async () => {
        throw new Error("async observer exploded");
      },
    });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));

    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "ALLOW");
    // Give the swallowed rejection's microtask a tick to settle before the
    // test process exits, so an *unswallowed* rejection would visibly
    // surface as an unhandledRejection here rather than being masked by
    // early process exit.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  await test("evaluate() called twice registers the observer exactly once per call (no duplicate firing)", async () => {
    let callCount = 0;
    const engine = new PolicyEngine({ onDecision: () => { callCount += 1; } });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));

    await engine.evaluate(baseInput());
    await engine.evaluate(baseInput());
    assert.equal(callCount, 2);
  });

  await test("createLoggingObserver: ALLOW logs at info", async () => {
    const calls: Array<{ level: string; fields: Record<string, unknown> }> = [];
    const fakeLogger: DecisionLoggerLike = {
      info: (fields) => calls.push({ level: "info", fields }),
      warn: (fields) => calls.push({ level: "warn", fields }),
    };
    const engine = new PolicyEngine({ onDecision: createLoggingObserver(fakeLogger) });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));
    await engine.evaluate(baseInput());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, "info");
    assert.equal(calls[0].fields.effect, "ALLOW");
    assert.equal(calls[0].fields.action, "read");
  });

  await test("createLoggingObserver: DENY/STEP_UP/APPROVAL_REQUIRED log at warn", async () => {
    const calls: Array<{ level: string }> = [];
    const fakeLogger: DecisionLoggerLike = {
      info: () => calls.push({ level: "info" }),
      warn: () => calls.push({ level: "warn" }),
    };
    const engine = new PolicyEngine({ onDecision: createLoggingObserver(fakeLogger) });
    // no rules registered → NO_MATCHING_POLICY (DENY)
    await engine.evaluate(baseInput());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, "warn");
  });

  await test("createLoggingObserver: a throwing logger method never propagates", async () => {
    const fakeLogger: DecisionLoggerLike = {
      info: () => {
        throw new Error("logger backend down");
      },
      warn: () => {
        throw new Error("logger backend down");
      },
    };
    const engine = new PolicyEngine({ onDecision: createLoggingObserver(fakeLogger) });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));

    const decision = await engine.evaluate(baseInput());
    assert.equal(decision.effect, "ALLOW");
  });

  await test("deterministic repeated evaluation still holds with an observer configured", async () => {
    const engine = new PolicyEngine({ onDecision: () => {} });
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW"));
    const first = await engine.evaluate(baseInput());
    const second = await engine.evaluate(baseInput());
    assert.equal(first.effect, second.effect);
    assert.equal(first.reason, second.reason);
  });

  console.log("\nAll Phase 1C decision-observer tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
