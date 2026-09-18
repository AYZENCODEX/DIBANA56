/**
 * scripts/src/test-policy-declarative-risk.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Risk-Aware Authorization (Phase 10A).
 *
 * Declarative five-category coverage for `createRiskRule()`. Like
 * `test-policy-declarative-assurance.ts` and
 * `test-policy-declarative-locked-resource.ts`, this rule can only ever
 * DENY, STEP_UP, or abstain (never ALLOW — see risk-rule.ts's own header:
 * "both branches abstain, never grant"), so this suite registers it
 * ALONGSIDE `createResourceOwnershipRule()` on the same engine: the only
 * way a genuine `happy_path` ALLOW case exists for a gate-only rule.
 *
 *   - happy_path: `riskLevel: "low"` is "no risk objection on file" — the
 *     gate abstains, letting the owner's ALLOW through.
 *   - negative_path: `riskLevel: "high"` is denied unconditionally,
 *     regardless of ownership — deny-overrides beats the owner's ALLOW.
 *   - boundary: `riskLevel` entirely unset is treated identically to
 *     "low" (per the rule's own header: "a missing signal must never
 *     fail closed to something the roadmap didn't ask for") — the exact
 *     edge between "no risk engine has run yet" and "risk engine said
 *     low", both of which abstain the same way.
 *   - privilege_escalation: `riskLevel: "medium"` STEP_UPs rather than
 *     ALLOWing outright, even for the resource's own owner — meeting
 *     ownership does not let a MEDIUM-risk subject skip the stronger
 *     challenge this rule demands.
 *   - tenant_isolation: this rule has no organizational dimension at all
 *     — a same-organization subject with `riskLevel: "high"` is DENY'd
 *     exactly as any other subject would be; organization membership
 *     never substitutes for a risk determination.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-risk.ts
 */

import {
  PolicyEngine,
  createRiskRule,
  createResourceOwnershipRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type Subject,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: risk");

  const engine = new PolicyEngine();
  engine.registerRule("resource-ownership", createResourceOwnershipRule());
  engine.registerRule("risk", createRiskRule());

  const subject = (
    userId: number,
    organizationId: number | null = null,
    riskLevel?: "low" | "medium" | "high",
  ): Subject => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
    riskLevel,
  });

  const suite: PolicyTestSuite = {
    policyId: "risk",
    cases: [
      {
        name: "riskLevel low is no risk objection — the gate abstains, letting the owner's ALLOW through",
        category: "happy_path",
        given: {
          subject: subject(1, null, "low"),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 1 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "riskLevel high is denied unconditionally, regardless of ownership",
        category: "negative_path",
        given: {
          subject: subject(2, null, "high"),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 2 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "HIGH_RISK_DENIED", policyId: "risk" },
      },
      {
        name: "riskLevel entirely unset is treated identically to low — abstains, letting the owner's ALLOW through",
        category: "boundary",
        given: {
          subject: subject(3, null, undefined),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 3 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "riskLevel medium STEP_UPs even the resource's own owner — ownership does not bypass the risk gate",
        category: "privilege_escalation",
        given: {
          subject: subject(4, null, "medium"),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 4 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: "risk" },
      },
      {
        name: "a same-organization subject with riskLevel high is still DENY'd — no organizational dimension to this gate",
        category: "tenant_isolation",
        given: {
          subject: subject(5, 100, "high"),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 5, organizationId: 100 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "DENY", reason: "HIGH_RISK_DENIED", policyId: "risk" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B risk declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
