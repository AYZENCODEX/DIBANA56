/**
 * scripts/src/test-policy-test-framework.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21A (Policy Test
 * Framework — declarative model) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, no
 * Express server needed, runnable anywhere with
 *   npx tsx scripts/src/test-policy-test-framework.ts
 *
 * This suite tests the FRAMEWORK itself (runPolicyTestCase()/
 * runPolicyTestSuite()/assertPolicyTestSuitePassed() — ./lib/policy/
 * test-framework/runner.ts), using a real `PolicyEngine` wired with three
 * already-shipped rules (RBAC, resource-ownership, organization-access)
 * as its test subject. It is deliberately NOT the full Phase 21B effort
 * of writing five-category coverage for every policy rule in this engine
 * — see test-framework/types.ts's own header for that split. The suite
 * below ("vault-access") is a real, meaningful example of the declarative
 * model in action (worth keeping as living documentation of how to write
 * one), not a placeholder.
 *
 * Covers:
 *   - A real GIVEN/WHEN/THEN suite across all five roadmap categories,
 *     run against a real engine, reported as fully passing
 *   - runPolicyTestCase(): a mismatched expectation is reported in
 *     `failures`, never thrown
 *   - runPolicyTestCase(): optional `then` fields (policyId,
 *     requiredAssurance) are only checked when the case sets them
 *   - runPolicyTestSuite(): missing categories are reported, in the
 *     roadmap's own listed order, independent of whether the cases that
 *     ARE present all pass
 *   - assertPolicyTestSuitePassed(): silent on a passing suite; throws a
 *     readable summary (case names + failure lines + missing categories)
 *     on a failing one
 *
 * Run: npx tsx scripts/src/test-policy-test-framework.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createRbacRule,
  createResourceOwnershipRule,
  createOrganizationAccessRule,
  runPolicyTestCase,
  runPolicyTestSuite,
  assertPolicyTestSuitePassed,
  type RbacProvider,
  type RoleRecord,
  type PolicyTestSuite,
  type PolicyTestCase,
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

// ── Fakes (same shape as scripts/src/test-policy-rbac.ts's own fixture) ────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoles = new Map<number, Set<string>>();

  addRole(key: string): void {
    this.roles.set(key, { key, parentRoleKey: null });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }
  grant(roleKey: string, permissionKey: string): void {
    if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }
  assignUserRole(userId: number, roleKey: string): void {
    if (!this.userRoles.has(userId)) this.userRoles.set(userId, new Set());
    this.userRoles.get(userId)!.add(roleKey);
  }
  async getUserRoleKeys(userId: number): Promise<string[]> {
    return [...(this.userRoles.get(userId) ?? [])];
  }
  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }
  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.roles.get(roleKey) ?? null;
  }
}

async function main() {
  console.log("Policy Test Framework — Phase 21A tests");

  // ── A real GIVEN/WHEN/THEN suite, all five categories, fully passing ────

  const provider = new FakeRbacProvider();
  // "member" is the shared baseline role (assigned to every subject below)
  // and deliberately carries NO permissions of its own — the read grant
  // lives only on "vault-reader", assigned to subject 1 alone, so that
  // subjects 2/4/5/6 genuinely lack an RBAC-granted read and must fall
  // through to whichever other rule (ownership / organization-access /
  // default-deny) actually decides their case. Granting the read
  // permission on the shared "member" role instead would silently ALLOW
  // every subject via RBAC and defeat the negative_path/tenant_isolation
  // cases below before organization-access ever got a chance to run.
  provider.addRole("member");
  provider.addRole("vault-reader");
  provider.grant("vault-reader", "sylo.vault.read");
  provider.assignUserRole(1, "vault-reader"); // subject 1: has the read grant
  provider.assignUserRole(2, "member"); // subject 2: no read grant at all
  provider.assignUserRole(3, "member"); // subject 3: owner of resource "9"
  provider.assignUserRole(4, "member"); // subject 4: no grant, no ownership, no org
  provider.assignUserRole(5, "member"); // subject 5: organization 100 member
  provider.assignUserRole(6, "member"); // subject 6: organization 200 member

  const engine = new PolicyEngine();
  engine.registerRule("rbac", createRbacRule(provider));
  engine.registerRule("resource-ownership", createResourceOwnershipRule());
  engine.registerRule("organization-access", createOrganizationAccessRule());

  const subject = (userId: number, organizationId?: number) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId: organizationId ?? null,
  });

  const vaultAccessSuite: PolicyTestSuite = {
    policyId: "vault-access",
    cases: [
      {
        name: "a subject with the RBAC read grant may read a vault item",
        category: "happy_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "rbac" },
      },
      {
        name: "a subject without the read grant, not the owner, not same-org, cannot read",
        category: "negative_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "2" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "the exact resource owner may delete it, with no RBAC grant for delete at all",
        category: "boundary",
        given: {
          subject: subject(3),
          resource: { type: "sylo.vault_item", id: "9", ownerId: 3 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "a non-owner, non-permitted subject cannot delete someone else's vault item",
        category: "privilege_escalation",
        given: {
          subject: subject(4),
          resource: { type: "sylo.vault_item", id: "9", ownerId: 3 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a same-organization subject may read an org-scoped vault item",
        category: "tenant_isolation",
        given: {
          subject: subject(5, 100),
          resource: { type: "sylo.vault_item", id: "10", organizationId: 100 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "organization-access" },
      },
      {
        name: "a different-organization subject may NOT read another tenant's vault item",
        category: "tenant_isolation",
        given: {
          subject: subject(6, 200),
          resource: { type: "sylo.vault_item", id: "10", organizationId: 100 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
    ],
  };

  await test("runPolicyTestSuite(): the vault-access suite fully passes, all five categories present", async () => {
    const result = await runPolicyTestSuite(engine, vaultAccessSuite);
    assert.equal(result.missingCategories.length, 0);
    assert.equal(
      result.results.every((r) => r.passed),
      true,
    );
    assert.equal(result.passed, true);
    assert.doesNotThrow(() => assertPolicyTestSuitePassed(result));
  });

  // ── A mismatched expectation is reported, never thrown ──────────────────

  await test("runPolicyTestCase(): a wrong expectation is reported in failures, decision still returned", async () => {
    const wrongCase: PolicyTestCase = {
      name: "deliberately wrong: expects DENY where the engine actually ALLOWs",
      category: "happy_path",
      given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
      when: { action: "sylo.vault.read" },
      then: { effect: "DENY" },
    };
    const result = await runPolicyTestCase(engine, wrongCase);
    assert.equal(result.passed, false);
    assert.equal(result.decision.effect, "ALLOW");
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /expected DENY, got ALLOW/);
  });

  // ── Optional `then` fields are only checked when the case sets them ─────

  await test("runPolicyTestCase(): omitted policyId/requiredAssurance are never checked", async () => {
    const looseCase: PolicyTestCase = {
      name: "only cares about the effect, not which rule fired",
      category: "happy_path",
      given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
      when: { action: "sylo.vault.read" },
      then: { effect: "ALLOW" }, // no reason/policyId/requiredAssurance asserted
    };
    const result = await runPolicyTestCase(engine, looseCase);
    assert.equal(result.passed, true);
    assert.deepEqual(result.failures, []);
  });

  // ── Missing-category reporting, independent of whether present cases pass ─

  await test("runPolicyTestSuite(): reports every missing category, in roadmap order", async () => {
    const happyOnlySuite: PolicyTestSuite = {
      policyId: "happy-only-example",
      cases: [
        {
          name: "only a happy path case exists in this suite",
          category: "happy_path",
          given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
          when: { action: "sylo.vault.read" },
          then: { effect: "ALLOW" },
        },
      ],
    };
    const result = await runPolicyTestSuite(engine, happyOnlySuite);
    assert.deepEqual(result.missingCategories, [
      "negative_path",
      "boundary",
      "privilege_escalation",
      "tenant_isolation",
    ]);
    assert.equal(result.passed, false); // fails on coverage, even though the one case passed
    assert.equal(result.results[0].passed, true);
  });

  // ── assertPolicyTestSuitePassed() throws a readable summary ──────────────

  await test("assertPolicyTestSuitePassed(): throws naming the failing case and the missing categories", async () => {
    const brokenSuite: PolicyTestSuite = {
      policyId: "broken-example",
      cases: [
        {
          name: "wrongly expects DENY",
          category: "happy_path",
          given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
          when: { action: "sylo.vault.read" },
          then: { effect: "DENY" },
        },
      ],
    };
    const result = await runPolicyTestSuite(engine, brokenSuite);
    assert.throws(() => assertPolicyTestSuitePassed(result), (err: unknown) => {
      const message = (err as Error).message;
      return (
        message.includes("broken-example") &&
        message.includes("wrongly expects DENY") &&
        message.includes("missing required categories")
      );
    });
  });

  console.log("\nAll Phase 21A policy test framework tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
