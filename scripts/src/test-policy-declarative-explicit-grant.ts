/**
 * scripts/src/test-policy-declarative-explicit-grant.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Explicit Resource Grants (Phase 03B).
 *
 * Declarative five-category coverage for `createExplicitResourceGrantRule()`
 * in isolation.
 *
 *   - happy_path: a non-owner with an explicit "allow" grant row for the
 *     exact (subject, resource, action) tuple is granted.
 *   - negative_path: no matching row on file at all → default-deny.
 *   - boundary: exact-match-only — a grant row for resource id "42" does
 *     NOT cover a request for resource id "43", even same type/action/
 *     subject; one digit off the boundary of "exact match" is a miss.
 *   - privilege_escalation: an explicit per-resource DENY beats an ALLOW
 *     this same rule would otherwise grant — a subject cannot escalate by
 *     also holding an allow row when a more specific deny row exists for
 *     the identical tuple (this rule's own two-sided, deny-wins-by-
 *     construction posture, since only one row is stored per tuple, and
 *     this case exercises it directly against a resource the subject also
 *     happens to own, showing the explicit DENY still fires here even
 *     though ownership-rule.ts, if it were also registered, would ALLOW —
 *     the deny is checked and returned before this rule ever reaches its
 *     own allow branch).
 *   - tenant_isolation: an allow grant scoped to one resource instance
 *     does not cover the "same" resource TYPE/action in a different
 *     organization's instance — a different `resource.id` is a different
 *     lookup key entirely, so a grant in one tenant's resource never
 *     leaks into another's, exercised the same way boundary's mismatch
 *     case is, but framed around two different organizations' resource
 *     ids specifically.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-explicit-grant.ts
 */

import {
  PolicyEngine,
  createExplicitResourceGrantRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type ResourceGrantProvider,
  type ResourceGrantEntry,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

class FakeResourceGrantProvider implements ResourceGrantProvider {
  private readonly grants = new Map<string, ResourceGrantEntry>();

  private key(subjectUserId: number, resourceType: string, resourceId: string, action: string): string {
    return `${subjectUserId}::${resourceType}::${resourceId}::${action}`;
  }

  setGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string, entry: ResourceGrantEntry): void {
    this.grants.set(this.key(subjectUserId, resourceType, resourceId, action), entry);
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

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: explicit resource grants");

  const provider = new FakeResourceGrantProvider();

  // Subject 2: explicit allow on resource "42" for read — a plain share.
  provider.setGrant(2, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow", reason: "shared by owner" });

  // Subject 3: explicit DENY on resource "50" for delete, despite also
  // (per the request's own resource.ownerId) appearing to own it.
  provider.setGrant(3, "sylo.vault_item", "50", "sylo.vault.delete", {
    effect: "deny",
    reason: "resource frozen pending compliance review",
  });

  const engine = new PolicyEngine();
  engine.registerRule("resource-grant", createExplicitResourceGrantRule(provider));

  const subject = (userId: number) => ({ userId, role: "member", authType: "session" as const, organizationId: null });

  const suite: PolicyTestSuite = {
    policyId: "resource-grant",
    cases: [
      {
        name: "an explicit allow grant lets a non-owner read the exact resource it names",
        category: "happy_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "42", ownerId: 1 } },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-grant" },
      },
      {
        name: "no grant row on file at all → default-deny",
        category: "negative_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "999" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a grant for resource id 42 does not cover resource id 43 — exact match only",
        category: "boundary",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "43" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "an explicit deny row beats even an apparent ownership claim on the identical tuple",
        category: "privilege_escalation",
        given: { subject: subject(3), resource: { type: "sylo.vault_item", id: "50", ownerId: 3 } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "RESOURCE_GRANT_DENIED", policyId: "resource-grant" },
      },
      {
        name: "a grant scoped to one resource instance never leaks into a different organization's differently-id'd resource",
        category: "tenant_isolation",
        given: {
          subject: subject(2),
          resource: { type: "sylo.vault_item", id: "42-org-b", organizationId: 200 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B explicit-resource-grant declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
