/**
 * scripts/src/test-policy-assurance.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9A tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-assurance.ts
 *
 * Three parts:
 *   1. LEVEL VOCABULARY — ASSURANCE_LEVEL_ORDER/ASSURANCE_RANK shape,
 *      assertValidAssuranceLevel's fail-loud behavior.
 *   2. computeAssuranceLevel() — every level derivation path (L0 through
 *      L5), including the freshness-window boundary and the "freshness
 *      upgrades regardless of base level" behavior documented in
 *      assurance-level.ts's header.
 *   3. createAssuranceRule() — the gate itself: abstain when satisfied,
 *      STEP_UP when not, "this rule never ALLOWs" composed against a real
 *      RBAC allow, strictest-matching-requirement-wins, and the boundary
 *      tests the roadmap calls for.
 *
 * Run: npx tsx scripts/src/test-policy-assurance.ts
 */

import assert from "node:assert/strict";
import {
  ASSURANCE_LEVEL_ORDER,
  ASSURANCE_RANK,
  ASSURANCE_FRESHNESS_WINDOW_SECONDS,
  assertValidAssuranceLevel,
  computeAssuranceLevel,
  assuranceLevelMeetsMinimum,
  createAssuranceRule,
  ASSURANCE_POLICY_ID,
  PolicyEngine,
  createRbacRule,
  RBAC_POLICY_ID,
  type AssuranceLevel,
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

const resource: ResourceRef = { type: "ryft.payment", id: "p1" };

function ctx(authenticationFreshnessSeconds?: number): PolicyContext {
  return createPolicyContext({ authenticationFreshnessSeconds });
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
  console.log("Phase 09A — Authentication Assurance tests\n");

  // ── Part 1: level vocabulary ────────────────────────────────────────────

  await test("ASSURANCE_LEVEL_ORDER has exactly the roadmap's 6 named levels, in order", () => {
    assert.deepEqual(ASSURANCE_LEVEL_ORDER, ["L0", "L1", "L2", "L3", "L4", "L5"]);
  });

  await test("ASSURANCE_RANK is strictly increasing across ASSURANCE_LEVEL_ORDER", () => {
    const ranks = ASSURANCE_LEVEL_ORDER.map((level) => ASSURANCE_RANK[level]);
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i] > ranks[i - 1], `rank(${ASSURANCE_LEVEL_ORDER[i]}) should exceed rank(${ASSURANCE_LEVEL_ORDER[i - 1]})`);
    }
  });

  await test("assertValidAssuranceLevel rejects an unknown level string", () => {
    assert.throws(() => assertValidAssuranceLevel("L9"));
  });

  await test("assertValidAssuranceLevel accepts every real level", () => {
    for (const level of ASSURANCE_LEVEL_ORDER) {
      assert.doesNotThrow(() => assertValidAssuranceLevel(level));
    }
  });

  await test("assuranceLevelMeetsMinimum: equal and above pass, below fails", () => {
    assert.equal(assuranceLevelMeetsMinimum("L3", "L3"), true);
    assert.equal(assuranceLevelMeetsMinimum("L4", "L3"), true);
    assert.equal(assuranceLevelMeetsMinimum("L2", "L3"), false);
  });

  // ── Part 2: computeAssuranceLevel() ─────────────────────────────────────

  await test("computeAssuranceLevel: null subject → L0 (unauthenticated)", () => {
    assert.equal(computeAssuranceLevel(null, ctx()), "L0");
  });

  await test("computeAssuranceLevel: authenticated, no methods, no verification → L1 (normal session)", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session" };
    assert.equal(computeAssuranceLevel(subject, ctx()), "L1");
  });

  await test("computeAssuranceLevel: verificationLevel present and meaningful → L2", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session", verificationLevel: "identity_verified" };
    assert.equal(computeAssuranceLevel(subject, ctx()), "L2");
  });

  await test("computeAssuranceLevel: verificationLevel present but marked unverified → still L1", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session", verificationLevel: "unverified" };
    assert.equal(computeAssuranceLevel(subject, ctx()), "L1");
    const subjectNumeric: Subject = { userId: 1, role: "user", authType: "session", verificationLevel: 0 };
    assert.equal(computeAssuranceLevel(subjectNumeric, ctx()), "L1");
  });

  await test("computeAssuranceLevel: assuranceMethods with totp/otp/backup_code → L3 (MFA)", () => {
    for (const method of ["totp", "otp", "backup_code"] as const) {
      const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: [method] };
      assert.equal(computeAssuranceLevel(subject, ctx()), "L3", `method ${method} should yield L3`);
    }
  });

  await test("computeAssuranceLevel: assuranceMethods = [\"password\"] alone does NOT count as MFA → L1", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["password"] };
    assert.equal(computeAssuranceLevel(subject, ctx()), "L1");
  });

  await test("computeAssuranceLevel: assuranceMethods with passkey → L4, even alongside MFA methods", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["totp", "passkey"] };
    assert.equal(computeAssuranceLevel(subject, ctx()), "L4");
  });

  await test("computeAssuranceLevel: fresh authenticationFreshnessSeconds upgrades a plain L1 session all the way to L5", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session" };
    assert.equal(computeAssuranceLevel(subject, ctx(10)), "L5");
  });

  await test("computeAssuranceLevel: freshness exactly at the window boundary still counts", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session" };
    assert.equal(computeAssuranceLevel(subject, ctx(ASSURANCE_FRESHNESS_WINDOW_SECONDS)), "L5");
  });

  await test("computeAssuranceLevel: freshness one second past the window does NOT upgrade", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["totp"] };
    assert.equal(computeAssuranceLevel(subject, ctx(ASSURANCE_FRESHNESS_WINDOW_SECONDS + 1)), "L3");
  });

  await test("computeAssuranceLevel: negative freshness (malformed input) is ignored, falls back to base level", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session" };
    assert.equal(computeAssuranceLevel(subject, ctx(-5)), "L1");
  });

  await test("computeAssuranceLevel: deterministic — identical input evaluated twice yields identical level", () => {
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["passkey"] };
    const context = ctx(30);
    assert.equal(computeAssuranceLevel(subject, context), computeAssuranceLevel(subject, context));
  });

  // ── Part 3: createAssuranceRule() ───────────────────────────────────────

  await test("createAssuranceRule: throws immediately at construction on an invalid minimumLevel", () => {
    assert.throws(() => createAssuranceRule([{ id: "bad", minimumLevel: "L9" as AssuranceLevel }]));
  });

  await test("createAssuranceRule: no requirements registered → always abstains", async () => {
    const rule = createAssuranceRule([]);
    const decision = await rule({ subject: { userId: 1, role: "user", authType: "session" }, action: "any.action", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("createAssuranceRule: unauthenticated subject → abstains (defensive; engine already handles this)", async () => {
    const rule = createAssuranceRule([{ id: "r1", minimumLevel: "L3" }]);
    const decision = await rule({ subject: null, action: "ryft.payment.approve", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("createAssuranceRule: requirement satisfied → abstains (never ALLOWs)", async () => {
    const rule = createAssuranceRule([{ id: "approve-needs-mfa", minimumLevel: "L3", actions: ["ryft.payment.approve"] }]);
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["totp"] };
    const decision = await rule({ subject, action: "ryft.payment.approve", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("createAssuranceRule: requirement unmet → STEP_UP with a descriptive message", async () => {
    const rule = createAssuranceRule([{ id: "approve-needs-mfa", minimumLevel: "L3", actions: ["ryft.payment.approve"] }]);
    const subject: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await rule({ subject, action: "ryft.payment.approve", resource, context: ctx() } as never);
    assert.ok(decision);
    assert.equal(decision!.effect, "STEP_UP");
    assert.equal(decision!.reason, "STEP_UP_REQUIRED");
    assert.equal(decision!.policyId, ASSURANCE_POLICY_ID);
    assert.match(decision!.message ?? "", /requires assurance level L3/);
  });

  await test("createAssuranceRule: action not covered by any requirement → abstains", async () => {
    const rule = createAssuranceRule([{ id: "approve-needs-mfa", minimumLevel: "L3", actions: ["ryft.payment.approve"] }]);
    const subject: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await rule({ subject, action: "ryft.payment.read", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("createAssuranceRule: no actions list at all → applies to every action", async () => {
    const rule = createAssuranceRule([{ id: "global-l2", minimumLevel: "L2" }]);
    const subject: Subject = { userId: 1, role: "user", authType: "session" }; // L1, below L2
    const decision = await rule({ subject, action: "literally.anything", resource, context: ctx() } as never);
    assert.ok(decision);
    assert.equal(decision!.effect, "STEP_UP");
  });

  await test("createAssuranceRule: strictest matching requirement wins over a looser one", async () => {
    const rule = createAssuranceRule([
      { id: "broad-l2", minimumLevel: "L2", actions: ["ryft.payment.*"] },
      { id: "narrow-l4", minimumLevel: "L4", actions: ["ryft.payment.approve"] },
    ]);
    // Meets the broad L2 requirement but not the narrow L4 one — must still STEP_UP.
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["totp"] }; // L3
    const decision = await rule({ subject, action: "ryft.payment.approve", resource, context: ctx() } as never);
    assert.ok(decision);
    assert.equal(decision!.effect, "STEP_UP");
    assert.match(decision!.message ?? "", /requires assurance level L4/);
  });

  await test("createAssuranceRule: satisfying the strictest requirement clears every looser one too, abstains", async () => {
    const rule = createAssuranceRule([
      { id: "broad-l2", minimumLevel: "L2", actions: ["ryft.payment.*"] },
      { id: "narrow-l4", minimumLevel: "L4", actions: ["ryft.payment.approve"] },
    ]);
    const subject: Subject = { userId: 1, role: "user", authType: "session", assuranceMethods: ["passkey"] }; // L4
    const decision = await rule({ subject, action: "ryft.payment.approve", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  // ── Composition: STEP_UP beats an RBAC ALLOW for the same action ────────

  await test("composition: an unmet assurance requirement short-circuits a real RBAC allow (PolicyEngine)", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.approve");

    const engine = new PolicyEngine();
    engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule([{ id: "approve-needs-mfa", minimumLevel: "L3", actions: ["ryft.payment.approve"] }]));
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const subject: Subject = { userId: 9, role: "user", authType: "session" }; // L1 only, role grants the permission
    const decision = await engine.evaluate({ subject, action: "ryft.payment.approve", resource, context: ctx() });
    assert.equal(decision.effect, "STEP_UP");
    assert.equal(decision.policyId, ASSURANCE_POLICY_ID);
  });

  await test("composition: once the subject meets the requirement, the same RBAC allow goes through unobstructed", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.approve");

    const engine = new PolicyEngine();
    engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule([{ id: "approve-needs-mfa", minimumLevel: "L3", actions: ["ryft.payment.approve"] }]));
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const subject: Subject = { userId: 9, role: "user", authType: "session", assuranceMethods: ["totp"] }; // L3
    const decision = await engine.evaluate({ subject, action: "ryft.payment.approve", resource, context: ctx() });
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, RBAC_POLICY_ID);
  });

  await test("composition: assurance rule never manufactures an ALLOW on its own — no RBAC rule registered → default deny, not STEP_UP's absence mistaken for allow", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(ASSURANCE_POLICY_ID, createAssuranceRule([{ id: "approve-needs-mfa", minimumLevel: "L3", actions: ["ryft.payment.approve"] }]));

    const subject: Subject = { userId: 9, role: "user", authType: "session", assuranceMethods: ["totp"] }; // meets the requirement
    const decision = await engine.evaluate({ subject, action: "ryft.payment.approve", resource, context: ctx() });
    // Requirement met → assurance rule abstains → no other rule registered → default deny.
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  console.log("\nAll Phase 09A authentication-assurance tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
