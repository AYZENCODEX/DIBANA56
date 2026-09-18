/**
 * scripts/src/test-policy-abac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 05 (ABAC) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-abac.ts
 *
 * Covers, in order:
 *   1. operators.ts — pure comparison-function unit tests, including the
 *      "boundary conditions" the roadmap's Phase 05 section explicitly
 *      calls for (falsy-but-present values, incomparable types, malformed
 *      `in`/`notIn` right-hand sides, ISO-string vs Date equivalence).
 *   2. attribute-resolver.ts — resolveAttributes()/getAttribute() shape and
 *      dot-path lookup, including unknown/malformed paths.
 *   3. condition-evaluator.ts — AND/OR/NOT composition, including the
 *      documented empty-AND (vacuously true) / empty-OR (vacuously false)
 *      boundary cases.
 *   4. abac-rule.ts — the roadmap's declarative test model (GIVEN
 *      subject+resource+context / WHEN action / THEN decision): happy path,
 *      negative path, deny-overrides-within-the-rule, action-pattern
 *      scoping, and abstention.
 *   5. Phase 22-style security suites: IDOR / resource-ID substitution
 *      (conditions keyed to a concrete resource id/attribute do not leak to
 *      a substituted one), privilege escalation (forging unrelated fields
 *      or relabeling the action does not manufacture a match), and
 *      composition with earlier phases (an ABAC allow does not override an
 *      RBAC/ownership/ReBAC/resource-grant deny, regardless of
 *      registration order).
 *
 * Run: npx tsx scripts/src/test-policy-abac.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createAbacRule,
  createResourceOwnershipRule,
  createLockedResourceRule,
  createExplicitResourceGrantRule,
  evaluateOperator,
  valuesEqual,
  evaluateAbacCondition,
  resolveAttributes,
  getAttribute,
  ABAC_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  LOCKED_RESOURCE_POLICY_ID,
  RESOURCE_GRANT_POLICY_ID,
  type Subject,
  type ResourceRef,
  type PolicyContext,
  type ResourceGrantProvider,
  type ResourceGrantEntry,
  type BuildAuthorizationRequestInput,
  type AbacPolicyDefinition,
  type AbacCondition,
} from "../../artifacts/api-server/src/lib/policy";
import { createPolicyContext } from "../../artifacts/api-server/src/lib/policy/policy-context";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

class FakeResourceGrantProvider implements ResourceGrantProvider {
  private readonly grants = new Map<string, ResourceGrantEntry>();
  private key(subjectUserId: number, resourceType: string, resourceId: string, action: string): string {
    return `${subjectUserId}::${resourceType}::${resourceId}::${action}`;
  }
  setGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string, entry: ResourceGrantEntry): void {
    this.grants.set(this.key(subjectUserId, resourceType, resourceId, action), entry);
  }
  async getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantEntry | null> {
    return this.grants.get(this.key(subjectUserId, resourceType, resourceId, action)) ?? null;
  }
}

function buildInput(subject: Subject | null, action: string, resource: ResourceRef): BuildAuthorizationRequestInput {
  return { subject, action, resource };
}

const bob: Subject = { userId: 2, role: "user", authType: "session" };
const alice: Subject = { userId: 1, role: "user", authType: "session" };

async function main() {
  console.log("Policy Engine — Phase 05 (ABAC) tests");

  // ── operators.ts — pure unit tests ─────────────────────────────────────

  await test("equals/notEquals on plain values", () => {
    assert.equal(evaluateOperator("equals", "admin", "admin"), true);
    assert.equal(evaluateOperator("equals", "admin", "user"), false);
    assert.equal(evaluateOperator("notEquals", "admin", "user"), true);
    assert.equal(evaluateOperator("notEquals", "admin", "admin"), false);
  });

  await test("exists/notExists treat falsy-but-present values as present (boundary)", () => {
    assert.equal(evaluateOperator("exists", 0, undefined), true);
    assert.equal(evaluateOperator("exists", false, undefined), true);
    assert.equal(evaluateOperator("exists", "", undefined), true);
    assert.equal(evaluateOperator("exists", null, undefined), false);
    assert.equal(evaluateOperator("exists", undefined, undefined), false);
    assert.equal(evaluateOperator("notExists", null, undefined), true);
    assert.equal(evaluateOperator("notExists", 0, undefined), false);
  });

  await test("every non-exists operator fails closed (false, never throws) on a missing attribute", () => {
    for (const op of ["equals", "notEquals", "greaterThan", "lessThan", "in", "notIn", "before", "after"] as const) {
      assert.doesNotThrow(() => evaluateOperator(op, undefined, "x"));
      assert.equal(evaluateOperator(op, undefined, "x"), false);
      assert.doesNotThrow(() => evaluateOperator(op, null, "x"));
      assert.equal(evaluateOperator(op, null, "x"), false);
    }
  });

  await test("greaterThan/lessThan family on numbers, including equal-boundary cases", () => {
    assert.equal(evaluateOperator("greaterThan", 5, 3), true);
    assert.equal(evaluateOperator("greaterThan", 3, 5), false);
    assert.equal(evaluateOperator("greaterThan", 5, 5), false); // boundary: strict, equal does not count
    assert.equal(evaluateOperator("greaterThanOrEqual", 5, 5), true); // boundary: equal does count
    assert.equal(evaluateOperator("lessThan", 3, 5), true);
    assert.equal(evaluateOperator("lessThanOrEqual", 5, 5), true);
  });

  await test("comparisons fail closed (false) on incomparable types, never throw", () => {
    assert.doesNotThrow(() => evaluateOperator("greaterThan", "not-a-number", 5));
    assert.equal(evaluateOperator("greaterThan", "not-a-number", 5), false);
    assert.equal(evaluateOperator("greaterThan", true, false), false); // booleans not orderable
    assert.equal(evaluateOperator("greaterThan", ["a"], 1), false); // arrays not orderable
  });

  await test("in/notIn: membership by value, and fails closed on a non-array right-hand side", () => {
    assert.equal(evaluateOperator("in", "b", ["a", "b", "c"]), true);
    assert.equal(evaluateOperator("in", "z", ["a", "b", "c"]), false);
    assert.equal(evaluateOperator("notIn", "z", ["a", "b", "c"]), true);
    assert.doesNotThrow(() => evaluateOperator("in", "z", "not-an-array" as never));
    assert.equal(evaluateOperator("in", "z", "not-an-array" as never), false);
  });

  await test("before/after: Date-vs-Date, and Date-vs-ISO-string equivalence", () => {
    const now = new Date("2026-09-07T00:00:00.000Z");
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(evaluateOperator("after", now, earlier), true);
    assert.equal(evaluateOperator("before", earlier, now), true);
    assert.equal(evaluateOperator("after", now, "2026-01-01T00:00:00.000Z"), true);
    assert.equal(evaluateOperator("before", now, earlier), false);
  });

  await test("valuesEqual: Date and equivalent ISO string compare equal; arrays compare element-wise", () => {
    assert.equal(valuesEqual(new Date("2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z"), true);
    assert.equal(valuesEqual(["a", "b"], ["a", "b"]), true);
    assert.equal(valuesEqual(["a", "b"], ["a", "c"]), false);
    assert.equal(valuesEqual(["a", "b"], ["a"]), false); // length mismatch
    assert.equal(valuesEqual(["a"], "a"), false); // array vs scalar never equal
  });

  // ── attribute-resolver.ts ───────────────────────────────────────────────

  function buildContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
    return createPolicyContext({ ...overrides });
  }

  await test("resolveAttributes() maps subject/resource/context fields into the expected groups", () => {
    const subject: Subject = { userId: 2, role: "user", authType: "session", riskLevel: "medium", verificationLevel: "email_verified" };
    const resource: ResourceRef = { type: "sylo.vault_item", id: 42, sensitivity: "high" };
    const context = buildContext({ sessionAgeSeconds: 120, deviceTrust: "trusted" });
    const bag = resolveAttributes(subject, resource, context, "sylo.vault.read");
    assert.equal(bag.action, "sylo.vault.read");
    assert.equal(bag.subject.userId, 2);
    assert.equal(bag.subject.riskLevel, "medium");
    assert.equal(bag.resource.sensitivity, "high");
    assert.equal(bag.environment.sessionAgeSeconds, 120);
    assert.equal(bag.environment.deviceTrust, "trusted");
  });

  await test("getAttribute(): dot-path lookup, including the bare 'action' path", () => {
    const bag = resolveAttributes(
      { userId: 2, role: "user", authType: "session" },
      { type: "sylo.vault_item", id: 42 },
      buildContext(),
      "sylo.vault.read",
    );
    assert.equal(getAttribute(bag, "action"), "sylo.vault.read");
    assert.equal(getAttribute(bag, "subject.userId"), 2);
    assert.equal(getAttribute(bag, "resource.type"), "sylo.vault_item");
  });

  await test("getAttribute(): unknown group, unknown field, and malformed paths all return undefined, never throw", () => {
    const bag = resolveAttributes(
      { userId: 2, role: "user", authType: "session" },
      { type: "sylo.vault_item", id: 42 },
      buildContext(),
      "sylo.vault.read",
    );
    assert.equal(getAttribute(bag, "nope.field"), undefined);
    assert.equal(getAttribute(bag, "subject.notARealField"), undefined);
    assert.equal(getAttribute(bag, "subject."), undefined);
    assert.equal(getAttribute(bag, ".userId"), undefined);
    assert.equal(getAttribute(bag, "subject"), undefined); // no field segment at all
    assert.equal(getAttribute(bag, "subject.__proto__"), undefined); // not a real own field
  });

  // ── condition-evaluator.ts ──────────────────────────────────────────────

  const sampleBag = resolveAttributes(
    { userId: 2, role: "user", authType: "session", riskLevel: "medium", verificationLevel: "email_verified" },
    { type: "sylo.vault_item", id: 42, sensitivity: "high" },
    buildContext({ sessionAgeSeconds: 120 }),
    "sylo.vault.read",
  );

  await test("boundary: an empty AND is vacuously true", () => {
    assert.equal(evaluateAbacCondition({ kind: "and", conditions: [] }, sampleBag), true);
  });

  await test("boundary: an empty OR is vacuously false", () => {
    assert.equal(evaluateAbacCondition({ kind: "or", conditions: [] }, sampleBag), false);
  });

  await test("AND requires every condition; OR requires at least one; NOT inverts", () => {
    const trueCond: AbacCondition = { kind: "comparison", attribute: "resource.sensitivity", operator: "equals", value: "high" };
    const falseCond: AbacCondition = { kind: "comparison", attribute: "resource.sensitivity", operator: "equals", value: "low" };
    assert.equal(evaluateAbacCondition({ kind: "and", conditions: [trueCond, trueCond] }, sampleBag), true);
    assert.equal(evaluateAbacCondition({ kind: "and", conditions: [trueCond, falseCond] }, sampleBag), false);
    assert.equal(evaluateAbacCondition({ kind: "or", conditions: [falseCond, trueCond] }, sampleBag), true);
    assert.equal(evaluateAbacCondition({ kind: "or", conditions: [falseCond, falseCond] }, sampleBag), false);
    assert.equal(evaluateAbacCondition({ kind: "not", condition: falseCond }, sampleBag), true);
    assert.equal(evaluateAbacCondition({ kind: "not", condition: trueCond }, sampleBag), false);
  });

  await test("nested composition: AND(comparison, NOT(comparison)) evaluates correctly", () => {
    const condition: AbacCondition = {
      kind: "and",
      conditions: [
        { kind: "comparison", attribute: "resource.sensitivity", operator: "equals", value: "high" },
        { kind: "not", condition: { kind: "comparison", attribute: "subject.verificationLevel", operator: "equals", value: "identity_verified" } },
      ],
    };
    assert.equal(evaluateAbacCondition(condition, sampleBag), true); // sensitive + not identity-verified
  });

  // ── abac-rule.ts — declarative GIVEN/WHEN/THEN ─────────────────────────

  const denySensitiveUnverified: AbacPolicyDefinition = {
    id: "deny-sensitive-unverified",
    effect: "deny",
    actions: ["sylo.vault.*"],
    condition: {
      kind: "and",
      conditions: [
        { kind: "comparison", attribute: "resource.sensitivity", operator: "equals", value: "high" },
        { kind: "not", condition: { kind: "comparison", attribute: "subject.verificationLevel", operator: "equals", value: "identity_verified" } },
      ],
    },
  };
  const allowVerifiedRead: AbacPolicyDefinition = {
    id: "allow-verified-read",
    effect: "allow",
    actions: ["sylo.vault.read"],
    condition: { kind: "comparison", attribute: "subject.verificationLevel", operator: "equals", value: "identity_verified" },
  };

  await test("happy path: GIVEN identity-verified subject WHEN reading a sensitive resource THEN ALLOW", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([denySensitiveUnverified, allowVerifiedRead]));
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "identity_verified" }, "sylo.vault.read", { type: "sylo.vault_item", id: 42, sensitivity: "high" }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, ABAC_POLICY_ID);
  });

  await test("negative path: GIVEN email-verified-only subject WHEN reading a sensitive resource THEN DENY (deny-overrides within the rule)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead, denySensitiveUnverified])); // allow listed FIRST
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "email_verified" }, "sylo.vault.read", { type: "sylo.vault_item", id: 42, sensitivity: "high" }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "ATTRIBUTE_POLICY_DENIED");
    assert.equal(decision.policyId, ABAC_POLICY_ID);
  });

  await test("no policy's actions cover this action → abstain → falls through to default deny", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([denySensitiveUnverified, allowVerifiedRead]));
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "email_verified" }, "ryft.payment.read", { type: "ryft.payment", id: 1, sensitivity: "high" }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("no policy's condition matches → abstain → falls through to default deny", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([denySensitiveUnverified, allowVerifiedRead]));
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "email_verified" }, "sylo.vault.read", { type: "sylo.vault_item", id: 99, sensitivity: "low" }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("empty policy list abstains rather than producing a decision", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([]));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("unauthenticated subject never reaches the abac rule at all", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead]));
    const decision = await engine.evaluate(buildInput(null, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── security: IDOR / resource-ID substitution ──────────────────────────

  await test("IDOR: a condition keyed to a concrete resource id does not leak to a substituted id", async () => {
    const scoped: AbacPolicyDefinition = {
      id: "allow-one-resource",
      effect: "allow",
      actions: ["sylo.vault.read"],
      condition: { kind: "comparison", attribute: "resource.id", operator: "equals", value: "42" },
    };
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([scoped]));
    for (const id of [1, 43, 999, "42x", "0042"]) {
      const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id }));
      assert.equal(decision.effect, "DENY", `expected DENY for substituted id ${JSON.stringify(id)}`);
    }
    const exact = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(exact.effect, "ALLOW");
  });

  // ── security: privilege escalation ─────────────────────────────────────

  await test("privilege escalation: forging unrelated resource fields does not manufacture a match", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead]));
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "email_verified" }, "admin.user.manage", {
        type: "sylo.vault_item",
        id: 42,
        ownerId: 1,
        organizationId: 1,
        classification: "top-secret",
        sensitivity: "high",
      }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // allowVerifiedRead's actions don't cover admin.user.manage
  });

  await test("privilege escalation: relabeling the action cannot leverage a narrowly-scoped allow policy", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead])); // scoped to sylo.vault.read only
    for (const action of ["sylo.vault.update", "sylo.vault.delete", "sylo.vault.manage"]) {
      const decision = await engine.evaluate(
        buildInput({ ...bob, verificationLevel: "identity_verified" }, action, { type: "sylo.vault_item", id: 42 }),
      );
      assert.equal(decision.effect, "DENY", `expected ${action} to be unaffected by a read-only allow policy`);
    }
  });

  await test("cross-user: an ABAC condition on subject attributes does not extend to a different subject", async () => {
    const ownerOnly: AbacPolicyDefinition = {
      id: "allow-owner-only",
      effect: "allow",
      condition: { kind: "comparison", attribute: "subject.userId", operator: "equals", value: alice.userId },
    };
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([ownerOnly]));
    const aliceDecision = await engine.evaluate(buildInput(alice, "sylo.vault.read", { type: "sylo.vault_item", id: 1 }));
    const bobDecision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 1 }));
    assert.equal(aliceDecision.effect, "ALLOW");
    assert.equal(bobDecision.effect, "DENY");
  });

  // ── composition with the rest of the engine ────────────────────────────

  await test("composition: an ABAC ALLOW does not override a locked-resource DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead]));
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "identity_verified" }, "sylo.vault.read", { type: "sylo.vault_item", id: 42, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  await test("composition: an ABAC ALLOW does not override an explicit resource-grant DENY, regardless of registration order", async () => {
    const grants = new FakeResourceGrantProvider();
    grants.setGrant(2, "sylo.vault_item", "42", "sylo.vault.update", { effect: "deny", reason: "compliance hold" });

    const engineA = new PolicyEngine();
    engineA.registerRule(ABAC_POLICY_ID, createAbacRule([{ id: "allow-all", effect: "allow", condition: { kind: "and", conditions: [] } }]));
    engineA.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(grants));

    const engineB = new PolicyEngine();
    engineB.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(grants));
    engineB.registerRule(ABAC_POLICY_ID, createAbacRule([{ id: "allow-all", effect: "allow", condition: { kind: "and", conditions: [] } }]));

    const resource: ResourceRef = { type: "sylo.vault_item", id: 42 };
    const decisionA = await engineA.evaluate(buildInput(bob, "sylo.vault.update", resource));
    const decisionB = await engineB.evaluate(buildInput(bob, "sylo.vault.update", resource));
    assert.equal(decisionA.effect, "DENY");
    assert.equal(decisionB.effect, "DENY");
    assert.equal(decisionA.reason, "RESOURCE_GRANT_DENIED");
    assert.equal(decisionB.reason, "RESOURCE_GRANT_DENIED");
  });

  await test("composition: ABAC fills a gap ownership alone would leave — a non-owner meeting an attribute condition can still read", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead]));
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "identity_verified" }, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, ABAC_POLICY_ID);
  });

  await test("composition: ownership and abac can both abstain together, falling through to default deny", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(ABAC_POLICY_ID, createAbacRule([allowVerifiedRead]));
    const decision = await engine.evaluate(
      buildInput({ ...bob, verificationLevel: "email_verified" }, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  console.log("Policy Engine — Phase 05 (ABAC): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
