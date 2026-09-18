/**
 * scripts/src/test-policy-separation-of-duties.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 13 (Separation of Duties)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-separation-of-duties.ts
 *
 * Covers the roadmap's Phase 13 requirements directly:
 *   - "creator != approver" (the `blockResourceOwner` check, via
 *     `resource.ownerId`);
 *   - "requester != reviewer" / "key-rotator != sole approver" (the
 *     `conflictingRelations` check, via Phase 04's ReBAC
 *     `RelationshipProvider`);
 * plus the applicable slice of the roadmap's general security test list
 * (IDOR, cross-user, privilege escalation via forged fields), composition
 * with other phases/rules (deny-overrides regardless of registration
 * order), and determinism (Rule 12).
 *
 * Run: npx tsx scripts/src/test-policy-separation-of-duties.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createSeparationOfDutiesRule,
  createResourceOwnershipRule,
  SEPARATION_OF_DUTIES_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  type Subject,
  type ResourceRef,
  type RelationshipProvider,
  type SeparationOfDutyConstraint,
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

  async getRelations(subjectUserId: number, resourceType: string, resourceId: string): Promise<string[]> {
    return [...(this.rows.get(this.key(subjectUserId, resourceType, resourceId)) ?? [])];
  }
}

function buildInput(subject: Subject | null, action: string, resource: ResourceRef): BuildAuthorizationRequestInput {
  return { subject, action, resource };
}

const alice: Subject = { userId: 1, role: "user", authType: "session" };
const bob: Subject = { userId: 2, role: "user", authType: "session" };
const carol: Subject = { userId: 3, role: "user", authType: "session" };

async function main() {
  console.log("Policy Engine — Phase 13 (Separation of Duties) tests");

  // ── "creator != approver" — blockResourceOwner ─────────────────────────

  await test('"creator != approver": the resource\'s own owner is DENIED a matching action', async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(
      buildInput(alice, "ryft.payment.approve", { type: "ryft.payment", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "SEPARATION_OF_DUTIES_VIOLATION");
    assert.equal(decision.policyId, SEPARATION_OF_DUTIES_POLICY_ID);
  });

  await test("a non-owner subject is not blocked by the resource-owner check — abstains", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(
      buildInput(bob, "ryft.payment.approve", { type: "ryft.payment", id: 42, ownerId: 1 }),
    );
    // Nothing else registered — abstain falls through to engine default-deny,
    // NOT a separation-of-duties-produced deny.
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("blockResourceOwner: false skips the owner check entirely, even when ownerId matches", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "relation-only", actions: ["ryft.payment.approve"], blockResourceOwner: false },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(
      buildInput(alice, "ryft.payment.approve", { type: "ryft.payment", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // abstained — default deny, not SoD
  });

  await test("a resource with no ownerId at all is not a conflict — abstains", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(buildInput(alice, "ryft.payment.approve", { type: "ryft.payment", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── "requester != reviewer" / "key-rotator != sole approver" —
  //    conflictingRelations ──────────────────────────────────────────────

  await test('"requester != reviewer": an editor relation conflicts with a matching approve action → DENY', async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "editor");
    const constraints: SeparationOfDutyConstraint[] = [
      {
        id: "requester-not-reviewer",
        actions: ["sylo.vault.approve"],
        conflictingRelations: ["owner", "editor", "manager"],
      },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "SEPARATION_OF_DUTIES_VIOLATION");
    assert.match(decision.message ?? "", /"editor"/);
  });

  await test('"key-rotator != sole approver": rotator (owner relation) on an encryption key may not also approve rotation', async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.encryption_key", "7", "owner");
    const constraints: SeparationOfDutyConstraint[] = [
      {
        id: "key-rotator-not-approver",
        actions: ["sylo.encryption_key.approve"],
        conflictingRelations: ["owner", "editor", "manager"],
        message: "the key-rotator may not also approve their own rotation",
      },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.encryption_key.approve", { type: "sylo.encryption_key", id: 7 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.message, "the key-rotator may not also approve their own rotation");
  });

  await test("a merely-viewer relation does not conflict — abstains", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "viewer");
    const constraints: SeparationOfDutyConstraint[] = [
      {
        id: "requester-not-reviewer",
        actions: ["sylo.vault.approve"],
        conflictingRelations: ["owner", "editor", "manager"],
      },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // abstained
  });

  await test("holding only the approver relation itself is never a conflict — a legitimate approver may proceed", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "approver");
    const constraints: SeparationOfDutyConstraint[] = [
      {
        id: "requester-not-reviewer",
        actions: ["sylo.vault.approve"],
        conflictingRelations: ["owner", "editor", "manager"],
      },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // abstained — no conflicting relation held
  });

  await test("conflictingRelations set but no RelationshipProvider constructed — check is skipped, never throws", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      {
        id: "requester-not-reviewer",
        actions: ["sylo.vault.approve"],
        conflictingRelations: ["owner", "editor", "manager"],
      },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints)); // no provider
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // abstained, no crash
  });

  await test("no concrete resource.id — the relations check is skipped (nothing to look up)", async () => {
    const relationships = new FakeRelationshipProvider();
    const constraints: SeparationOfDutyConstraint[] = [
      {
        id: "requester-not-reviewer",
        actions: ["sylo.vault.approve"],
        conflictingRelations: ["owner", "editor", "manager"],
      },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item" }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── action matching ──────────────────────────────────────────────────

  await test("a constraint's actions filter only applies to matching actions — a different action abstains", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(
      buildInput(alice, "ryft.payment.read", { type: "ryft.payment", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // action not covered — abstained
  });

  await test("no registered constraints at all — abstains unconditionally", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule([]));
    const decision = await engine.evaluate(
      buildInput(alice, "ryft.payment.approve", { type: "ryft.payment", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("an omitted actions list applies to every action", async () => {
    const constraints: SeparationOfDutyConstraint[] = [{ id: "blanket" }];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(
      buildInput(alice, "admin.org.settings_update", { type: "admin.org", id: 9, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "SEPARATION_OF_DUTIES_VIOLATION");
  });

  // ── multiple constraints — first conflict found wins, all are checked ──

  await test("a later constraint's conflict is still found when an earlier constraint doesn't apply", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "manager");
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "unrelated", actions: ["ryft.payment.approve"] }, // does not match this action at all
      { id: "requester-not-reviewer", actions: ["sylo.vault.approve"], conflictingRelations: ["owner", "editor", "manager"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "SEPARATION_OF_DUTIES_VIOLATION");
  });

  // ── security suite ──────────────────────────────────────────────────

  await test("IDOR: a conflicting relation on resource 555 does not leak to a substituted resourceId 556", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "555", "editor");
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "requester-not-reviewer", actions: ["sylo.vault.approve"], conflictingRelations: ["owner", "editor", "manager"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 556 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // no relation on file for 556 — abstained
  });

  await test("cross-user: a conflicting relation granted to one user does not extend to a different subject", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "editor"); // bob only
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "requester-not-reviewer", actions: ["sylo.vault.approve"], conflictingRelations: ["owner", "editor", "manager"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const decision = await engine.evaluate(buildInput(carol, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // carol has no relation on file — abstained
  });

  await test("privilege escalation: a forged unrelated resource field does not manufacture a conflict", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(
      buildInput(bob, "ryft.payment.approve", {
        type: "ryft.payment",
        id: 42,
        ownerId: 1, // still alice's resource
        classification: "public", // forged/irrelevant field — must not matter
        organizationId: 999,
      } as ResourceRef),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // bob is not the owner — correctly abstained
  });

  await test("unauthenticated subject never reaches the separation-of-duties rule at all", async () => {
    const constraints: SeparationOfDutyConstraint[] = [{ id: "blanket" }];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    const decision = await engine.evaluate(buildInput(null, "ryft.payment.approve", { type: "ryft.payment", id: 42, ownerId: 1 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── composition/precedence ───────────────────────────────────────────

  await test("composition: SoD DENY beats an ownership ALLOW regardless of registration order", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const resource: ResourceRef = { type: "ryft.payment", id: 42, ownerId: 1 };

    const engineA = new PolicyEngine();
    engineA.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engineA.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));

    const engineB = new PolicyEngine();
    engineB.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    engineB.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());

    const decisionA = await engineA.evaluate(buildInput(alice, "ryft.payment.approve", resource));
    const decisionB = await engineB.evaluate(buildInput(alice, "ryft.payment.approve", resource));
    assert.equal(decisionA.effect, "DENY");
    assert.equal(decisionB.effect, "DENY");
    assert.equal(decisionA.reason, "SEPARATION_OF_DUTIES_VIOLATION");
    assert.equal(decisionB.reason, "SEPARATION_OF_DUTIES_VIOLATION");
  });

  await test("composition: when there is no conflict, SoD abstains and an ownership ALLOW passes through", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const resource: ResourceRef = { type: "ryft.payment", id: 42, ownerId: 2 }; // bob owns it, alice does not
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    // bob owns the resource, so ownership-rule allows bob to act on it, and
    // bob is also the owner the SoD "creator != approver" constraint is
    // about — bob is exactly who this constraint should block.
    const decision = await engine.evaluate(buildInput(bob, "ryft.payment.approve", resource));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "SEPARATION_OF_DUTIES_VIOLATION");
  });

  await test("composition: a genuinely different, non-owner approver is allowed through by another rule", async () => {
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "creator-not-approver", actions: ["ryft.payment.approve"] },
    ];
    const resource: ResourceRef = { type: "ryft.payment", id: 42, ownerId: 1 }; // alice created it
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints));
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    // carol did not create it and is not the owner per resource.ownerId, so
    // neither rule has anything to add — falls through to default deny
    // (ownership-rule only ALLOWs the actual owner; it never allows anyone
    // else, so this exercises the "SoD abstains, nothing else grants
    // either" path rather than a true ALLOW).
    const decision = await engine.evaluate(buildInput(carol, "ryft.payment.approve", resource));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── determinism ──────────────────────────────────────────────────────

  await test("deterministic: re-evaluating the exact same request object twice yields the exact same effect", async () => {
    const relationships = new FakeRelationshipProvider();
    relationships.grant(2, "sylo.vault_item", "42", "editor");
    const constraints: SeparationOfDutyConstraint[] = [
      { id: "requester-not-reviewer", actions: ["sylo.vault.approve"], conflictingRelations: ["owner", "editor", "manager"] },
    ];
    const engine = new PolicyEngine();
    engine.registerRule(SEPARATION_OF_DUTIES_POLICY_ID, createSeparationOfDutiesRule(constraints, relationships));
    const input = buildInput(bob, "sylo.vault.approve", { type: "sylo.vault_item", id: 42 });
    const first = await engine.evaluate(input);
    const second = await engine.evaluate(input);
    assert.equal(first.effect, second.effect);
    assert.equal(first.reason, second.reason);
    assert.equal(first.effect, "DENY");
  });

  console.log("Policy Engine — Phase 13 (Separation of Duties): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
