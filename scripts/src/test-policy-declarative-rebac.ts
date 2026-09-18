/**
 * scripts/src/test-policy-declarative-rebac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), ReBAC (Phase 04).
 *
 * Declarative five-category coverage for `createRebacRule()` in isolation.
 *
 *   - happy_path: a subject holding the "editor" relation on a resource
 *     may perform a write-class action (relation-action-map.ts's own
 *     EDITOR verb coverage: read + write).
 *   - negative_path: a subject holding only "viewer" (read-only verb
 *     coverage) attempts a write action → default-deny.
 *   - boundary: a subject holding "approver" (read + approve, explicitly
 *     NOT write per relation-action-map.ts's own table) attempts to
 *     "approve" — the exact edge of what that relation covers, distinct
 *     from a write action a viewer/approver both lack.
 *   - privilege_escalation: a subject holding "viewer" on resource A
 *     requests the SAME action against resource B, on which they hold no
 *     relation at all — relationships are per-resource-instance
 *     (`resource.id` is part of the lookup key), so a relation on one
 *     resource grants nothing on another; forging `resource.id` in the
 *     request to try to reuse a real relation held elsewhere fails.
 *   - tenant_isolation: two subjects each hold "owner" on their OWN
 *     resource in different organizations; a cross-organization read
 *     attempt (subject from org A requesting org B's resource, on which
 *     they hold no relation) is denied — relationships carry no implicit
 *     cross-tenant reach.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-rebac.ts
 */

import {
  PolicyEngine,
  createRebacRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type RelationshipProvider,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

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

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: ReBAC");

  const provider = new FakeRelationshipProvider();
  provider.grant(1, "sylo.vault_item", "1", "editor"); // subject 1: editor on resource 1
  provider.grant(2, "sylo.vault_item", "1", "viewer"); // subject 2: viewer on resource 1 (read-only)
  provider.grant(3, "sylo.vault_item", "1", "approver"); // subject 3: approver on resource 1 (read + approve)
  provider.grant(4, "sylo.vault_item", "1", "viewer"); // subject 4: viewer on resource 1 ONLY — nothing on resource 2
  provider.grant(5, "sylo.vault_item", "100", "owner"); // subject 5: owner of org-100's resource 100
  provider.grant(6, "sylo.vault_item", "200", "owner"); // subject 6: owner of org-200's resource 200

  const engine = new PolicyEngine();
  engine.registerRule("rebac", createRebacRule(provider));

  const subject = (userId: number, organizationId: number | null = null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const suite: PolicyTestSuite = {
    policyId: "rebac",
    cases: [
      {
        name: "an editor may write to the resource they hold that relation on",
        category: "happy_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.update" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "rebac" },
      },
      {
        name: "a viewer (read-only relation) attempting a write action is denied by default-deny",
        category: "negative_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.update" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "an approver may approve (their relation's exact verb coverage) but this is the edge — approve is not part of viewer/editor coverage",
        category: "boundary",
        given: { subject: subject(3), resource: { type: "sylo.vault_item", id: "1" } },
        when: { action: "sylo.vault.approve" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "rebac" },
      },
      {
        name: "a relation held on one resource instance grants nothing on a different resource id, even the same action a real relation there would cover",
        category: "privilege_escalation",
        given: { subject: subject(4), resource: { type: "sylo.vault_item", id: "2" } },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "an owner in one organization holds no relation on a different organization's resource — no implicit cross-tenant reach",
        category: "tenant_isolation",
        given: {
          subject: subject(5, 100),
          resource: { type: "sylo.vault_item", id: "200", organizationId: 200 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B ReBAC declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
