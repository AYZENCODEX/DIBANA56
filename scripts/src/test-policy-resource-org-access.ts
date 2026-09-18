/**
 * scripts/src/test-policy-resource-org-access.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3C tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-resource-org-access.ts
 *
 * Covers the roadmap's Phase 03 "organization access" line item plus the
 * cross-tenant-access half of its security test list (the half 3A's
 * CHANGES doc explicitly deferred, since no org-access rule existed yet —
 * see resource/index.ts's header). IDOR / cross-user / privilege-escalation
 * for ownership and explicit grants are already covered by
 * test-policy-resource.ts and test-policy-resource-grants.ts respectively —
 * not repeated here.
 *
 * Run: npx tsx scripts/src/test-policy-resource-org-access.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createOrganizationAccessRule,
  createResourceOwnershipRule,
  createLockedResourceRule,
  createExplicitResourceGrantRule,
  ORGANIZATION_ACCESS_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  LOCKED_RESOURCE_POLICY_ID,
  RESOURCE_GRANT_POLICY_ID,
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

// alice and carol are both in org 100; bob is in org 200; dave has no
// organizationId at all (mirrors reality today — nothing populates this
// field yet, see organization-access-rule.ts's header).
const alice: Subject = { userId: 1, role: "user", authType: "session", organizationId: 100 };
const carol: Subject = { userId: 3, role: "user", authType: "session", organizationId: 100 };
const bob: Subject = { userId: 2, role: "user", authType: "session", organizationId: 200 };
const dave: Subject = { userId: 4, role: "user", authType: "session" };

async function main() {
  console.log("Policy Engine — Phase 03C (Organization Access) tests");

  // ── organization-access-rule.ts core behavior ─────────────────────────

  await test("same-org, non-owning subject → ALLOW via organization access", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    // carol does not own resource 42 (owned by user 1, alice) but shares
    // alice's organization (100).
    const decision = await engine.evaluate(
      buildInput(carol, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, ORGANIZATION_ACCESS_POLICY_ID);
  });

  await test("owner's own request also allowed via organization access alone (rule doesn't care about ownership)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, ORGANIZATION_ACCESS_POLICY_ID);
  });

  // ── cross-tenant access (the security test 3A's CHANGES doc deferred) ──

  await test("cross-tenant: different org → abstain → default DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("cross-tenant: composition with ownership — different org AND not owner → still default DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("no org fact on subject (not yet a member of any org) → abstain, even if resource has an organizationId", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(dave, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("no org fact on resource → abstain, even for a subject who does belong to an org", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("organizationId: null (explicitly not in any org) behaves the same as undefined — abstain", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const noOrgSubject: Subject = { userId: 5, role: "user", authType: "session", organizationId: null };
    const decision = await engine.evaluate(
      buildInput(noOrgSubject, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── IDOR / resource-ID substitution and privilege escalation ──────────

  await test("IDOR / org-ID substitution: matching org does not depend on resource id, but a forged org id alone (no real membership) never helps a subject with no org", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    for (const id of [1, 43, 999, "42x"]) {
      const decision = await engine.evaluate(
        buildInput(dave, "sylo.vault.read", { type: "sylo.vault_item", id, ownerId: 1, organizationId: 100 }),
      );
      assert.equal(decision.effect, "DENY", `expected DENY for substituted id ${JSON.stringify(id)} (dave has no org)`);
    }
  });

  await test("privilege escalation: forging unrelated resource fields does not manufacture an org match", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(bob, "admin.user.manage", {
        type: "sylo.vault_item",
        id: 42,
        ownerId: 1,
        organizationId: 100, // bob's real org is 200 — forging the resource's org doesn't change bob's subject.organizationId
        classification: "top-secret",
      }),
    );
    // bob's own organizationId is 200, so this is genuinely cross-tenant —
    // the rule must compare subject.organizationId, never trust anything
    // else on the resource to imply membership.
    assert.equal(decision.effect, "DENY");
  });

  await test("unauthenticated subject never reaches the organization-access rule at all", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    const decision = await engine.evaluate(
      buildInput(null, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── composition with the rest of Phase 03 ─────────────────────────────

  await test("composition: organization-access ALLOW does not override a locked-resource DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(carol, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  await test("composition: organization-access ALLOW does not override an explicit resource-grant DENY, regardless of registration order", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(3, "sylo.vault_item", "42", "sylo.vault.update", { effect: "deny", reason: "compliance hold" });

    const engineA = new PolicyEngine();
    engineA.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    engineA.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));

    const engineB = new PolicyEngine();
    engineB.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    engineB.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());

    const resource: ResourceRef = { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 };
    const decisionA = await engineA.evaluate(buildInput(carol, "sylo.vault.update", resource));
    const decisionB = await engineB.evaluate(buildInput(carol, "sylo.vault.update", resource));
    assert.equal(decisionA.effect, "DENY");
    assert.equal(decisionB.effect, "DENY");
    assert.equal(decisionA.reason, "RESOURCE_GRANT_DENIED");
    assert.equal(decisionB.reason, "RESOURCE_GRANT_DENIED");
  });

  await test("composition: an explicit resource-grant ALLOW still works for a cross-tenant subject the org rule alone would deny", async () => {
    const provider = new FakeResourceGrantProvider();
    provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow", reason: "cross-org share" });
    const engine = new PolicyEngine();
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    // bob is org 200, resource is org 100 — org rule abstains — but bob has
    // an explicit per-resource share grant, so the request still succeeds.
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, RESOURCE_GRANT_POLICY_ID);
  });

  await test("composition: ownership, organization-access and explicit grant can all abstain together, falling through to default deny", async () => {
    const provider = new FakeResourceGrantProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(ORGANIZATION_ACCESS_POLICY_ID, createOrganizationAccessRule());
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 100 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  console.log("Policy Engine — Phase 03C (Organization Access): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
