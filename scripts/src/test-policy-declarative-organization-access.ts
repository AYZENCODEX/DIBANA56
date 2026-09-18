/**
 * scripts/src/test-policy-declarative-organization-access.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Organization Access (Phase 03C).
 *
 * Declarative five-category coverage for `createOrganizationAccessRule()`
 * in isolation. This is a DEDICATED suite for the rule on its own — the
 * "vault-access" example suite in `test-policy-test-framework.ts` (Phase
 * 21A) exercises it only as part of a worked, multi-rule composition
 * example, with two tenant_isolation cases and no boundary/privilege-
 * escalation case of its own; this file gives the rule its own,
 * from-scratch five-category review per Phase 21B's own scope.
 *
 *   - happy_path: same-organization subject and resource → ALLOW.
 *   - negative_path: different-organization subject and resource →
 *     default-deny (this is ALSO the rule's tenant_isolation case in
 *     spirit — see that category below for why a second, distinct case
 *     still earns its own slot).
 *   - boundary: a resource with `organizationId: null` (explicitly no
 *     organization at all, distinct from merely "different") abstains —
 *     "no organization fact to compare" is not the same as "organization
 *     mismatch", exactly like ownership-rule.ts's own missing-fact
 *     boundary case.
 *   - privilege_escalation: a subject forges `resource.organizationId` to
 *     equal their OWN `organizationId` — this rule trusts whatever
 *     `organizationId` the caller populated on the resource verbatim
 *     (same trust boundary this rule's own header documents for
 *     ownership-rule.ts's `ownerId`), so the forged claim succeeds from
 *     this rule's own narrow view. Pins down that trust boundary
 *     explicitly, same posture the ownership suite takes for its own
 *     analogous case — the actual defense is the PEP/route layer never
 *     trusting a client-supplied `resource.organizationId`, out of this
 *     rule's scope.
 *   - tenant_isolation: the canonical cross-tenant case — a subject in
 *     organization 200 is denied access to organization 100's resource,
 *     via default-deny (this rule only ever abstains, never denies —
 *     see the rule's own header).
 *
 * Run: npx tsx scripts/src/test-policy-declarative-organization-access.ts
 */

import {
  PolicyEngine,
  createOrganizationAccessRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: organization access");

  const engine = new PolicyEngine();
  engine.registerRule("organization-access", createOrganizationAccessRule());

  const subject = (userId: number, organizationId: number | null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const suite: PolicyTestSuite = {
    policyId: "organization-access",
    cases: [
      {
        name: "a same-organization subject may access the resource",
        category: "happy_path",
        given: {
          subject: subject(1, 100),
          resource: { type: "sylo.vault_item", id: "1", organizationId: 100 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "organization-access" },
      },
      {
        name: "a different-organization subject is denied by default-deny",
        category: "negative_path",
        given: {
          subject: subject(2, 200),
          resource: { type: "sylo.vault_item", id: "1", organizationId: 100 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a resource with organizationId explicitly null has no org fact to compare — abstains and default-denies",
        category: "boundary",
        given: {
          subject: subject(1, 100),
          resource: { type: "sylo.vault_item", id: "2", organizationId: null },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "forging resource.organizationId to equal the subject's own org succeeds from this rule's own narrow view — the trust boundary this rule documents",
        category: "privilege_escalation",
        given: {
          subject: subject(3, 100),
          resource: { type: "sylo.vault_item", id: "3", organizationId: 100 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "organization-access" },
      },
      {
        name: "a subject in organization 200 may not read organization 100's resource — canonical cross-tenant denial",
        category: "tenant_isolation",
        given: {
          subject: subject(4, 200),
          resource: { type: "sylo.vault_item", id: "4", organizationId: 100 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B organization-access declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
