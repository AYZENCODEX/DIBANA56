/**
 * scripts/src/test-policy-declarative-assurance.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Authentication Assurance (Phase 09A).
 *
 * Declarative five-category coverage for `createAssuranceRule()`. Like
 * `test-policy-declarative-locked-resource.ts`, this rule can only ever
 * STEP_UP or abstain (never ALLOW — see assurance-rule.ts's own header),
 * so this suite registers it ALONGSIDE `createResourceOwnershipRule()` on
 * the same engine: the only way a genuine `happy_path` ALLOW case exists
 * for a gate-only rule, and exactly the real composition the roadmap's
 * step-up flow describes (an assurance gate layered in front of an
 * otherwise-real grant path).
 *
 * Two registered requirements:
 *   - "vault-approve-l3": `sylo.vault.approve` requires at least L3 (MFA).
 *   - "vault-delete-l4": `sylo.vault.delete` requires at least L4 (passkey).
 *
 *   - happy_path: a subject with `assuranceMethods: ["totp"]` (L3) meets
 *     the L3 requirement and approves — the gate abstains, letting the
 *     owner's ALLOW through.
 *   - negative_path: a subject with no assurance methods and no
 *     meaningful `verificationLevel` (L1) attempts the same L3-gated
 *     action → STEP_UP, `requiredAssurance: "L3"`.
 *   - boundary: the freshness-upgrade window's literal edge —
 *     `authenticationFreshnessSeconds` exactly at
 *     `ASSURANCE_FRESHNESS_WINDOW_SECONDS` (300) still upgrades an
 *     otherwise-L1 subject to L5 (inclusive), meeting the L4 delete
 *     requirement; one second past the window does not upgrade, and the
 *     same subject is STEP_UP'd.
 *   - privilege_escalation: a subject who genuinely meets the L3 bar
 *     (satisfies `sylo.vault.approve`) attempts the STRICTER L4-gated
 *     `sylo.vault.delete` — meeting a lower bar does not carry over to a
 *     higher one; the gate still STEP_UPs.
 *   - tenant_isolation: this rule has no organizational dimension at all
 *     — a same-organization subject with insufficient assurance is
 *     STEP_UP'd exactly as any other subject would be; organization
 *     membership never substitutes for assurance.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-assurance.ts
 */

import {
  PolicyEngine,
  createAssuranceRule,
  createResourceOwnershipRule,
  ASSURANCE_FRESHNESS_WINDOW_SECONDS,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: assurance");

  const engine = new PolicyEngine();
  engine.registerRule("resource-ownership", createResourceOwnershipRule());
  engine.registerRule(
    "assurance",
    createAssuranceRule([
      { id: "vault-approve-l3", minimumLevel: "L3", actions: ["sylo.vault.approve"] },
      { id: "vault-delete-l4", minimumLevel: "L4", actions: ["sylo.vault.delete"] },
    ]),
  );

  const subject = (
    userId: number,
    organizationId: number | null = null,
    assuranceMethods: string[] = [],
  ) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
    assuranceMethods,
  });

  const suite: PolicyTestSuite = {
    policyId: "assurance",
    cases: [
      {
        name: "L3 (totp) meets the L3 requirement — the gate abstains, letting the owner's ALLOW through",
        category: "happy_path",
        given: {
          subject: subject(1, null, ["totp"]),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 1 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "L1 (no assurance methods, no verification) does not meet L3 — STEP_UP",
        category: "negative_path",
        given: {
          subject: subject(2, null, []),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 2 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: "assurance", requiredAssurance: "L3" },
      },
      {
        name: "authenticationFreshnessSeconds exactly at the window boundary still upgrades to L5, meeting L4 (inclusive)",
        category: "boundary",
        given: {
          subject: subject(3, null, []),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 3 },
          context: { authenticationFreshnessSeconds: ASSURANCE_FRESHNESS_WINDOW_SECONDS },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "resource-ownership" },
      },
      {
        name: "meeting the lower L3 bar for approve does not carry over to the stricter L4 bar for delete",
        category: "privilege_escalation",
        given: {
          subject: subject(4, null, ["totp"]),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 4 },
        },
        when: { action: "sylo.vault.delete" },
        then: { effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: "assurance", requiredAssurance: "L4" },
      },
      {
        name: "a same-organization subject with insufficient assurance is still STEP_UP'd — no organizational dimension to this gate",
        category: "tenant_isolation",
        given: {
          subject: subject(5, 100, []),
          resource: { type: "sylo.vault_item", id: "1", ownerId: 5, organizationId: 100 },
        },
        when: { action: "sylo.vault.approve" },
        then: { effect: "STEP_UP", reason: "STEP_UP_REQUIRED", policyId: "assurance", requiredAssurance: "L3" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B assurance declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
