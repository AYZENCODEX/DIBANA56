/**
 * scripts/src/test-policy-temporary-access.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 11 (Temporary / Expiring
 * Access) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-temporary-access.ts
 *
 * Covers the roadmap's Phase 11 requirement directly: "Test before, during
 * and after expiration plus clock boundaries", plus the applicable slice of
 * the roadmap's general security test list (IDOR, cross-user, privilege
 * escalation via forged fields) and composition with other phases.
 *
 * Run: npx tsx scripts/src/test-policy-temporary-access.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createTemporaryAccessRule,
  createResourceOwnershipRule,
  createExplicitResourceGrantRule,
  TEMPORARY_ACCESS_POLICY_ID,
  RESOURCE_OWNERSHIP_POLICY_ID,
  RESOURCE_GRANT_POLICY_ID,
  type Subject,
  type ResourceRef,
  type PolicyContext,
  type TemporaryAccessGrant,
  type TemporaryAccessGrantProvider,
  type ResourceGrantProvider,
  type ResourceGrantEntry,
  type BuildAuthorizationRequestInput,
} from "../../artifacts/api-server/src/lib/policy";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

// ── FakeTemporaryAccessGrantProvider — in-memory stand-in ─────────────────

class FakeTemporaryAccessGrantProvider implements TemporaryAccessGrantProvider {
  private readonly grants: Array<{ subjectUserId: number; resourceType: string; action: string; grant: TemporaryAccessGrant }> = [];
  private nextId = 1;

  addGrant(
    subjectUserId: number,
    resourceType: string,
    action: string,
    grant: Omit<TemporaryAccessGrant, "id">,
  ): void {
    this.grants.push({ subjectUserId, resourceType, action, grant: { id: this.nextId++, ...grant } });
  }

  async getTemporaryAccessGrants(subjectUserId: number, resourceType: string, action: string): Promise<TemporaryAccessGrant[]> {
    return this.grants
      .filter((g) => g.subjectUserId === subjectUserId && g.resourceType === resourceType && g.action === action)
      .map((g) => g.grant);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────

const alice: Subject = { userId: 1, role: "member", authType: "session" };
const bob: Subject = { userId: 2, role: "member", authType: "session" };

function contextAt(iso: string): PolicyContext {
  return { requestId: `req-${iso}`, timestamp: new Date(iso) };
}

function buildInput(subject: Subject | null, action: string, resource: ResourceRef, context: PolicyContext): BuildAuthorizationRequestInput {
  return { subject, action, resource, context };
}

const WINDOW_START = "2026-01-01T00:00:00.000Z";
const WINDOW_END = "2026-01-02T00:00:00.000Z";

async function main() {
  console.log("Policy Engine — Phase 11 (Temporary / Expiring Access) tests");

  // ── before / during / after expiration, plus exact clock boundaries ────

  await test("before startsAt (1ms early) → abstain → default DENY", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2025-12-31T23:59:59.999Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("exactly at startsAt (inclusive start) → ALLOW", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt(WINDOW_START)),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, TEMPORARY_ACCESS_POLICY_ID);
  });

  await test("mid-window (during) → ALLOW", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "ALLOW");
  });

  await test("1ms before expiresAt (still active) → ALLOW", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T23:59:59.999Z")),
    );
    assert.equal(decision.effect, "ALLOW");
  });

  await test("exactly at expiresAt (exclusive end) → EXPIRED → abstain → default DENY", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt(WINDOW_END)),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("well after expiresAt → abstain → default DENY", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-06-01T00:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── scope: "resource" — exact match only ───────────────────────────────

  await test('scope "resource": grant for id=42 does not leak to a substituted id=43 (IDOR)', async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 43 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test('scope "resource": a grant issued to bob does not extend to alice (cross-user)', async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(alice, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test('scope "resource": resource with no id at all → rule abstains cleanly', async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item" }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("exact action match only: a grant for one action does not cover a different action", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.update", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  // ── scope: "resource_type" — broader, org-narrowable grants ────────────

  await test('scope "resource_type" with no organizationId → matches every resource of that type, any org', async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource_type",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
      reason: "on-call incident response",
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decisionOrgA = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, organizationId: 7 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    const decisionOrgB = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 999, organizationId: 8 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decisionOrgA.effect, "ALLOW");
    assert.equal(decisionOrgA.message, "on-call incident response");
    assert.equal(decisionOrgB.effect, "ALLOW");
  });

  await test('scope "resource_type" narrowed by organizationId → does not leak to a different org (cross-tenant)', async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource_type",
      organizationId: 7,
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decisionOwnOrg = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 1, organizationId: 7 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    const decisionOtherOrg = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 2, organizationId: 9 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decisionOwnOrg.effect, "ALLOW");
    assert.equal(decisionOtherOrg.effect, "DENY");
    assert.equal(decisionOtherOrg.reason, "NO_MATCHING_POLICY");
  });

  await test('scope "resource_type" expiry is still enforced (broad grant is not immune to the clock)', async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource_type",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, organizationId: 7 }, contextAt(WINDOW_END)),
    );
    assert.equal(decision.effect, "DENY");
  });

  // ── privilege escalation via forged fields ─────────────────────────────

  await test("privilege escalation: forging unrelated resource fields does not manufacture a match", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(
        bob,
        "admin.user.manage",
        { type: "sylo.vault_item", id: 42, ownerId: 1, organizationId: 1, classification: "top-secret" },
        contextAt("2026-01-01T12:00:00.000Z"),
      ),
    );
    assert.equal(decision.effect, "DENY");
  });

  // ── unauthenticated ─────────────────────────────────────────────────────

  await test("unauthenticated subject never reaches the temporary-access rule at all", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(null, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  // ── determinism (Rule 12) ────────────────────────────────────────────────

  await test("deterministic: re-evaluating the exact same request object twice yields the exact same effect", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const input = buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt(WINDOW_END));
    const first = await engine.evaluate(input);
    const second = await engine.evaluate(input);
    assert.equal(first.effect, second.effect);
    assert.equal(first.effect, "DENY"); // context.timestamp === expiresAt on every call, not a live clock read
  });

  // ── composition with other phases ───────────────────────────────────────

  await test("composition: an expired temporary grant does not block a still-valid ownership ALLOW", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    engine.registerRule(RESOURCE_OWNERSHIP_POLICY_ID, createResourceOwnershipRule());
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42, ownerId: 2 }, contextAt(WINDOW_END)),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, RESOURCE_OWNERSHIP_POLICY_ID);
  });

  await test("composition: a permanent explicit DENY beats an active temporary ALLOW (deny-overrides)", async () => {
    const temporaryProvider = new FakeTemporaryAccessGrantProvider();
    temporaryProvider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
    });
    class DenyProvider implements ResourceGrantProvider {
      async getResourceGrant(): Promise<ResourceGrantEntry | null> {
        return { effect: "deny", reason: "account under investigation" };
      }
    }
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(temporaryProvider));
    engine.registerRule(RESOURCE_GRANT_POLICY_ID, createExplicitResourceGrantRule(new DenyProvider()));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "RESOURCE_GRANT_DENIED");
  });

  await test("composition: two temporary grants (one expired, one active) — the active one still allows", async () => {
    const provider = new FakeTemporaryAccessGrantProvider();
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date("2025-01-01T00:00:00.000Z"),
      expiresAt: new Date("2025-02-01T00:00:00.000Z"), // long expired
      grantedBy: 1,
    });
    provider.addGrant(2, "sylo.vault_item", "sylo.vault.read", {
      scope: "resource",
      resourceId: "42",
      startsAt: new Date(WINDOW_START),
      expiresAt: new Date(WINDOW_END),
      grantedBy: 1,
      reason: "renewed grant",
    });
    const engine = new PolicyEngine();
    engine.registerRule(TEMPORARY_ACCESS_POLICY_ID, createTemporaryAccessRule(provider));
    const decision = await engine.evaluate(
      buildInput(bob, "sylo.vault.read", { type: "sylo.vault_item", id: 42 }, contextAt("2026-01-01T12:00:00.000Z")),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.message, "renewed grant");
  });

  console.log("Policy Engine — Phase 11 (Temporary / Expiring Access): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
