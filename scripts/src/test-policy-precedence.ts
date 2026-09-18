/**
 * scripts/src/test-policy-precedence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 08 (Policy Precedence)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-precedence.ts
 *
 * Two parts:
 *   1. THE CONFLICT MATRIX — every adjacent (and several non-adjacent) pair
 *      of the 7 precedence tiers, pitted against each other with opposite
 *      verdicts, confirming the higher-precedence tier always wins
 *      regardless of registration order or which side is ALLOW vs DENY.
 *      Roadmap's own words: "Document the final precedence formally and
 *      create a conflict test matrix." precedence-tiers.ts is the
 *      documentation; this file is the matrix.
 *   2. COMPOSITION — the SAME real Phase 02-06 rules (rbac-rule,
 *      ownership-rule, explicit-grant-rule, locked-resource-rule, and a
 *      DSL-compiled ABAC policy) registered at the tiers
 *      precedence-tiers.ts's own header documents they belong to, proving
 *      the documented mapping table is not just a comment — it actually
 *      produces the right outcome end to end.
 *
 * Run: npx tsx scripts/src/test-policy-precedence.ts
 */

import assert from "node:assert/strict";
import {
  PrecedenceEngine,
  PRECEDENCE_ORDER,
  createRbacRule,
  createResourceOwnershipRule,
  createExplicitResourceGrantRule,
  createLockedResourceRule,
  createAbacRule,
  compileAbacPolicy,
  RBAC_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  RESOURCE_GRANT_POLICY_ID,
  LOCKED_RESOURCE_POLICY_ID,
  ABAC_POLICY_ID,
  allow,
  deny,
  stepUp,
  type PrecedenceTier,
  type Subject,
  type ResourceRef,
  type BuildAuthorizationRequestInput,
  type RbacProvider,
  type RoleRecord,
  type ResourceGrantProvider,
  type ResourceGrantEntry,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type PolicyRule,
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

// ── Synthetic fixed-verdict rules — for the pure conflict-matrix tests,
//    where what matters is TIER RANK, not any particular rule's real
//    business logic (that's what part 2, composition, covers). ───────────

function alwaysAllow(id: string): PolicyRule {
  return (request) => allow(request, "EXPLICIT_ALLOW", { policyId: id });
}
function alwaysDeny(reason: "EXPLICIT_DENY" | "RESOURCE_LOCKED" | "RESOURCE_GRANT_DENIED" | "ATTRIBUTE_POLICY_DENIED", id: string): PolicyRule {
  return (request) => deny(request, reason, { policyId: id });
}
function alwaysStepUp(id: string): PolicyRule {
  return (request) => stepUp(request, { policyId: id });
}
function alwaysAbstain(): PolicyRule {
  return () => null;
}
function alwaysThrows(): PolicyRule {
  return () => {
    throw new Error("synthetic rule failure");
  };
}

const subject: Subject = { userId: 1, role: "user", authType: "session" };
const resource: ResourceRef = { type: "sylo.vault_item", id: "r1" };

function req(): BuildAuthorizationRequestInput {
  return { subject, action: "read", resource };
}

async function main() {
  console.log("Phase 08 — Policy Precedence tests\n");

  // ── Part 1: the conflict matrix ─────────────────────────────────────────

  await test("PRECEDENCE_ORDER has exactly the roadmap's 7 named tiers, in order", () => {
    assert.deepEqual(PRECEDENCE_ORDER, [
      "EMERGENCY_SECURITY_DENY",
      "GLOBAL_DENY",
      "TENANT_ORG_DENY",
      "RESOURCE_DENY",
      "RISK_RESTRICTION",
      "EXPLICIT_GRANT",
      "ROLE_GRANT",
    ]);
  });

  await test("registerRule rejects an unknown tier string", () => {
    const engine = new PrecedenceEngine();
    assert.throws(() => engine.registerRule("bad", "NOT_A_REAL_TIER", alwaysAllow("bad")));
  });

  // Every (higher, lower) adjacent pair: higher tier's DENY beats lower
  // tier's ALLOW, and — the harder direction to get right — higher tier's
  // ALLOW ALSO beats lower tier's DENY (rank alone decides; effect does
  // not by itself outrank a lower tier).
  const adjacentPairs: Array<[PrecedenceTier, PrecedenceTier]> = [];
  for (let i = 0; i < PRECEDENCE_ORDER.length - 1; i++) {
    adjacentPairs.push([PRECEDENCE_ORDER[i], PRECEDENCE_ORDER[i + 1]]);
  }

  for (const [higher, lower] of adjacentPairs) {
    await test(`${higher} DENY beats ${lower} ALLOW`, async () => {
      const engine = new PrecedenceEngine();
      engine.registerRule("higher", higher, alwaysDeny("EXPLICIT_DENY", "higher"));
      engine.registerRule("lower", lower, alwaysAllow("lower"));
      const decision = await engine.evaluate(req());
      assert.equal(decision.effect, "DENY");
      assert.equal(decision.policyId, "higher");
    });

    await test(`${higher} ALLOW beats ${lower} DENY (rank alone decides, not effect)`, async () => {
      const engine = new PrecedenceEngine();
      engine.registerRule("higher", higher, alwaysAllow("higher"));
      engine.registerRule("lower", lower, alwaysDeny("EXPLICIT_DENY", "lower"));
      const decision = await engine.evaluate(req());
      assert.equal(decision.effect, "ALLOW");
      assert.equal(decision.policyId, "higher");
    });
  }

  // Non-adjacent: the very top tier beats the very bottom, registration
  // order reversed (bottom registered first) to prove order-of-registration
  // is irrelevant to which tier wins.
  await test("EMERGENCY_SECURITY_DENY beats ROLE_GRANT even when ROLE_GRANT is registered first", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("role", "ROLE_GRANT", alwaysAllow("role"));
    engine.registerRule("emergency", "EMERGENCY_SECURITY_DENY", alwaysDeny("EXPLICIT_DENY", "emergency"));
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.policyId, "emergency");
  });

  await test("RISK_RESTRICTION (STEP_UP) beats EXPLICIT_GRANT ALLOW but loses to RESOURCE_DENY", async () => {
    const withGrant = new PrecedenceEngine();
    withGrant.registerRule("grant", "EXPLICIT_GRANT", alwaysAllow("grant"));
    withGrant.registerRule("risk", "RISK_RESTRICTION", alwaysStepUp("risk"));
    const d1 = await withGrant.evaluate(req());
    assert.equal(d1.effect, "STEP_UP");
    assert.equal(d1.policyId, "risk");

    const withResourceDeny = new PrecedenceEngine();
    withResourceDeny.registerRule("risk", "RISK_RESTRICTION", alwaysStepUp("risk"));
    withResourceDeny.registerRule("resdeny", "RESOURCE_DENY", alwaysDeny("RESOURCE_LOCKED", "resdeny"));
    const d2 = await withResourceDeny.evaluate(req());
    assert.equal(d2.effect, "DENY");
    assert.equal(d2.policyId, "resdeny");
  });

  await test("intra-tier tiebreak: same tier, DENY beats ALLOW regardless of registration order", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("a", "EXPLICIT_GRANT", alwaysAllow("a"));
    engine.registerRule("b", "EXPLICIT_GRANT", alwaysDeny("EXPLICIT_DENY", "b"));
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.policyId, "b");
  });

  await test("intra-tier tiebreak: same tier, two ALLOWs and no DENY → first ALLOW wins", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("a", "EXPLICIT_GRANT", alwaysAllow("a"));
    engine.registerRule("b", "EXPLICIT_GRANT", alwaysAllow("b"));
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, "a");
  });

  await test("a tier where every rule abstains is skipped — evaluation falls through to the next tier", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("resdeny", "RESOURCE_DENY", alwaysAbstain());
    engine.registerRule("grant", "EXPLICIT_GRANT", alwaysAllow("grant"));
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, "grant");
  });

  await test("no tier decisive at all → NO_MATCHING_POLICY (default deny, the roadmap's unlisted 8th tier)", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("resdeny", "RESOURCE_DENY", alwaysAbstain());
    engine.registerRule("grant", "EXPLICIT_GRANT", alwaysAbstain());
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("fail-closed: a throwing rule at any tier resolves the WHOLE evaluation to deny, even with a decisive higher-priority ALLOW never reached", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("boom", "TENANT_ORG_DENY", alwaysThrows());
    engine.registerRule("grant", "EXPLICIT_GRANT", alwaysAllow("grant"));
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    assert.equal(decision.policyId, "boom");
  });

  await test("invalid context and unauthenticated behave identically to PolicyEngine (shared preamble)", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("grant", "EXPLICIT_GRANT", alwaysAllow("grant"));

    const invalid = await engine.evaluate({ subject, action: "", resource });
    assert.equal(invalid.effect, "DENY");
    assert.equal(invalid.reason, "INVALID_AUTHORIZATION_CONTEXT");

    const unauth = await engine.evaluate({ subject: null, action: "read", resource });
    assert.equal(unauth.effect, "DENY");
    assert.equal(unauth.reason, "UNAUTHENTICATED");
  });

  await test("deterministic: identical input evaluated twice yields identical effect/reason/policyId", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("resdeny", "RESOURCE_DENY", alwaysDeny("RESOURCE_LOCKED", "resdeny"));
    engine.registerRule("grant", "EXPLICIT_GRANT", alwaysAllow("grant"));
    const d1 = await engine.evaluate(req());
    const d2 = await engine.evaluate(req());
    assert.equal(d1.effect, d2.effect);
    assert.equal(d1.reason, d2.reason);
    assert.equal(d1.policyId, d2.policyId);
  });

  await test("registering the same id twice moves it — hot-swap across tiers", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule("x", "ROLE_GRANT", alwaysAllow("x"));
    engine.registerRule("x", "EMERGENCY_SECURITY_DENY", alwaysDeny("EXPLICIT_DENY", "x"));
    assert.deepEqual(engine.listRules(), [{ id: "x", tier: "EMERGENCY_SECURITY_DENY" }]);
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "DENY");
  });

  await test("onTierEvaluated trace fires only for the decisive tier, with every decision that tier actually produced", async () => {
    const traces: Array<{ tier: PrecedenceTier; count: number }> = [];
    const engine = new PrecedenceEngine({
      onTierEvaluated: (trace) => traces.push({ tier: trace.tier, count: trace.decisions.length }),
    });
    engine.registerRule("abstain-here", "TENANT_ORG_DENY", alwaysAbstain());
    engine.registerRule("a", "RESOURCE_DENY", alwaysAllow("a"));
    engine.registerRule("b", "RESOURCE_DENY", alwaysDeny("RESOURCE_LOCKED", "b"));
    engine.registerRule("never-reached", "ROLE_GRANT", alwaysAllow("never-reached"));

    const decision = await engine.evaluate(req());
    assert.equal(decision.policyId, "b");
    assert.deepEqual(traces, [{ tier: "RESOURCE_DENY", count: 2 }]);
  });

  await test("a throwing onTierEvaluated observer never affects the returned decision", async () => {
    const engine = new PrecedenceEngine({
      onTierEvaluated: () => {
        throw new Error("observer boom");
      },
    });
    engine.registerRule("grant", "EXPLICIT_GRANT", alwaysAllow("grant"));
    const decision = await engine.evaluate(req());
    assert.equal(decision.effect, "ALLOW");
  });

  // ── Part 2: composition — real Phase 02-06 rules at their documented tiers ─

  class FakeRbacProvider implements RbacProvider {
    private readonly roles = new Map<string, RoleRecord>();
    private readonly rolePermissions = new Map<string, Set<string>>();
    addRole(key: string, parentRoleKey: string | null = null): void {
      this.roles.set(key, { key, parentRoleKey });
      if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
    }
    grant(roleKey: string, permissionKey: string): void {
      if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
      this.rolePermissions.get(roleKey)!.add(permissionKey);
    }
    async getUserRoleKeys(): Promise<string[]> {
      return [];
    }
    async getRolePermissionKeys(roleKey: string): Promise<string[]> {
      return [...(this.rolePermissions.get(roleKey) ?? [])];
    }
    async getRole(roleKey: string): Promise<RoleRecord | null> {
      return this.roles.get(roleKey) ?? null;
    }
  }

  class FakeResourceGrantProvider implements ResourceGrantProvider {
    private readonly grants = new Map<string, ResourceGrantEntry>();
    key(subjectUserId: number, resourceType: string, resourceId: string, action: string): string {
      return `${subjectUserId}:${resourceType}:${resourceId}:${action}`;
    }
    set(subjectUserId: number, resourceType: string, resourceId: string, action: string, effect: "allow" | "deny"): void {
      this.grants.set(this.key(subjectUserId, resourceType, resourceId, action), { effect });
    }
    async getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantEntry | null> {
      return this.grants.get(this.key(subjectUserId, resourceType, resourceId, action)) ?? null;
    }
  }

  await test("composition: RESOURCE_DENY (locked-resource) beats EXPLICIT_GRANT (ownership) using the real rules", async () => {
    const engine = new PrecedenceEngine();
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, "RESOURCE_DENY", createLockedResourceRule());
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, "EXPLICIT_GRANT", createResourceOwnershipRule());

    const ownerSubject: Subject = { userId: 42, role: "user", authType: "session" };
    const lockedOwnedResource: ResourceRef = { type: "sylo.vault_item", id: "v1", ownerId: 42, locked: true };

    const decision = await engine.evaluate({ subject: ownerSubject, action: "update", resource: lockedOwnedResource });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  await test("composition: EXPLICIT_GRANT (explicit deny row) beats ROLE_GRANT (RBAC allow) using the real rules", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "sylo.vault.read");
    const resourceGrants = new FakeResourceGrantProvider();
    resourceGrants.set(7, "sylo.vault_item", "v9", "sylo.vault.read", "deny");

    const engine = new PrecedenceEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, "EXPLICIT_GRANT", createExplicitResourceGrantRule(resourceGrants));
    engine.registerRule(RBAC_POLICY_ID, "ROLE_GRANT", createRbacRule(rbac));

    const s: Subject = { userId: 7, role: "user", authType: "session" };
    const r: ResourceRef = { type: "sylo.vault_item", id: "v9" };
    const decision = await engine.evaluate({ subject: s, action: "sylo.vault.read", resource: r });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_GRANT_DENIED");
  });

  await test("composition: ROLE_GRANT alone still allows when nothing at a higher tier has an opinion", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "sylo.vault.read");

    const engine = new PrecedenceEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, "EXPLICIT_GRANT", createExplicitResourceGrantRule(new FakeResourceGrantProvider()));
    engine.registerRule(RBAC_POLICY_ID, "ROLE_GRANT", createRbacRule(rbac));

    const s: Subject = { userId: 7, role: "user", authType: "session" };
    const r: ResourceRef = { type: "sylo.vault_item", id: "v9" };
    const decision = await engine.evaluate({ subject: s, action: "sylo.vault.read", resource: r });
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, RBAC_POLICY_ID);
  });

  await test("composition: a DSL-compiled ABAC cross-org policy registered at TENANT_ORG_DENY beats ROLE_GRANT — the roadmap's own conceptual example", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "sylo.vault.read");

    const crossOrgDenyPolicy = compileAbacPolicy({
      id: "cross-org-deny",
      effect: "deny",
      expression: "subject.organizationId != resource.organizationId",
    });

    const engine = new PrecedenceEngine();
    engine.registerRule("cross-org-deny", "TENANT_ORG_DENY", createAbacRule([crossOrgDenyPolicy]));
    engine.registerRule(RBAC_POLICY_ID, "ROLE_GRANT", createRbacRule(rbac));

    const s: Subject = { userId: 7, role: "user", authType: "session", organizationId: 1 };
    const crossOrgResource: ResourceRef = { type: "sylo.vault_item", id: "v9", organizationId: 2 };
    const decision = await engine.evaluate({ subject: s, action: "sylo.vault.read", resource: crossOrgResource });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "ATTRIBUTE_POLICY_DENIED");

    // Same-org request: the ABAC policy's own condition doesn't match, so
    // it abstains (see abac-rule.ts) and ROLE_GRANT (a lower tier) is free
    // to allow — TENANT_ORG_DENY only overrides when it actually HAS an
    // opinion, never unconditionally.
    const sameOrgResource: ResourceRef = { type: "sylo.vault_item", id: "v10", organizationId: 1 };
    const allowed = await engine.evaluate({ subject: s, action: "sylo.vault.read", resource: sameOrgResource });
    assert.equal(allowed.effect, "ALLOW");
    assert.equal(allowed.policyId, RBAC_POLICY_ID);
  });

  console.log("\nAll Phase 08 policy-precedence tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
