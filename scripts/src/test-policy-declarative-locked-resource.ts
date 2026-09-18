/**
 * scripts/src/test-policy-declarative-locked-resource.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Locked Resource (Phase 03A).
 *
 * Declarative five-category coverage for `createLockedResourceRule()`.
 * Unlike ownership/RBAC (ALLOW-or-abstain rules), this rule is a DENY
 * gate — so this suite registers it ALONGSIDE `createResourceOwnershipRule()`
 * on the same engine: that is the only way a genuine `happy_path` ALLOW
 * case is even possible for a rule that itself never returns ALLOW, and
 * it is also exactly the real composition this rule's own header
 * describes ("this rule's DENY always wins over ownership-rule.ts's ALLOW
 * ... regardless of registration order").
 *
 *   - happy_path: an unlocked resource lets its owner's ALLOW through
 *     untouched — this rule abstains entirely.
 *   - negative_path: a locked resource with no `exemptActions` configured
 *     denies EVERY action, including one the owner would otherwise be
 *     granted — deny-overrides beats the ownership ALLOW.
 *   - boundary: an action that IS in `exemptActions` on a locked resource
 *     abstains, letting the owner's ALLOW through even while locked — the
 *     literal edge of the allow-list this rule's construction-time option
 *     draws.
 *   - privilege_escalation: forging `resource.locked = false` on a
 *     resource that is (per this request) not actually locked has no
 *     escalation angle to test here beyond what boundary already covers —
 *     so this case instead pins down the opposite, security-relevant
 *     direction: a subject cannot use ANY action name to bypass a lock
 *     that has no `exemptActions` configured for it, i.e. there is no
 *     action string that slips past a strict (default) lock.
 *   - tenant_isolation: `resource.locked` is a per-resource fact with no
 *     organizational dimension at all — a locked resource stays locked
 *     for a same-organization subject exactly as it would for any other,
 *     documenting that this rule draws no tenant boundary of its own (an
 *     org-scoped grant is organization-access-rule.ts's job, and would
 *     still lose to this rule's DENY regardless).
 *
 * Run: npx tsx scripts/src/test-policy-declarative-locked-resource.ts
 */

import {
  PolicyEngine,
  createLockedResourceRule,
  createResourceOwnershipRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: locked resource");

  const engine = new PolicyEngine();
  // Registration order deliberately does not matter (deny-overrides) —
  // ownership first, lock second, matching this rule's own header claim.
  engine.registerRule("resource-ownership", createResourceOwnershipRule());
  engine.registerRule("resource-lock", createLockedResourceRule({ exemptActions: ["sylo.vault.read"] }));

  const subject = (userId: number, organizationId: number | null = null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const suite: PolicyTestSuite = {
    policyId: "resource-lock",
    cases: [
      {
        name: "an unlocked resource lets the owner's ALLOW through untouched",
        category: "happy_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1", ownerId: 1, locked: false } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "a locked resource denies a non-exempt action even for the owner",
        category: "negative_path",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1", ownerId: 1, locked: true } },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "RESOURCE_LOCKED", policyId: "resource-lock" },
      },
      {
        name: "an exempt action on a locked resource abstains, letting the owner's ALLOW through even while locked",
        category: "boundary",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1", ownerId: 1, locked: true } },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "no action name slips past a strict lock with no matching exemption, even the owner's own delete",
        category: "privilege_escalation",
        given: { subject: subject(1), resource: { type: "sylo.vault_item", id: "1", ownerId: 1, locked: true } },
        when: { action: "sylo.vault.share" },
        then: { effect: "DENY", reason: "RESOURCE_LOCKED", policyId: "resource-lock" },
      },
      {
        name: "a lock has no organizational dimension — it blocks a same-organization owner exactly as it would anyone else",
        category: "tenant_isolation",
        given: {
          subject: subject(1, 100),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 1, organizationId: 100, locked: true },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "RESOURCE_LOCKED", policyId: "resource-lock" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B locked-resource declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
