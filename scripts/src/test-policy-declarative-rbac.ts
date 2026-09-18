/**
 * scripts/src/test-policy-declarative-rbac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), RBAC (Phase 02).
 *
 * Applies Phase 21A's declarative GIVEN/WHEN/THEN framework
 * (./lib/policy/test-framework) to `createRbacRule()` in isolation — one
 * `PolicyEngine` with ONLY the RBAC rule registered, so a decision this
 * suite observes can only ever have come from RBAC itself (or the
 * engine's own default-deny). This is a DIFFERENT, narrower fixture than
 * `test-policy-test-framework.ts`'s own "vault-access" suite, which
 * exercises RBAC alongside resource-ownership and organization-access as
 * a worked example of composing several rules — this file is RBAC's own,
 * dedicated five-category coverage review per Phase 21B's own scope (see
 * ./lib/policy/test-framework/types.ts's header).
 *
 * Five categories, all against `sylo.vault.read` / `sylo.vault.delete`:
 *   - happy_path: a subject whose role grants `sylo.vault.read` reads it.
 *   - negative_path: a subject with a role but no matching grant is
 *     denied (default-deny — RBAC itself only ever abstains, never
 *     denies; see rbac-rule.ts's own "ABSTAIN, not DENY" header note).
 *   - boundary: a trailing-wildcard grant (`sylo.vault.*`) covers an
 *     action a concrete grant would not, exercising `permissionMatches()`'s
 *     wildcard grammar at its literal boundary.
 *   - privilege_escalation: a subject with no matching grant forges
 *     `resource.ownerId` to claim ownership of the very resource they are
 *     requesting — RBAC reads only `Subject`/`request.action`, never any
 *     `ResourceRef` field (see rbac-rule.ts's own header: "the only
 *     client-influenced input this rule reads at all is `request.subject`"),
 *     so the forged field has zero effect and the request is still denied
 *     by default-deny.
 *   - tenant_isolation: RBAC grants by permission, not by tenant — a role
 *     grant covers the action for ANY resource instance regardless of
 *     organization, so this category's case documents that RBAC alone
 *     provides no tenant isolation at all (that is organization-access's
 *     job, covered in its own dedicated suite) and asserts exactly that
 *     boundary rather than skipping the category.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-rbac.ts
 */

import {
  PolicyEngine,
  createRbacRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type RbacProvider,
  type RoleRecord,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

// ── Fake provider (same shape as scripts/src/test-policy-rbac.ts's own) ────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoles = new Map<number, Set<string>>();

  addRole(key: string, parentRoleKey: string | null = null): void {
    this.roles.set(key, { key, parentRoleKey });
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
  console.log("Policy Test Framework — Phase 21B declarative coverage: RBAC");

  const provider = new FakeRbacProvider();

  // Subject 1: concrete grant for sylo.vault.read.
  provider.addRole("vault-reader");
  provider.grant("vault-reader", "sylo.vault.read");
  provider.assignUserRole(1, "vault-reader");

  // Subject 2: a role, but no grant covering sylo.vault.read at all.
  provider.addRole("bystander");
  provider.assignUserRole(2, "bystander");

  // Subject 3: trailing-wildcard grant covering the whole vault resource.
  provider.addRole("vault-admin");
  provider.grant("vault-admin", "sylo.vault.*");
  provider.assignUserRole(3, "vault-admin");

  // Subject 4: same "bystander" role as subject 2 (no matching grant) —
  // used for the privilege-escalation case, which forges resource.ownerId
  // rather than adding a new role, since RBAC reads no ResourceRef field
  // at all (see below).
  provider.assignUserRole(4, "bystander");

  // Subject 5: same "vault-reader" grant as subject 1, requesting a
  // DIFFERENT organization's resource — RBAC has no concept of
  // organization at all, so it still ALLOWs (see tenant_isolation case).
  provider.assignUserRole(5, "vault-reader");

  const engine = new PolicyEngine();
  engine.registerRule("rbac", createRbacRule(provider));

  const subject = (userId: number) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId: null,
  });

  const suite: PolicyTestSuite = {
    policyId: "rbac",
    cases: [
      {
        name: "a subject whose role grants sylo.vault.read may read a vault item",
        category: "happy_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "rbac" },
      },
      {
        name: "a subject with a role but no matching grant is denied by default-deny",
        category: "negative_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "2" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a trailing-wildcard grant (sylo.vault.*) covers a concrete action it never named directly",
        category: "boundary",
        given: { subject: subject(3), resource: { type: "sylo.vault_item", id: "3" } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "rbac" },
      },
      {
        name: "forging resource.ownerId to claim self-ownership has no effect on RBAC — still denied",
        category: "privilege_escalation",
        given: {
          subject: subject(4),
          resource: { type: "sylo.vault_item", id: "4", ownerId: 4 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "RBAC alone grants a role permission regardless of organization — no tenant isolation from this rule by itself",
        category: "tenant_isolation",
        given: {
          subject: subject(5),
          resource: { type: "sylo.vault_item", id: "10", organizationId: 999 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "rbac" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B RBAC declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
