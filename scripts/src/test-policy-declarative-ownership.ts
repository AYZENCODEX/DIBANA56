/**
 * scripts/src/test-policy-declarative-ownership.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Resource Ownership (Phase 03A).
 *
 * Declarative five-category coverage for `createResourceOwnershipRule()`
 * in isolation — one `PolicyEngine` with only that rule registered.
 *
 *   - happy_path: the resource's owner may act on it.
 *   - negative_path: a non-owner, with no other grant path registered, is
 *     denied by default-deny.
 *   - boundary: a resource with NO `ownerId` at all (not merely a
 *     different one) — the rule must abstain on a missing fact, not treat
 *     `undefined !== subject.userId` as a mismatch that somehow still
 *     resolves one way or the other; observed here as the same
 *     default-deny outcome as negative_path, but exercised as its own
 *     case since it is a genuinely different code path inside the rule
 *     (`ownerId === undefined` short-circuits before the comparison).
 *   - privilege_escalation: a subject forges `resource.ownerId` to equal
 *     their OWN userId on a resource they do not actually own — this rule
 *     trusts whatever `ownerId` the caller populated verbatim (see
 *     ownership-rule.ts's own header: "only as trustworthy as the PEP
 *     call site that populated it"), so from this rule's own narrow
 *     perspective the forged claim succeeds. This case exists to pin
 *     down and document that trust boundary precisely, not to claim the
 *     rule is broken — the real defense is the PEP/route layer never
 *     accepting a client-supplied `ownerId` for an existing resource,
 *     which is out of scope for this rule (see file's own header).
 *   - tenant_isolation: ownership alone crosses organizational lines by
 *     design — an owner in one organization still owns their resource
 *     even when compared against a subject request carrying a different
 *     `organizationId`, because this rule never reads `organizationId` at
 *     all. Documents that boundary rather than skipping the category.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-ownership.ts
 */

import {
  PolicyEngine,
  createResourceOwnershipRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: resource ownership");

  const engine = new PolicyEngine();
  engine.registerRule("resource-ownership", createResourceOwnershipRule());

  const subject = (userId: number, organizationId: number | null = null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const suite: PolicyTestSuite = {
    policyId: "resource-ownership",
    cases: [
      {
        name: "the resource's actual owner may act on it",
        category: "happy_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1", ownerId: 1 } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "a subject who is not the owner is denied by default-deny",
        category: "negative_path",
        given: { subject: subject(2), resource: { type: "sylo.vault_item", id: "1", ownerId: 1 } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a resource with no ownerId at all abstains (missing fact, not a mismatch) and default-denies",
        category: "boundary",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "2" } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "forging resource.ownerId to equal the requester's own userId succeeds from this rule's own narrow view — the trust boundary this rule documents",
        category: "privilege_escalation",
        given: { subject: subject(3), resource: { type: "sylo.vault_item", id: "3", ownerId: 3 } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "ownership alone grants access regardless of the subject's organizationId — this rule has no tenant concept",
        category: "tenant_isolation",
        given: {
          subject: subject(1, 100),
          resource: { type: "sylo.vault_item", id: "4", ownerId: 1, organizationId: 200 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B resource-ownership declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
