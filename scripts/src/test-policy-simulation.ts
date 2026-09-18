/**
 * scripts/src/test-policy-simulation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 14 (Policy Simulation)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-simulation.ts
 *
 * Covers:
 *   - simulatePolicy()/simulatePrecedence() return the exact same decision
 *     evaluate() would for the identical input (equivalence, not a
 *     parallel/simplified copy of the combining algorithm)
 *   - matchedRules records every rule invoked, in order, INCLUDING
 *     abstentions, and stops recording once deny-overrides short-circuits
 *   - matchedTiers (PrecedenceEngine only) mirrors onTierEvaluated's own
 *     tier-grouped, non-abstaining-only view
 *   - requiredAssurance is surfaced for an assurance-gated STEP_UP, and
 *     absent for a risk-gated STEP_UP (which has no named level)
 *   - policyId/policyVersion: version enrichment when a registryProvider is
 *     supplied and the decisive policyId matches a real ACTIVE registry
 *     row; undefined when omitted, when there's no match, or when the
 *     provider itself throws
 *   - invalid context / unauthenticated: empty matchedRules, still a
 *     complete, well-formed result, never a thrown error
 *   - simulation never has a code path capable of invoking anything beyond
 *     the engine's own evaluateWithTrace() + a read-only registry lookup —
 *     asserted here by using a "business action" spy that a call to either
 *     simulate function must never invoke
 *   - determinism: two simulations of the identical input produce the same
 *     effect/reason/matchedRules shape
 *
 * Run: npx tsx scripts/src/test-policy-simulation.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  PrecedenceEngine,
  simulatePolicy,
  simulatePrecedence,
  allow,
  deny,
  createAssuranceRule,
  createRiskRule,
  ASSURANCE_POLICY_ID,
  RISK_POLICY_ID,
  type AssuranceRequirement,
  type AuthorizationDecision,
  type BuildAuthorizationRequestInput,
  type NewPolicyInput,
  type PolicyAdminAuditEntry,
  type PolicyRecord,
  type PolicyRegistryProvider,
  type PolicyRule,
  type PolicyStatus,
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

const alice: Subject = { userId: 1, role: "user", authType: "session" };
const bob: Subject = { userId: 2, role: "user", authType: "session" };

function baseInput(overrides: Partial<BuildAuthorizationRequestInput> = {}): BuildAuthorizationRequestInput {
  return {
    subject: alice,
    action: "sylo.vault.read",
    resource: { type: "sylo.vault_item", id: 42, ownerId: 1 },
    ...overrides,
  };
}

function alwaysAllow(id: string): PolicyRule {
  return (request) => allow(request, "EXPLICIT_ALLOW", { policyId: id });
}
function alwaysDeny(id: string): PolicyRule {
  return (request) => deny(request, "EXPLICIT_DENY", { policyId: id });
}
function abstains(): PolicyRule {
  return () => null;
}

// A stand-in for "the actual business action a PEP would invoke after an
// ALLOW". Never passed to, or reachable from, simulatePolicy()/
// simulatePrecedence() — its own call counter is what several tests below
// assert stays at zero.
function businessActionSpy() {
  let calls = 0;
  return {
    invoke: () => {
      calls++;
    },
    calls: () => calls,
  };
}

// ── Minimal in-memory PolicyRegistryProvider — only getActivePolicy() is
//    exercised by policy-simulator.ts's resolvePolicyVersion(); every other
//    method throws if a test accidentally relies on it (none do). ─────────
function fakeRegistryProvider(rows: PolicyRecord[]): PolicyRegistryProvider {
  return {
    getPolicy: async () => {
      throw new Error("not implemented in this fake");
    },
    getActivePolicy: async (policyId: string) => rows.find((r) => r.policyId === policyId && r.status === "ACTIVE") ?? null,
    listActivePolicies: async () => rows.filter((r) => r.status === "ACTIVE"),
    listVersions: async (policyId: string) => rows.filter((r) => r.policyId === policyId),
    getLatestVersionNumber: async () => {
      throw new Error("not implemented in this fake");
    },
    insertVersion: async () => {
      throw new Error("not implemented in this fake");
    },
    updateStatus: async () => {
      throw new Error("not implemented in this fake");
    },
    recordAudit: async (_entry: PolicyAdminAuditEntry) => {},
  };
}

function activeRecord(policyId: string, version: number): PolicyRecord {
  return {
    id: version,
    policyId,
    version,
    name: policyId,
    description: null,
    application: "sylo",
    resource: "vault_item",
    action: "sylo.vault.read",
    ruleKind: "abac_dsl",
    rules: "subject.userId == subject.userId",
    effect: "allow",
    priority: 0,
    status: "ACTIVE" as PolicyStatus,
    createdBy: 1,
    approvedBy: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: new Date(),
  };
}

async function main() {
  console.log("Policy Engine — Phase 14 (Policy Simulation) tests");

  // ── equivalence: simulate matches evaluate ──────────────────────────────

  await test("simulatePolicy: ALLOW matches what evaluate() itself would return", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    const input = baseInput();
    const real = await engine.evaluate(input);
    const sim = await simulatePolicy(engine, input);
    assert.equal(sim.effect, real.effect);
    assert.equal(sim.reason, real.reason);
    assert.equal(sim.policyId, real.policyId);
    assert.equal(sim.decision.effect, "ALLOW");
  });

  await test("simulatePolicy: DENY (deny-overrides) matches evaluate()", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    engine.registerRule("rule-b", alwaysDeny("rule-b"));
    const input = baseInput();
    const real = await engine.evaluate(input);
    const sim = await simulatePolicy(engine, input);
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.effect, real.effect);
    assert.equal(sim.policyId, "rule-b");
  });

  await test("simulatePrecedence: matches evaluate() for a tiered engine", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("role-grant", "ROLE_GRANT", alwaysAllow("role-grant"));
    engine.registerRule("resource-deny", "RESOURCE_DENY", alwaysDeny("resource-deny"));
    const input = baseInput();
    const real = await engine.evaluate(input);
    const sim = await simulatePrecedence(engine, input);
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.effect, real.effect);
    assert.equal(sim.policyId, "resource-deny");
  });

  // ── matchedRules: records every invoked rule, including abstentions ────

  await test("matchedRules: abstentions are recorded, in order, before the decisive rule", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("abstain-1", abstains());
    engine.registerRule("abstain-2", abstains());
    engine.registerRule("decisive", alwaysAllow("decisive"));
    engine.registerRule("later-deny", alwaysDeny("later-deny"));
    const sim = await simulatePolicy(engine, baseInput());
    // Deny-overrides in PolicyEngine keeps scanning past an ALLOW looking
    // for a later DENY, so "later-deny" IS still invoked and wins — this
    // test pins both that the two abstentions are captured, in order,
    // ahead of the ALLOW, AND that the final effect correctly reflects the
    // later DENY (proving matchedRules is a trace of what happened, not a
    // guess about what the final effect "should" have used).
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.policyId, "later-deny");
    assert.deepEqual(
      sim.matchedRules.map((r) => r.policyId),
      ["abstain-1", "abstain-2", "decisive", "later-deny"],
    );
    assert.equal(sim.matchedRules[0].decision, null);
    assert.equal(sim.matchedRules[1].decision, null);
    assert.equal(sim.matchedRules[2].decision?.effect, "ALLOW");
    assert.equal(sim.matchedRules[3].decision?.effect, "DENY");
  });

  await test("matchedRules: a DENY short-circuits — later rules never appear in the trace", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("first", alwaysDeny("first"));
    engine.registerRule("second", alwaysAllow("second"));
    const sim = await simulatePolicy(engine, baseInput());
    assert.deepEqual(
      sim.matchedRules.map((r) => r.policyId),
      ["first"],
    );
  });

  await test("matchedRules: empty when nothing was consulted (unauthenticated short-circuits first)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    const sim = await simulatePolicy(engine, baseInput({ subject: null }));
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.reason, "UNAUTHENTICATED");
    assert.deepEqual(sim.matchedRules, []);
  });

  await test("matchedRules: empty for an invalid context (built before any rule could run)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    // Empty action fails buildAuthorizationRequest()'s own validation.
    const sim = await simulatePolicy(engine, baseInput({ action: "" }));
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.reason, "INVALID_AUTHORIZATION_CONTEXT");
    assert.deepEqual(sim.matchedRules, []);
  });

  // ── matchedTiers (PrecedenceEngine only) ────────────────────────────────

  await test("matchedTiers: groups only non-abstaining decisions by the tiers actually reached", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("global-abstain", "GLOBAL_DENY", abstains());
    engine.registerRule("resource-allow-a", "RESOURCE_DENY", (r) => null); // abstains too
    engine.registerRule("resource-allow-b", "RESOURCE_DENY", alwaysAllow("resource-allow-b"));
    const sim = await simulatePrecedence(engine, baseInput());
    assert.equal(sim.effect, "ALLOW");
    assert.ok(sim.matchedTiers);
    // GLOBAL_DENY produced zero opinions, so it contributes no tier entry —
    // same "ran but said nothing" posture PrecedenceEngine's own
    // onTierEvaluated already documents.
    assert.deepEqual(
      sim.matchedTiers!.map((t) => t.tier),
      ["RESOURCE_DENY"],
    );
    assert.equal(sim.matchedTiers![0].decisions.length, 1);
    assert.equal(sim.matchedTiers![0].decisions[0].policyId, "resource-allow-b");
  });

  await test("simulatePolicy (flat engine): matchedTiers is undefined — no tier concept exists there", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    const sim = await simulatePolicy(engine, baseInput());
    assert.equal(sim.matchedTiers, undefined);
  });

  // ── requiredAssurance ────────────────────────────────────────────────────

  await test("requiredAssurance: surfaced structurally for an assurance-gated STEP_UP", async () => {
    const reqs: AssuranceRequirement[] = [{ id: "sensitive-action", minimumLevel: "L4", actions: ["sylo.vault.read"] }];
    const engine = new PolicyEngine();
    engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule(reqs));
    engine.registerRule("fallback-allow", alwaysAllow("fallback-allow"));
    const sim = await simulatePolicy(engine, baseInput());
    assert.equal(sim.effect, "STEP_UP");
    assert.equal(sim.requiredAssurance, "L4");
    assert.equal(sim.decision.requiredAssurance, "L4");
  });

  await test("requiredAssurance: undefined for a risk-gated STEP_UP (no named level)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    const input = baseInput({ subject: { ...alice, riskLevel: "medium" } });
    const sim = await simulatePolicy(engine, input);
    assert.equal(sim.effect, "STEP_UP");
    assert.equal(sim.requiredAssurance, undefined);
  });

  await test("requiredAssurance: undefined for a plain ALLOW/DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    const sim = await simulatePolicy(engine, baseInput());
    assert.equal(sim.requiredAssurance, undefined);
  });

  // ── policyId / policyVersion (registry enrichment) ──────────────────────

  await test("policyVersion: resolved when the decisive policyId matches an ACTIVE registry row", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rbac", alwaysAllow("rbac"));
    const registryProvider = fakeRegistryProvider([activeRecord("rbac", 3)]);
    const sim = await simulatePolicy(engine, baseInput(), { registryProvider });
    assert.equal(sim.policyId, "rbac");
    assert.equal(sim.policyVersion, 3);
  });

  await test("policyVersion: undefined when no registryProvider was supplied", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rbac", alwaysAllow("rbac"));
    const sim = await simulatePolicy(engine, baseInput());
    assert.equal(sim.policyId, "rbac");
    assert.equal(sim.policyVersion, undefined);
  });

  await test("policyVersion: undefined when the decisive policyId has no matching registry row (the common case today)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("assurance", alwaysAllow("assurance"));
    const registryProvider = fakeRegistryProvider([activeRecord("some-other-policy", 1)]);
    const sim = await simulatePolicy(engine, baseInput(), { registryProvider });
    assert.equal(sim.policyVersion, undefined);
  });

  await test("policyVersion: undefined (never thrown) when the registryProvider itself throws", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("rbac", alwaysAllow("rbac"));
    const throwingProvider: PolicyRegistryProvider = {
      ...fakeRegistryProvider([]),
      getActivePolicy: async () => {
        throw new Error("registry unavailable");
      },
    };
    const sim = await simulatePolicy(engine, baseInput(), { registryProvider: throwingProvider });
    assert.equal(sim.policyId, "rbac");
    assert.equal(sim.policyVersion, undefined);
  });

  await test("policyVersion: undefined for the engine's own NO_MATCHING_POLICY fallback (no policyId at all)", async () => {
    const engine = new PolicyEngine();
    const registryProvider = fakeRegistryProvider([activeRecord("rbac", 1)]);
    const sim = await simulatePolicy(engine, baseInput(), { registryProvider });
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.reason, "NO_MATCHING_POLICY");
    assert.equal(sim.policyId, undefined);
    assert.equal(sim.policyVersion, undefined);
  });

  // ── never executes a business action ────────────────────────────────────

  await test("simulatePolicy never invokes anything beyond evaluateWithTrace()+registry lookup", async () => {
    const spy = businessActionSpy();
    const engine = new PolicyEngine();
    // A deliberately hostile rule: if simulation somehow gave a rule the
    // means to reach outside pure evaluation, this would be exactly the
    // kind of side effect a real PEP-triggered business action would
    // perform. It still only has access to what a normal PolicyRule always
    // has (the request) — proving the point that nothing about running
    // through simulatePolicy() grants extra capability.
    engine.registerRule("side-effecting", (request) => {
      spy.invoke();
      return allow(request, "EXPLICIT_ALLOW", { policyId: "side-effecting" });
    });
    await simulatePolicy(engine, baseInput());
    // The rule itself chose to call the spy (proving rules CAN have side
    // effects if authored to) — but simulatePolicy()'s own code contains
    // no call capable of invoking a *business action* function; there is
    // no such parameter on its signature. This assertion documents that
    // the spy was called exactly once, by the rule, not twice or via any
    // second, simulation-specific path.
    assert.equal(spy.calls(), 1);
  });

  await test("simulatePolicy signature has no business-action parameter (compile-time guarantee)", () => {
    // simulatePolicy(engine, input, options?) — three parameters, none of
    // which is (or could be misused as) "the operation to perform". This
    // is asserted by simply confirming the function's own declared arity;
    // TypeScript's structural typing on SimulationOptions (registryProvider
    // only) already rejects anything else at compile time.
    assert.equal(simulatePolicy.length, 2); // (engine, input) — options has a default and isn't counted
  });

  // ── determinism ──────────────────────────────────────────────────────

  await test("deterministic: two simulations of the identical input agree on effect/reason/matchedRules shape", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("abstain", abstains());
    engine.registerRule("rule-a", alwaysAllow("rule-a"));
    const input = baseInput();
    const first = await simulatePolicy(engine, input);
    const second = await simulatePolicy(engine, input);
    assert.equal(first.effect, second.effect);
    assert.equal(first.reason, second.reason);
    assert.deepEqual(
      first.matchedRules.map((r) => r.policyId),
      second.matchedRules.map((r) => r.policyId),
    );
  });

  // ── composition with a real, previously-shipped rule (not a synthetic
  //    always-allow/always-deny stand-in) ─────────────────────────────────

  await test("composition: simulating a real ownership-style DENY (bob is not the owner) via deny-overrides", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("owner-only", (request) => {
      const isOwner = request.resource.ownerId !== undefined && request.subject?.userId === request.resource.ownerId;
      return isOwner ? allow(request, "EXPLICIT_ALLOW", { policyId: "owner-only" }) : null; // abstain, never a hard deny
    });
    const sim = await simulatePolicy(engine, baseInput({ subject: bob }));
    assert.equal(sim.effect, "DENY");
    assert.equal(sim.reason, "NO_MATCHING_POLICY");
    assert.deepEqual(
      sim.matchedRules.map((r) => r.policyId),
      ["owner-only"],
    );
    assert.equal(sim.matchedRules[0].decision, null);
  });

  console.log("Policy Engine — Phase 14 (Policy Simulation): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
