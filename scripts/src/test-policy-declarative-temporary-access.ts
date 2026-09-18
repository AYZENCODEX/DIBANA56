/**
 * scripts/src/test-policy-declarative-temporary-access.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test
 * Framework — coverage), Temporary / Expiring Access (Phase 11).
 *
 * Declarative five-category coverage for `createTemporaryAccessRule()` in
 * isolation. All cases key on `context.timestamp` per the rule's own
 * half-open-interval boundary semantics `[startsAt, expiresAt)` — see
 * temporary-access-rule.ts's own header.
 *
 *   - happy_path: mid-window (well after `startsAt`, well before
 *     `expiresAt`) grants a `scope: "resource"` grant's exact resource.
 *   - negative_path: `now === expiresAt` (exclusive end) — the window has
 *     already closed at that exact instant, not "closes the instant
 *     after" — abstains and default-denies.
 *   - boundary: `now === startsAt` (inclusive start) still grants — the
 *     literal opposite edge from negative_path's exclusive-end case,
 *     pinning the half-open interval on both sides.
 *   - privilege_escalation: a `scope: "resource"` grant for resource id
 *     "42" is on file; the same subject requests the SAME action against
 *     a DIFFERENT resource id ("43") mid-window — exact-match-only means
 *     a grant on one resource instance has no reach onto another, even
 *     the same action, same subject, same active window.
 *   - tenant_isolation: a `scope: "resource_type"` grant narrowed to
 *     `organizationId: 100` matches any resource of that type within
 *     org 100, but not the identical resource type/action in org 200 —
 *     a same-subject, same-action, in-window request against a
 *     different organization's resource abstains and default-denies.
 *
 * Run: npx tsx scripts/src/test-policy-declarative-temporary-access.ts
 */

import {
  PolicyEngine,
  createTemporaryAccessRule,
  assertPolicyTestSuitePassed,
  runPolicyTestSuite,
  type TemporaryAccessGrant,
  type TemporaryAccessGrantProvider,
  type PolicyTestSuite,
} from "../../artifacts/api-server/src/lib/policy";

class FakeTemporaryAccessGrantProvider implements TemporaryAccessGrantProvider {
  private readonly rows: Array<{ subjectUserId: number; resourceType: string; action: string; grant: TemporaryAccessGrant }> = [];
  private nextId = 1;

  addGrant(
    subjectUserId: number,
    resourceType: string,
    action: string,
    grant: Omit<TemporaryAccessGrant, "id">,
  ): void {
    this.rows.push({ subjectUserId, resourceType, action, grant: { id: this.nextId++, ...grant } });
  }

  async getTemporaryAccessGrants(subjectUserId: number, resourceType: string, action: string): Promise<TemporaryAccessGrant[]> {
    return this.rows
      .filter((r) => r.subjectUserId === subjectUserId && r.resourceType === resourceType && r.action === action)
      .map((r) => r.grant);
  }
}

const WINDOW_START = "2026-01-01T00:00:00.000Z";
const WINDOW_END = "2026-01-02T00:00:00.000Z";

async function main() {
  console.log("Policy Test Framework — Phase 21B declarative coverage: temporary access");

  const provider = new FakeTemporaryAccessGrantProvider();
  // Subject 1: scope "resource", exact resource "42", subject 1 only.
  provider.addGrant(1, "sylo.vault_item", "sylo.vault.read", {
    scope: "resource",
    resourceId: "42",
    startsAt: new Date(WINDOW_START),
    expiresAt: new Date(WINDOW_END),
    grantedBy: 99,
    reason: "on-call incident review",
  });
  // Subject 2: scope "resource_type", narrowed to organizationId 100.
  provider.addGrant(2, "sylo.vault_item", "sylo.vault.list", {
    scope: "resource_type",
    organizationId: 100,
    startsAt: new Date(WINDOW_START),
    expiresAt: new Date(WINDOW_END),
    grantedBy: 99,
    reason: "temporary org-100 auditor access",
  });

  const engine = new PolicyEngine();
  engine.registerRule("temporary-access-grant", createTemporaryAccessRule(provider));

  const subject = (userId: number, organizationId: number | null = null) => ({
    userId,
    role: "member",
    authType: "session" as const,
    organizationId,
  });

  const contextAt = (iso: string) => ({ requestId: `req-${iso}`, timestamp: new Date(iso) });

  const suite: PolicyTestSuite = {
    policyId: "temporary-access-grant",
    cases: [
      {
        name: "mid-window, exact resource match → ALLOW",
        category: "happy_path",
        given: {
          subject: subject(1),
          resource: { type: "sylo.vault_item", id: "42" },
          context: contextAt("2026-01-01T12:00:00.000Z"),
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "temporary-access-grant" },
      },
      {
        name: "exactly at expiresAt (exclusive end) — window already closed, abstains and default-denies",
        category: "negative_path",
        given: {
          subject: subject(1),
          resource: { type: "sylo.vault_item", id: "42" },
          context: contextAt(WINDOW_END),
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "exactly at startsAt (inclusive start) → ALLOW — the opposite edge from negative_path's exclusive end",
        category: "boundary",
        given: {
          subject: subject(1),
          resource: { type: "sylo.vault_item", id: "42" },
          context: contextAt(WINDOW_START),
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "ALLOW", reason: "EXPLICIT_ALLOW", policyId: "temporary-access-grant" },
      },
      {
        name: "the exact same in-window grant for resource 42 has no reach onto resource 43",
        category: "privilege_escalation",
        given: {
          subject: subject(1),
          resource: { type: "sylo.vault_item", id: "43" },
          context: contextAt("2026-01-01T12:00:00.000Z"),
        },
        when: { action: "sylo.vault.read" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
      {
        name: "a resource_type grant narrowed to organizationId 100 does not cover the identical resource type/action in organization 200",
        category: "tenant_isolation",
        given: {
          subject: subject(2, 200),
          resource: { type: "sylo.vault_item", id: "999", organizationId: 200 },
          context: contextAt("2026-01-01T12:00:00.000Z"),
        },
        when: { action: "sylo.vault.list" },
        then: { effect: "DENY", reason: "NO_MATCHING_POLICY" },
      },
    ],
  };

  const result = await runPolicyTestSuite(engine, suite);
  assertPolicyTestSuitePassed(result);

  console.log("\nAll Phase 21B temporary-access declarative coverage tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
