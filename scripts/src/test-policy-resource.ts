/**
 * scripts/src/test-policy-resource.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization), sub-phase 3A tests.
 *
 * Same shape as the other scripts/src/test-policy-*.ts files: DB-free,
 * runnable anywhere with nothing but
 *   npx tsx scripts/src/test-policy-resource.ts
 *
 * Covers the subset of the roadmap's Phase 03 test list that sub-phase 3A
 * actually implements (ownership + locked-resource restrictions):
 *   - ownership grants
 *   - resource-level deny (locked-resource restriction)
 *   - IDOR / resource-ID substitution
 *   - cross-user access
 * Organization access, explicit per-resource grants, and full cross-tenant
 * coverage are out of scope for 3A (see resource/index.ts's header) and
 * belong to a later Phase 03 sub-phase's own test file.
 *
 * Run: npx tsx scripts/src/test-policy-resource.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createResourceOwnershipRule,
  createLockedResourceRule,
  RESOURCE_OWNERSHIP_POLICY_ID,
  LOCKED_RESOURCE_POLICY_ID,
  type Subject,
  type ResourceRef,
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

function buildInput(
  subject: Subject | null,
  action: string,
  resource: ResourceRef,
): BuildAuthorizationRequestInput {
  return { subject, action, resource };
}

const alice: Subject = { userId: 1, role: "user", authType: "session" };
const bob: Subject = { userId: 2, role: "user", authType: "session" };

async function main() {
  console.log("Policy Engine — Phase 03A (Resource / Ownership) tests");

  // ── ownership-rule.ts ───────────────────────────────────────────────────

  await test("owner of the resource → ALLOW via ownership", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, RESOURCE_OWNERSHIP_POLICY_ID);
  });

  await test("cross-user access: non-owner gets no grant from ownership → default DENY", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    // bob requests alice's resource — ownership rule abstains (not the
    // owner), no other rule is registered, engine default-denies.
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("IDOR / resource-ID substitution: swapping the resource id alone does not grant access", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    // bob tries a range of resource ids that all still belong to alice
    // (ownerId unchanged) — no id value should ever fool the ownership
    // check into matching bob's userId.
    for (const id of [1, 2, 42, 999, "42", "alice-item"]) {
      const decision = await engine.evaluate(
        buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id, ownerId: 1 }),
      );
      assert.equal(decision.effect, "DENY", `expected DENY for substituted id ${JSON.stringify(id)}`);
    }
  });

  await test("resource with no ownerId at all → ownership rule abstains cleanly", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    const decision = await engine.evaluate(buildInput(alice, "sylo.vault.read", { type: "sylo.vault_item", id: 1 }));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // abstained, not a resource-ownership DENY
  });

  await test("privilege escalation: a client-forged resource.ownerId cannot be trusted to invent ownership of someone else's data", async () => {
    // This rule only ever compares whatever ownerId the PEP/route layer
    // supplied — it cannot detect a route that (incorrectly) forwarded a
    // client-supplied ownerId verbatim instead of looking up the real
    // owner. What IS this rule's job: given the REAL ownerId, a subject
    // whose userId differs never gets a ownership-based ALLOW, no matter
    // what other fields on the resource/request look like.
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", {
        type: "sylo.vault_item",
        id: 42,
        ownerId: 1, // the real owner is alice (userId 1), not bob (userId 2)
        organizationId: 1,
        classification: "public",
      }),
    );
    assert.equal(decision.effect, "DENY");
  });

  // ── locked-resource-rule.ts ──────────────────────────────────────────────

  await test("locked resource → explicit DENY (RESOURCE_LOCKED), even for the owner", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.update", { type: "sylo.vault_item", id: 42, ownerId: 1, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
    assert.equal(decision.policyId, LOCKED_RESOURCE_POLICY_ID);
  });

  await test("deny-overrides: lock DENY wins over ownership ALLOW regardless of registration order", async () => {
    const engineA = new PolicyEngine();
    engineA.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    engineA.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());

    const engineB = new PolicyEngine();
    engineB.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engineB.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());

    const resource: ResourceRef = { type: "sylo.vault_item", id: 42, ownerId: 1, locked: true };
    const decisionA = await engineA.evaluate(buildInput(alice, "sylo.vault.update", resource));
    const decisionB = await engineB.evaluate(buildInput(alice, "sylo.vault.update", resource));
    assert.equal(decisionA.effect, "DENY");
    assert.equal(decisionB.effect, "DENY");
    assert.equal(decisionA.reason, "RESOURCE_LOCKED");
    assert.equal(decisionB.reason, "RESOURCE_LOCKED");
  });

  await test("unlocked resource → lock rule abstains, ownership ALLOW stands", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.update", { type: "sylo.vault_item", id: 42, ownerId: 1, locked: false }),
    );
    assert.equal(decision.effect, "ALLOW");
  });

  await test("exemptActions: an explicitly exempted action stays available on a locked resource", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule({ exemptActions: ["sylo.vault.read"] }));
    const resource: ResourceRef = { type: "sylo.vault_item", id: 42, ownerId: 1, locked: true };

    const readDecision = await engine.evaluate(buildInput(alice, "sylo.vault.read", resource));
    assert.equal(readDecision.effect, "ALLOW"); // exempt — lock rule abstains, ownership ALLOW stands

    const updateDecision = await engine.evaluate(buildInput(alice, "sylo.vault.update", resource));
    assert.equal(updateDecision.effect, "DENY"); // not exempt — still blocked
    assert.equal(updateDecision.reason, "RESOURCE_LOCKED");
  });

  await test("default (no exemptActions passed): every action is blocked on a locked resource", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    for (const action of ["sylo.vault.read", "sylo.vault.update", "sylo.vault.delete"]) {
      const decision = await engine.evaluate(
        buildInput(alice, action, { type: "sylo.vault_item", id: 1, locked: true }),
      );
      assert.equal(decision.effect, "DENY", `expected DENY for action ${action}`);
      assert.equal(decision.reason, "RESOURCE_LOCKED");
    }
  });

  await test("locked-resource rule ignores ownership entirely — a non-owner on a locked resource still gets RESOURCE_LOCKED, not a generic default-deny", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.update", { type: "sylo.vault_item", id: 42, ownerId: 1, locked: true }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_LOCKED");
  });

  await test("unauthenticated subject never reaches either resource rule at all", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    engine.registerRule(LOCKED_RESOURCE_POLICY_ID, createLockedResourceRule());
    const decision = await engine.evaluate(
      buildInput(null, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 1 }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  console.log("Policy Engine — Phase 03A (Resource / Ownership): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
