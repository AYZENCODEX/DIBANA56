/**
 * scripts/src/test-policy-rebac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 04 (ReBAC) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-rebac.ts
 *
 * Covers: relation→action-verb coverage for all seven relation kinds
 * (relation-action-map.ts), the resolver's defensive filtering of
 * unrecognized relation strings (relationship-resolver.ts), the rule's
 * core allow/abstain behavior (rebac-rule.ts), the roadmap's declarative
 * test model (GIVEN subject+resource+context / WHEN action / THEN
 * decision) for a happy path, a negative path, and boundary cases per
 * relation kind, plus the applicable Phase 22 security suites: IDOR /
 * resource-ID substitution, cross-user (tenant-isolation) access,
 * privilege escalation via forged fields, and composition with the rest
 * of the engine (deny-overrides, multi-relation subjects).
 *
 * Run: npx tsx scripts/src/test-policy-rebac.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createRebacRule,
  createResourceOwnershipRule,
  createLockedResourceRule,
  createExplicitResourceGrantRule,
  actionVerb,
  relationGrantsAction,
  REBAC_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  LOCKED_RESOURCE_POLICY_ID,
  RESOURCE_GRANT_POLICY_ID,
  RELATION_KINDS,
  type Subject,
  type ResourceRef,
  type RelationshipProvider,
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

// ── FakeRelationshipProvider — in-memory stand-in ──────────────────────────

class FakeRelationshipProvider implements RelationshipProvider {
  private readonly rows = new Map<string, Set<string>>();

  private key(subjectUserId: number, resourceType: string, resourceId: string): string {
    return `${subjectUserId}::${resourceType}::${resourceId}`;
  }

  grant(subjectUserId: number, resourceType: string, resourceId: string, relation: string): void {
    const k = this.key(subjectUserId, resourceType, resourceId);
    if (!this.rows.has(k)) this.rows.set(k, new Set());
    this.rows.get(k)!.add(relation);
  }

  revoke(subjectUserId: number, resourceType: string, resourceId: string, relation: string): void {
    this.rows.get(this.key(subjectUserId, resourceType, resourceId))?.delete(relation);
  }

  async getRelations(subjectUserId: number, resourceType: string, resourceId: string): Promise<string[]> {
    return [...(this.rows.get(this.key(subjectUserId, resourceType, resourceId)) ?? [])];
  }
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

const alice: Subject = { userId: 1, role: "user", authType: "session" };
const bob: Subject = { userId: 2, role: "user", authType: "session" };
const carol: Subject = { userId: 3, role: "user", authType: "session" };

async function main() {
  console.log("Policy Engine — Phase 04 (ReBAC) tests");

  // ── relation-action-map.ts — pure function unit tests ─────────────────

  await test("actionVerb() extracts the trailing dot-segment, lowercased", () => {
    assert.equal(actionVerb("sylo.vault.read"), "read");
    assert.equal(actionVerb("ryft.payment.approve"), "approve");
    assert.equal(actionVerb("READ"), "read"); // opaque single-word action, still normalized
    assert.equal(actionVerb(""), "");
  });

  await test("every relation kind's verb coverage matches the documented hierarchy", () => {
    // owner: everything.
    for (const action of ["x.y.read", "x.y.update", "x.y.approve", "x.y.manage", "x.y.delete"]) {
      assert.equal(relationGrantsAction("owner", action), true, `owner should cover ${action}`);
    }
    // manager: read/write/approve, NOT manage/delete.
    assert.equal(relationGrantsAction("manager", "x.y.read"), true);
    assert.equal(relationGrantsAction("manager", "x.y.update"), true);
    assert.equal(relationGrantsAction("manager", "x.y.approve"), true);
    assert.equal(relationGrantsAction("manager", "x.y.manage"), false);
    assert.equal(relationGrantsAction("manager", "x.y.delete"), false);
    // editor: read/write only.
    assert.equal(relationGrantsAction("editor", "x.y.read"), true);
    assert.equal(relationGrantsAction("editor", "x.y.update"), true);
    assert.equal(relationGrantsAction("editor", "x.y.approve"), false);
    // approver: read/approve, NOT write.
    assert.equal(relationGrantsAction("approver", "x.y.read"), true);
    assert.equal(relationGrantsAction("approver", "x.y.approve"), true);
    assert.equal(relationGrantsAction("approver", "x.y.update"), false);
    // member/viewer/auditor: read only.
    for (const relation of ["member", "viewer", "auditor"] as const) {
      assert.equal(relationGrantsAction(relation, "x.y.read"), true, `${relation} should cover read`);
      assert.equal(relationGrantsAction(relation, "x.y.update"), false, `${relation} should not cover update`);
      assert.equal(relationGrantsAction(relation, "x.y.approve"), false, `${relation} should not cover approve`);
      assert.equal(relationGrantsAction(relation, "x.y.manage"), false, `${relation} should not cover manage`);
    }
  });

  await test("unrecognized verb matches nothing, for any relation — fails closed", () => {
    for (const relation of RELATION_KINDS) {
      assert.equal(relationGrantsAction(relation, "x.y.teleport"), false);
    }
  });

  // ── rebac-rule.ts — core allow/abstain behavior ────────────────────────

  await test("viewer relation → ALLOW on a read action", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "viewer");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, REBAC_POLICY_ID);
  });

  await test("viewer relation → abstain (not deny) on a write action → falls through to default DENY", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "viewer");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.update", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // engine-level default-deny, not a rebac-produced deny
  });

  await test("editor relation → ALLOW on both read and update", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "editor");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    for (const action of ["sylo.vault.read", "sylo.vault.update"]) {
      const decision = await engine.evaluate(buildInput(bob, action, { type: "sylo.vault_item", id: 42 }));
      assert.equal(decision.effect, "ALLOW", `expected editor to cover ${action}`);
    }
  });

  await test("no relationship on file at all → abstain → default DENY", async () => {
    const provider = new FakeRelationshipProvider();
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("resource with no id at all → rule abstains cleanly (nothing concrete to look up)", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "owner");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item" }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("a subject can hold more than one relation on the same resource — the union of both applies", async () => {
    const provider = new FakeRelationshipProvider();
    // bob is both a member (of the containing org, read-only) and an
    // approver (of this specific resource) — approve should work even
    // though "member" alone would not cover it.
    provider.grant(2, "ryft.payment", "7", "member");
    provider.grant(2, "ryft.payment", "7", "approver");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "ryft.payment.approve", { type: "ryft.payment", id: 7 }));
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, REBAC_POLICY_ID);
  });

  await test("revoking a relationship removes the access it granted", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "editor");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));

    const before = await engine.evaluate(buildInput(bob, "sylo.vault.update", { type: "sylo.vault_item", id: 42 }));
    assert.equal(before.effect, "ALLOW");

    provider.revoke(2, "sylo.vault_item", "42", "editor");
    const after = await engine.evaluate(buildInput(bob, "sylo.vault.update", { type: "sylo.vault_item", id: 42 }));
    assert.equal(after.effect, "DENY");
    assert.equal(after.reason, "NO_MATCHING_POLICY");
  });

  // ── resolver defensive filtering ───────────────────────────────────────

  await test("an unrecognized relation string from storage is dropped, not trusted (fails closed)", async () => {
    const provider = new FakeRelationshipProvider();
    // Simulates a malformed/legacy row a future schema version wrote —
    // FakeRelationshipProvider.grant() doesn't validate its input, same
    // as the real Drizzle provider returning raw TEXT column values.
    provider.grant(2, "sylo.vault_item", "42", "superadmin");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("a mix of one unrecognized relation and one real relation still honors the real one", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "superadmin"); // dropped
    provider.grant(2, "sylo.vault_item", "42", "viewer"); // honored
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "ALLOW");
  });

  // ── security: IDOR / resource-ID substitution ──────────────────────────

  await test("IDOR / resource-ID substitution: a relation scoped to id=42 does not leak to a substituted id", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "owner");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    for (const id of [1, 43, 999, "42x", "0042"]) {
      const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id }));
      assert.equal(decision.effect, "DENY", `expected DENY for substituted id ${JSON.stringify(id)}`);
    }
    const exact = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(exact.effect, "ALLOW");
  });

  await test("a relation on one resource type does not leak to a same-id different-type resource", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "owner");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "ryft.payment.read", { type: "ryft.payment", id: 42 }));
    assert.equal(decision.effect, "DENY");
  });

  // ── security: cross-user / tenant isolation ────────────────────────────

  await test("cross-user: a relation granted to alice does not extend to bob on the same resource", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(1, "sylo.vault_item", "42", "owner"); // alice's own relation
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
  });

  await test("tenant isolation: a viewer on organization A's resource has no access to organization B's identically-shaped resource id", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "ayzen.organization", "100", "member");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const sameOrg = await engine.evaluate(buildInput(bob, "ayzen.organization.read", { type: "ayzen.organization", id: 100 }));
    const otherOrg = await engine.evaluate(buildInput(bob, "ayzen.organization.read", { type: "ayzen.organization", id: 200 }));
    assert.equal(sameOrg.effect, "ALLOW");
    assert.equal(otherOrg.effect, "DENY");
  });

  // ── security: privilege escalation ─────────────────────────────────────

  await test("privilege escalation: forging unrelated resource fields does not manufacture a relation match", async () => {
    const provider = new FakeRelationshipProvider();
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
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

  await test("privilege escalation: holding 'viewer' cannot be leveraged into a 'manage' action by relabeling the request action", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "viewer");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    for (const action of ["sylo.vault.manage", "sylo.vault.delete", "sylo.vault.approve", "sylo.vault.update"]) {
      const decision = await engine.evaluate(buildInput(bob, action, { type: "sylo.vault_item", id: 42 }));
      assert.equal(decision.effect, "DENY", `viewer should not cover ${action}`);
    }
  });

  await test("unauthenticated subject never reaches the rebac rule at all", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "owner");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(buildInput(null, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── composition with the rest of the engine ────────────────────────────

  await test("composition: a rebac ALLOW does not override a locked-resource DENY", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(2, "sylo.vault_item", "42", "owner");
    const engine = new PolicyEngine();
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  await test("composition: a rebac ALLOW does not override an explicit resource-grant DENY, regardless of registration order", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "editor");
    const grants = new FakeResourceGrantProvider();
    grants.setGrant(2, "sylo.vault_item", "42", "sylo.vault.update", { effect: "deny", reason: "compliance hold" });

    const engineA = new PolicyEngine();
    engineA.registerRule(REBAC_POLICY_ID, createRebacRule(relationships));
    engineA.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(grants));

    const engineB = new PolicyEngine();
    engineB.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(grants));
    engineB.registerRule(REBAC_POLICY_ID, createRebacRule(relationships));

    const resource: ResourceRef = { type: "sylo.vault_item", id: 42 };
    const decisionA = await engineA.evaluate(buildInput(bob, "sylo.vault.update", resource));
    const decisionB = await engineB.evaluate(buildInput(bob, "sylo.vault.update", resource));
    assert.equal(decisionA.effect, "DENY");
    assert.equal(decisionB.effect, "DENY");
    assert.equal(decisionA.reason, "RESOURCE_GRANT_DENIED");
    assert.equal(decisionB.reason, "RESOURCE_GRANT_DENIED");
  });

  await test("composition: rebac fills a gap ownership alone would leave — a non-owner viewer can still read", async () => {
    const provider = new FakeRelationshipProvider();
    provider.grant(3, "sylo.vault_item", "42", "viewer"); // carol: not the owner, but a viewer
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(
      buildInput(carol, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, REBAC_POLICY_ID);
  });

  await test("composition: ownership and rebac can both abstain together, falling through to default deny", async () => {
    const provider = new FakeRelationshipProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(REBAC_POLICY_ID, createRebacRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  console.log("Policy Engine — Phase 04 (ReBAC): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
