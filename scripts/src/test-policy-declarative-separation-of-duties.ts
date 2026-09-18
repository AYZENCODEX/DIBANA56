/**
 * scripts/src/test-policy-declarative-separation-of-duties.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Separation of Duties (Phase 13).
 *
 * Declarative five-category coverage for `createSeparationOfDutiesRule()`.
 * Like `test-policy-declarative-assurance.ts` and
 * `test-policy-declarative-locked-resource.ts`, this rule can only ever
 * DENY or abstain (never ALLOW — see separation-of-duties-rule.ts's own
 * header: "this rule NEVER returns ALLOW"), so this suite registers it
 * ALONGSIDE `createResourceOwnershipRule()` on the same engine: the only
 * way a genuine `happy_path` ALLOW case exists for a gate-only rule.
 *
 * One constraint is registered: "creator != approver" on
 * `sylo.vault.approve` (`blockResourceOwner: true`), plus a
 * `conflictingRelations: ["editor"]` check ("requester != reviewer" —
 * anyone who can write the resource may not also approve it) backed by a
 * fake `RelationshipProvider`.
 *
 *   - happy_path: a plain read (an action outside the registered
 *     constraint's `actions` scope — only `sylo.vault.approve` is
 *     constrained) never reaches either conflict check, even for the
 *     resource's own creator — the gate abstains entirely, letting the
 *     owner's ALLOW through.
 *   - negative_path: the resource's own creator (`ownerId === subject.userId`)
 *     attempts to approve their own resource → DENY,
 *     `SEPARATION_OF_DUTIES_VIOLATION` — the roadmap's own "creator !=
 *     approver" example.
 *   - boundary: a subject who is NOT the owner but holds the registered
 *     `conflictingRelations` relation ("editor") on the exact resource
 *     being approved is denied via the relations check specifically —
 *     the edge between the two independent checks this rule runs (owner
 *     check passes, relations check is what catches it).
 *   - privilege_escalation: a subject forges `resource.ownerId` to equal
 *     their OWN userId on a resource they do not actually own, then
 *     attempts to approve it — this rule trusts whatever `ownerId` the
 *     caller populated verbatim (the same trust boundary
 *     ownership-rule.ts's own header documents), so the forged claim
 *     still triggers the DENY from this rule's own narrow view — pinning
 *     down that the forged-ownership case is caught (denied), not that it
 *     slips through, which is this rule's entire point for the "creator"
 *     side of separation of duties.
 *   - tenant_isolation: the registered constraint has no organizational
 *     dimension at all — a same-organization creator attempting to
 *     approve their own resource is denied exactly as any other creator
 *     would be; organization membership never substitutes for the
 *     conflict check.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-separation-of-duties.ts
 */

import {
  PolicyEngine,
  createSeparationOfDutiesRule,
  createResourceOwnershipRule,
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
  console.log("Policy Test Framework — Phase 21B declarative coverage: separation of duties");

  const relationships = new FakeRelationshipProvider();
  relationships.grant(3, "sylo.vault_item", "3", "editor"); // subject 3: editor on resource 3 (conflicts with approve)

  const engine = new PolicyEngine();
  engine.registerRule("resource-ownership", createResourceOwnershipRule());
  engine.registerRule(
    "separation-of-duties",
    createSeparationOfDutiesRule(
      [
        {
          id: "vault-approve-creator-conflict",
          actions: ["sylo.vault.approve"],
          blockResourceOwner: true,
          conflictingRelations: ["editor"],
        },
      ],
      relationships,
    ),
  );

  const subject = (userId: number, organizationId: number | null = null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const suite: PolicyTestSuite = {
    policyId: "separation-of-duties",
    cases: [
      {
        name: "an action outside this constraint's scope (a plain read, not approve) never reaches the conflict check — the gate abstains, letting the owner's ALLOW through even though they created the resource",
        category: "happy_path",
        given: {
          subject: subject(1),
          resource: { type: "sylo.vault_item", id: "10", ownerId: 1 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "the resource's own creator may not also approve it — the roadmap's own creator != approver example",
        category: "negative_path",
        given: {
          subject: subject(2),
          resource: { type: "sylo.vault_item", id: "2", ownerId: 2 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "DENY", reason: "SEPARATION_OF_DUTIES_VIOLATION", policyId: "separation-of-duties" },
      },
      {
        name: "a non-owner who holds the registered conflicting relation (editor) on this exact resource is denied via the relations check",
        category: "boundary",
        given: {
          subject: subject(3),
          resource: { type: "sylo.vault_item", id: "3", ownerId: 99 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "DENY", reason: "SEPARATION_OF_DUTIES_VIOLATION", policyId: "separation-of-duties" },
      },
      {
        name: "forging resource.ownerId to equal the requester's own userId still triggers the creator-conflict DENY from this rule's own narrow view",
        category: "privilege_escalation",
        given: {
          subject: subject(4),
          resource: { type: "sylo.vault_item", id: "4", ownerId: 4 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "DENY", reason: "SEPARATION_OF_DUTIES_VIOLATION", policyId: "separation-of-duties" },
      },
      {
        name: "a same-organization creator is denied exactly as any other creator would be — no organizational dimension to this gate",
        category: "tenant_isolation",
        given: {
          subject: subject(5, 100),
          resource: { type: "sylo.vault_item", id: "5", ownerId: 5, organizationId: 100 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "DENY", reason: "SEPARATION_OF_DUTIES_VIOLATION", policyId: "separation-of-duties" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B separation-of-duties declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
