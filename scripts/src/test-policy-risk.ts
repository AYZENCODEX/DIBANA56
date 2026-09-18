/**
 * scripts/src/test-policy-risk.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 10 (Risk-Aware
 * Authorization), sub-phase 10A tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-risk.ts
 *
 * Two parts:
 *   1. createRiskRule() in isolation — every riskLevel branch, "never
 *      ALLOWs" discipline, decision shape (reason/policyId/message).
 *   2. Composition — DENY/STEP_UP short-circuiting a real RBAC allow,
 *      exactly the same shape test-policy-assurance.ts already
 *      established for the assurance gate, plus the "client can't smuggle
 *      a risk level" boundary check.
 *
 * Run: npx tsx scripts/src/test-policy-risk.ts
 */

import assert from "node:assert/strict";
import {
  createRiskRule,
  RISK_POLICY_ID,
  PolicyEngine,
  createRbacRule,
  RBAC_POLICY_ID,
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

function subjectAtRisk(riskLevel?: "low" | "medium" | "high"): Subject {
  return { userId: 1, role: "user", authType: "session", riskLevel };
}

async function main() {
  console.log("Phase 10A — Risk-Aware Authorization tests\n");

  // ── Part 1: createRiskRule() in isolation ───────────────────────────────

  await test("riskLevel unset → abstains (treated as no objection, not HIGH)", async () => {
    const rule = createRiskRule();
    const decision = await rule({ subject: subjectAtRisk(undefined), action: "any.action", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("riskLevel 'low' → abstains", async () => {
    const rule = createRiskRule();
    const decision = await rule({ subject: subjectAtRisk("low"), action: "any.action", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("riskLevel 'medium' → STEP_UP, not DENY", async () => {
    const rule = createRiskRule();
    const decision = await rule({ subject: subjectAtRisk("medium"), action: "any.action", resource, context: ctx() } as never);
    assert.ok(decision);
    assert.equal(decision!.effect, "STEP_UP");
    assert.equal(decision!.reason, "STEP_UP_REQUIRED");
    assert.equal(decision!.policyId, RISK_POLICY_ID);
  });

  await test("riskLevel 'high' → DENY with HIGH_RISK_DENIED, unconditionally", async () => {
    const rule = createRiskRule();
    const decision = await rule({ subject: subjectAtRisk("high"), action: "any.action", resource, context: ctx() } as never);
    assert.ok(decision);
    assert.equal(decision!.effect, "DENY");
    assert.equal(decision!.reason, "HIGH_RISK_DENIED");
    assert.equal(decision!.policyId, RISK_POLICY_ID);
  });

  await test("unauthenticated subject → abstains (defensive; engine already handles this)", async () => {
    const rule = createRiskRule();
    const decision = await rule({ subject: null, action: "any.action", resource, context: ctx() } as never);
    assert.equal(decision, null);
  });

  await test("custom denyMessage/stepUpMessage options are honored", async () => {
    const rule = createRiskRule({ denyMessage: "custom deny detail", stepUpMessage: "custom step-up detail" });
    const denyDecision = await rule({ subject: subjectAtRisk("high"), action: "a", resource, context: ctx() } as never);
    const stepUpDecision = await rule({ subject: subjectAtRisk("medium"), action: "a", resource, context: ctx() } as never);
    assert.equal(denyDecision!.message, "custom deny detail");
    assert.equal(stepUpDecision!.message, "custom step-up detail");
  });

  await test("never ALLOWs for any riskLevel value — deterministic scan of every branch", async () => {
    const rule = createRiskRule();
    for (const level of [undefined, "low", "medium", "high"] as const) {
      const decision = await rule({ subject: subjectAtRisk(level), action: "a", resource, context: ctx() } as never);
      if (decision) assert.notEqual(decision.effect, "ALLOW", `riskLevel=${level} must never produce ALLOW`);
    }
  });

  // ── Part 2: composition ─────────────────────────────────────────────────

  await test("composition: HIGH risk short-circuits a real RBAC allow — DENY wins", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const subject = subjectAtRisk("high");
    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx() });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "HIGH_RISK_DENIED");
    assert.equal(decision.policyId, RISK_POLICY_ID);
  });

  await test("composition: MEDIUM risk short-circuits the same RBAC allow — STEP_UP, not ALLOW", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const subject = subjectAtRisk("medium");
    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx() });
    assert.equal(decision.effect, "STEP_UP");
    assert.equal(decision.policyId, RISK_POLICY_ID);
  });

  await test("composition: LOW risk lets the same RBAC allow through unobstructed", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const subject = subjectAtRisk("low");
    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx() });
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, RBAC_POLICY_ID);
  });

  await test("composition: risk rule never manufactures an ALLOW on its own — no RBAC registered → default deny", async () => {
    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());

    const subject = subjectAtRisk("low"); // no risk objection
    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx() });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("security: client cannot smuggle a risk level via context.extra — only Subject.riskLevel is ever read", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    // Attacker-controlled-shaped context claiming "low" risk via `extra`,
    // while the server-side Subject (the only trusted source) says HIGH.
    const subject = subjectAtRisk("high");
    const spoofedContext = createPolicyContext({ extra: { riskLevel: "low" } });
    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: spoofedContext });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "HIGH_RISK_DENIED");
  });

  console.log("\nAll Phase 10A risk-aware-authorization tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
