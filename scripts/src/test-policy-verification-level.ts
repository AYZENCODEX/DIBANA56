/**
 * scripts/src/test-policy-verification-level.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9B tests.
 *
 * DB-free — uses a FakeVerificationLevelProvider, same posture every other
 * scripts/src/test-policy-*.ts establishes for its own provider interface
 * (test-policy-rbac.ts's FakeRbacProvider, etc.). `DrizzleVerificationLevelProvider`
 * itself is not exercised here (no network/DB in this sandbox — same known
 * limitation every other Drizzle provider's test file already documents).
 *
 * Run: npx tsx scripts/src/test-policy-verification-level.ts
 */

import assert from "node:assert/strict";
import {
  mapAccountStandingToVerificationLevel,
  withVerificationLevel,
  computeAssuranceLevel,
  assuranceLevelMeetsMinimum,
  createAssuranceRule,
  ASSURANCE_POLICY_ID,
  PolicyEngine,
  createRbacRule,
  RBAC_POLICY_ID,
  type AccountVerificationStanding,
  type VerificationLevelProvider,
  type Subject,
  type ResourceRef,
  type PolicyContext,
  type RbacProvider,
  type RoleRecord,
} from "../../artifacts/api-server/src/lib/policy";
import { createPolicyContext } from "../../artifacts/api-server/src/lib/policy/policy-context";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

class FakeVerificationLevelProvider implements VerificationLevelProvider {
  private readonly standings = new Map<number, AccountVerificationStanding>();
  set(userId: number, standing: AccountVerificationStanding): void {
    this.standings.set(userId, standing);
  }
  async getAccountVerificationStanding(userId: number): Promise<AccountVerificationStanding> {
    return this.standings.get(userId) ?? { emailVerified: false, kycVerified: false, kycLevel: 0 };
  }
}

const resource: ResourceRef = { type: "ryft.payment", id: "p1" };
function ctx(): PolicyContext {
  return createPolicyContext();
}

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  addRole(key: string, parentRoleKey: string | null = null): void {
    this.roles.set(key, { key, parentRoleKey });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }
  grant(roleKey: string, permissionKey: string): void {
    if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }
  async getUserRoleKeys(): Promise<string[]> {
    return [];
  }
  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }
  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.roles.get(roleKey) ?? null;
  }
}

async function main() {
  console.log("Phase 09B — Verification-level PIP adapter tests\n");

  // ── Part 1: mapAccountStandingToVerificationLevel() ─────────────────────

  await test("no standing at all → unverified", () => {
    assert.equal(
      mapAccountStandingToVerificationLevel({ emailVerified: false, kycVerified: false, kycLevel: 0 }),
      "unverified",
    );
  });

  await test("emailVerified only → email_verified", () => {
    assert.equal(
      mapAccountStandingToVerificationLevel({ emailVerified: true, kycVerified: false, kycLevel: 0 }),
      "email_verified",
    );
  });

  await test("kycVerified (level 1) outranks email_verified → identity_verified", () => {
    assert.equal(
      mapAccountStandingToVerificationLevel({ emailVerified: true, kycVerified: true, kycLevel: 1 }),
      "identity_verified",
    );
  });

  await test("kycLevel >= 1 alone (kycVerified somehow false) still → identity_verified", () => {
    assert.equal(
      mapAccountStandingToVerificationLevel({ emailVerified: false, kycVerified: false, kycLevel: 1 }),
      "identity_verified",
    );
  });

  await test("kycVerified true but kycLevel 0 (should not happen, but fails toward the stronger reading) → identity_verified", () => {
    assert.equal(
      mapAccountStandingToVerificationLevel({ emailVerified: false, kycVerified: true, kycLevel: 0 }),
      "identity_verified",
    );
  });

  await test("neither KYC signal, no email verification → unverified even with a positive kycLevel of exactly 0", () => {
    assert.equal(
      mapAccountStandingToVerificationLevel({ emailVerified: false, kycVerified: false, kycLevel: 0 }),
      "unverified",
    );
  });

  // ── Part 2: withVerificationLevel() ─────────────────────────────────────

  await test("withVerificationLevel: populates verificationLevel without mutating the original Subject", async () => {
    const provider = new FakeVerificationLevelProvider();
    provider.set(1, { emailVerified: true, kycVerified: false, kycLevel: 0 });

    const original: Subject = { userId: 1, role: "user", authType: "session" };
    const enriched = await withVerificationLevel(original, provider);

    assert.equal(original.verificationLevel, undefined); // original untouched
    assert.equal(enriched.verificationLevel, "email_verified");
    assert.equal(enriched.userId, original.userId);
    assert.equal(enriched.role, original.role);
  });

  await test("withVerificationLevel: unknown user (provider has nothing on file) → unverified, never throws", async () => {
    const provider = new FakeVerificationLevelProvider();
    const subject: Subject = { userId: 999, role: "user", authType: "session" };
    const enriched = await withVerificationLevel(subject, provider);
    assert.equal(enriched.verificationLevel, "unverified");
  });

  await test("withVerificationLevel: always overwrites a pre-set verificationLevel, never merges", async () => {
    const provider = new FakeVerificationLevelProvider();
    provider.set(1, { emailVerified: false, kycVerified: true, kycLevel: 1 });
    const subject: Subject = { userId: 1, role: "user", authType: "session", verificationLevel: "identity_verified" };
    // Provider disagrees on purpose — real KYC standing should win, not the stale pre-set value.
    provider.set(1, { emailVerified: true, kycVerified: false, kycLevel: 0 });
    const enriched = await withVerificationLevel(subject, provider);
    assert.equal(enriched.verificationLevel, "email_verified");
  });

  // ── Part 3: composition with computeAssuranceLevel() ────────────────────

  await test("composition: a verified-email-only subject reaches L2 via computeAssuranceLevel", async () => {
    const provider = new FakeVerificationLevelProvider();
    provider.set(1, { emailVerified: true, kycVerified: false, kycLevel: 0 });
    const subject = await withVerificationLevel({ userId: 1, role: "user", authType: "session" }, provider);
    assert.equal(computeAssuranceLevel(subject, ctx()), "L2");
  });

  await test("composition: an unverified subject stays at L1, not L2", async () => {
    const provider = new FakeVerificationLevelProvider();
    const subject = await withVerificationLevel({ userId: 1, role: "user", authType: "session" }, provider);
    assert.equal(computeAssuranceLevel(subject, ctx()), "L1");
  });

  await test("composition: identity_verified alone still does not reach L3 — KYC standing is not MFA", async () => {
    const provider = new FakeVerificationLevelProvider();
    provider.set(1, { emailVerified: true, kycVerified: true, kycLevel: 1 });
    const subject = await withVerificationLevel({ userId: 1, role: "user", authType: "session" }, provider);
    assert.equal(computeAssuranceLevel(subject, ctx()), "L2");
    assert.equal(assuranceLevelMeetsMinimum(computeAssuranceLevel(subject, ctx()), "L3"), false);
  });

  // ── Part 4: end-to-end with a real PolicyEngine + createAssuranceRule() ─

  await test("composition: an L2 assurance requirement is satisfied once the real verification-level adapter reports email_verified", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const verification = new FakeVerificationLevelProvider();
    verification.set(1, { emailVerified: true, kycVerified: false, kycLevel: 0 });

    const engine = new PolicyEngine();
    engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule([{ id: "read-needs-l2", minimumLevel: "L2", actions: ["ryft.payment.read"] }]));
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const rawSubject: Subject = { userId: 1, role: "user", authType: "session" };
    const subject = await withVerificationLevel(rawSubject, verification);

    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx() });
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, RBAC_POLICY_ID);
  });

  await test("composition: the same L2 requirement STEP_UPs an unverified subject even though RBAC would otherwise allow", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const verification = new FakeVerificationLevelProvider(); // nothing set — unverified

    const engine = new PolicyEngine();
    engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule([{ id: "read-needs-l2", minimumLevel: "L2", actions: ["ryft.payment.read"] }]));
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const rawSubject: Subject = { userId: 1, role: "user", authType: "session" };
    const subject = await withVerificationLevel(rawSubject, verification);

    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx() });
    assert.equal(decision.effect, "STEP_UP");
    assert.equal(decision.policyId, ASSURANCE_POLICY_ID);
  });

  console.log("\nAll Phase 09B verification-level adapter tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
