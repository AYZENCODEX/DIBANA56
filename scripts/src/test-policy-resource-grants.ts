/**
 * scripts/src/test-policy-resource-grants.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3B tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-resource-grants.ts
 *
 * Covers the roadmap's Phase 03 items sub-phase 3B implements ("explicit
 * grants", "resource-level deny") plus the applicable slice of its security
 * test list: IDOR / resource-ID substitution, cross-user access, privilege
 * escalation via forged fields. Organization access / cross-tenant tests
 * are NOT here — see resource/index.ts's header and the Phase 3B CHANGES
 * doc for why that rule doesn't exist yet.
 *
 * Run: npx tsx scripts/src/test-policy-resource-grants.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createExplicitResourceGrantRule,
  createResourceOwnershipRule,
  createLockedResourceRule,
  RESOURCE_GRANT_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  LOCKED_RESOURCE_POLICY_ID,
  type Subject,
  type ResourceRef,
  type ResourceGrantProvider,
  type ResourceGrantEntry,
  type BuildAuthorizationRequestInput,
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

// ── FakeResourceGrantProvider — in-memory stand-in ─────────────────────────

class FakeResourceGrantProvider implements ResourceGrantProvider {
  private readonly grants = new Map<string, ResourceGrantEntry>();

  private key(subjectUserId: number, resourceType: string, resourceId: string, action: string): string {
    return `${subjectUserId}::${resourceType}::${resourceId}::${action}`;
  }

  setGrant(
    subjectUserId: number,
    resourceType: string,
    resourceId: string,
    action: string,
    entry: ResourceGrantEntry,
  ): void {
    this.grants.set(this.key(subjectUserId, resourceType, resourceId, action), entry);
  }

  removeGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): void {
    this.grants.delete(this.key(subjectUserId, resourceType, resourceId, action));
  }

  async getResourceGrant(
    subjectUserId: number,
    resourceType: string,
    resourceId: string,
    action: string,
  ): Promise<ResourceGrantEntry | null> {
    return this.grants.get(this.key(subjectUserId, resourceType, resourceId, action)) ?? null;
  }
}

function buildInput(subject: Subject | null, action: string, resource: ResourceRef): BuildAuthorizationRequestInput {
  return { subject, action, resource };
}

const alice: Subject = { userId: 1, role: "user", authType: "session" };
const bob: Subject = { userId: 2, role: "user", authType: "session" };

async function main() {
  console.log("Policy Engine — Phase 03B (Explicit Resource Grants) tests");

  // ── explicit ALLOW ────────────────────────────────────────────────────

  await test("explicit grant (allow) → ALLOW even for a non-owner", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow", reason: "shared by owner" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    // bob has no ownership of resource 42 (owned by alice) but has an
    // explicit share grant for exactly this action.
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, RESOURCE_GRANT_POLICY_ID);
  });

  await test("no matching grant row → abstain → default DENY", async () => {
    const provider = new FakeResourceGrantProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── explicit DENY (resource-level deny) ──────────────────────────────

  await test("explicit resource-level deny → DENY (RESOURCE_GRANT_DENIED)", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(1, "sylo.vault_item", "42", "sylo.vault.update", {
      effect: "deny",
      reason: "flagged for compliance review",
    });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.update", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_GRANT_DENIED");
    assert.equal(decision.policyId, RESOURCE_GRANT_POLICY_ID);
  });

  await test("deny-overrides: an explicit resource-deny beats the owner's own ownership ALLOW, regardless of registration order", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(1, "sylo.vault_item", "42", "sylo.vault.update", { effect: "deny" });

    const engineA = new PolicyEngine();
    engineA.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engineA.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));

    const engineB = new PolicyEngine();
    engineB.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    engineB.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());

    const resource: ResourceRef = { type: "sylo.vault_item", id: 42, ownerId: 1 };
    const decisionA = await engineA.evaluate(buildInput(alice, "sylo.vault.update", resource));
    const decisionB = await engineB.evaluate(buildInput(alice, "sylo.vault.update", resource));
    assert.equal(decisionA.effect, "DENY");
    assert.equal(decisionB.effect, "DENY");
    assert.equal(decisionA.reason, "RESOURCE_GRANT_DENIED");
    assert.equal(decisionB.reason, "RESOURCE_GRANT_DENIED");
  });

  await test("revoking a deny grant restores whatever other rule would otherwise apply", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(1, "sylo.vault_item", "42", "sylo.vault.update", { effect: "deny" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const resource: ResourceRef = { type: "sylo.vault_item", id: 42, ownerId: 1 };

    const before = await engine.evaluate(buildInput(alice, "sylo.vault.update", resource));
    assert.equal(before.effect, "DENY");

    provider.removeGrant(1, "sylo.vault_item", "42", "sylo.vault.update");
    const after = await engine.evaluate(buildInput(alice, "sylo.vault.update", resource));
    assert.equal(after.effect, "ALLOW"); // falls through to ownership now
  });

  // ── exact-match semantics (no wildcard, no cross-contamination) ───────

  await test("exact match only: a grant for one action does not cover a different action", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.update", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("exact match only: a grant for one resource type does not cover a same-id different-type resource", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "ryft.payment", id: 42 }),
    );
    assert.equal(decision.effect, "DENY");
  });

  await test("resource with no id at all → rule abstains cleanly (nothing concrete to look up)", async () => {
    const provider = new FakeResourceGrantProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item" }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── security: IDOR / resource-ID substitution / cross-user ────────────

  await test("IDOR / resource-ID substitution: a grant scoped to id=42 does not leak to a substituted id", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    for (const id of [1, 43, 999, "42x", "0042"]) {
      const decision = await engine.evaluate(
        buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id, ownerId: 1 }),
      );
      assert.equal(decision.effect, "DENY", `expected DENY for substituted id ${JSON.stringify(id)}`);
    }
    // The exact granted id must still work, proving the substitution
    // failures above are about matching, not a broken provider.
    const exact = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(exact.effect, "ALLOW");
  });

  await test("cross-user: a grant issued to alice does not extend to bob on the same resource/action", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(1, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow" }); // alice's own grant
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
  });

  await test("privilege escalation: forging unrelated resource fields does not manufacture a grant match", async () => {
    const provider = new FakeResourceGrantProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "admin.user.manage", {
        type: "sylo.vault_item",
        id: 42,
        ownerId: 1,
        organizationId: 1,
        classification: "top-secret",
      }),
    );
    assert.equal(decision.effect, "DENY");
  });

  await test("unauthenticated subject never reaches the resource-grant rule at all", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(null, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── composition with the rest of Phase 03 ─────────────────────────────

  await test("composition: explicit grant ALLOW does not override a locked-resource DENY", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow" });
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  await test("composition: ownership and explicit grant can both abstain, falling through to default deny together", async () => {
    const provider = new FakeResourceGrantProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  console.log("Policy Engine — Phase 03B (Explicit Resource Grants): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
