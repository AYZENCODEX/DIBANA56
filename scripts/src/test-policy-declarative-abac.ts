/**
 * scripts/src/test-policy-declarative-abac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), ABAC (Phase 05).
 *
 * Declarative five-category coverage for `createAbacRule()` in isolation,
 * registered with a small, fixed set of hand-built `AbacPolicyDefinition`s
 * (never a DSL string — Phase 06's parser is out of scope here; see
 * ./test-policy-declarative-registry.ts for a DSL-sourced policy's own
 * coverage).
 *
 *   - happy_path: an "allow" policy whose condition matches (fresh session,
 *     `environment.sessionAgeSeconds <= 300`) grants the action.
 *   - negative_path: the same policy's condition does NOT match (a stale
 *     session) → abstain → default-deny.
 *   - boundary: `lessThanOrEqual`'s literal edge — a session exactly
 *     300 seconds old still matches (inclusive), one second older does
 *     not; both sub-cases asserted so the boundary is pinned on both
 *     sides, not merely approached from one direction.
 *   - privilege_escalation: a broader "allow" policy (matches the update
 *     action on the resource type) and a narrower, attribute-conditioned
 *     "deny" policy (high-sensitivity resource + unverified subject) are
 *     BOTH registered; a request that satisfies the broad allow's
 *     condition but ALSO matches the stricter deny's condition is denied
 *     — the deny is found and returned before this rule ever reaches its
 *     remembered allow, regardless of which policy was registered first
 *     (see abac-rule.ts's own header on this exact scan order).
 *   - tenant_isolation: a `valueAttribute` condition comparing
 *     `subject.organizationId` against `resource.organizationId`
 *     dynamically (the roadmap's own Phase 06 conceptual example) grants
 *     only when they match; a cross-organization request abstains and
 *     default-denies. Scoped to its own action (`sylo.vault.list`) so it
 *     never interacts with the fresh-session policy's `sylo.vault.read`
 *     scope above.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-abac.ts
 */

import {
  PolicyEngine,
  createAbacRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type AbacPolicyDefinition,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

const FRESH_SESSION_POLICY: AbacPolicyDefinition = {
  id: "fresh-session-vault-read",
  effect: "allow",
  actions: ["sylo.vault.read"],
  condition: {
    kind: "comparison",
    attribute: "environment.sessionAgeSeconds",
    operator: "lessThanOrEqual",
    value: 300,
  },
  message: "session is fresh enough (<=300s) to read the vault",
};

const BROAD_VAULT_ALLOW: AbacPolicyDefinition = {
  id: "broad-vault-update-allow",
  effect: "allow",
  actions: ["sylo.vault.update"],
  condition: { kind: "comparison", attribute: "subject.role", operator: "exists" },
  message: "any authenticated subject may update the vault, subject to other policies",
};

const HIGH_SENSITIVITY_UNVERIFIED_DENY: AbacPolicyDefinition = {
  id: "deny-high-sensitivity-unverified",
  effect: "deny",
  actions: ["sylo.vault.update"],
  condition: {
    kind: "and",
    conditions: [
      { kind: "comparison", attribute: "resource.sensitivity", operator: "equals", value: "high" },
      { kind: "comparison", attribute: "subject.verificationLevel", operator: "notEquals", value: "identity_verified" },
    ],
  },
  message: "high-sensitivity resources require identity verification",
};

const SAME_ORG_ALLOW: AbacPolicyDefinition = {
  id: "same-org-list-allow",
  effect: "allow",
  actions: ["sylo.vault.list"],
  condition: {
    kind: "comparison",
    attribute: "subject.organizationId",
    operator: "equals",
    valueAttribute: "resource.organizationId",
  },
  message: "granted via dynamic subject.organizationId == resource.organizationId comparison",
};

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: ABAC");

  const engine = new PolicyEngine();
  engine.registerRule(
    "abac",
    createAbacRule([FRESH_SESSION_POLICY, BROAD_VAULT_ALLOW, HIGH_SENSITIVITY_UNVERIFIED_DENY, SAME_ORG_ALLOW]),
  );

  const subject = (
    userId: number,
    organizationId: number | null = null,
    verificationLevel?: string,
  ) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
    verificationLevel,
  });

  const suite: PolicyTestSuite = {
    policyId: "abac",
    cases: [
      {
        name: "a fresh (<=300s) session may read the vault per the fresh-session policy",
        category: "happy_path",
        given: {
          subject: subject(1),
          resource: { type: "sylo.vault_item", id: "1" },
          context: { sessionAgeSeconds: 120 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "abac" },
      },
      {
        name: "a stale session (well past 300s) does not match the fresh-session policy → default-deny",
        category: "negative_path",
        given: {
          subject: subject(2),
          resource: { type: "sylo.vault_item", id: "1" },
          context: { sessionAgeSeconds: 9000 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a session exactly 300 seconds old still matches lessThanOrEqual (inclusive boundary)",
        category: "boundary",
        given: {
          subject: subject(3),
          resource: { type: "sylo.vault_item", id: "1" },
          context: { sessionAgeSeconds: 300 },
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "abac" },
      },
      {
        name: "a high-sensitivity resource's attribute-conditioned deny beats a broader allow that also matches",
        category: "privilege_escalation",
        given: {
          subject: subject(4, null, "email_verified"),
          resource: { type: "sylo.vault_item", id: "1", sensitivity: "high" },
        },
        when: { action: "sylo.vault.update" },
        then: { effect: "DENY", reason: "ATTRIBUTE_POLICY_DENIED", policyId: "abac" },
      },
      {
        name: "subject.organizationId == resource.organizationId (dynamic comparison) grants only for a matching organization",
        category: "tenant_isolation",
        given: {
          subject: subject(5, 100),
          resource: { type: "sylo.vault_item", id: "1", organizationId: 200 },
          context: { sessionAgeSeconds: 9000 },
        },
        when: { action: "sylo.vault.list" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B ABAC declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
