/**
 * scripts/src/test-policy-risk-level.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 10 (Risk-Aware
 * Authorization), sub-phase 10B tests.
 *
 * DB-free — uses a FakeRiskLevelProvider, same posture every other
 * scripts/src/test-policy-*.ts establishes for its own provider interface
 * (test-policy-verification-level.ts's FakeVerificationLevelProvider,
 * etc.). `LoginSecurityRiskProvider` itself is not exercised here (no
 * network/DB in this sandbox — same known limitation every other
 * DB-backed provider's test file already documents).
 *
 * Run: npx tsx scripts/src/test-policy-risk-level.ts
 */

import assert from "node:assert/strict";
import {
  mapRiskSignalToLevel,
  withRiskLevel,
  RISK_FAILED_LOGIN_BURST_THRESHOLD,
  createRiskRule,
  RISK_POLICY_ID,
  PolicyEngine,
  createRbacRule,
  RBAC_POLICY_ID,
  type RiskSignal,
  type RiskLevelProvider,
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

class FakeRiskLevelProvider implements RiskLevelProvider {
  private readonly signals = new Map<number, RiskSignal>();
  set(userId: number, signal: RiskSignal): void {
    this.signals.set(userId, signal);
  }
  async getRiskSignal(userId: number): Promise<RiskSignal> {
    return this.signals.get(userId) ?? { anomalousIp: false, recentFailedLogins: 0 };
  }
}

const resource: ResourceRef = { type: "ryft.payment", id: "p1" };
function ctx(ip?: string): PolicyContext {
  return createPolicyContext({ ip });
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
  console.log("Phase 10B — Risk-level PIP adapter tests\n");

  // ── Part 1: mapRiskSignalToLevel() ──────────────────────────────────────

  await test("neither signal → low", () => {
    assert.equal(mapRiskSignalToLevel({ anomalousIp: false, recentFailedLogins: 0 }), "low");
  });

  await test("anomalous IP alone (no failed-login burst) → medium", () => {
    assert.equal(mapRiskSignalToLevel({ anomalousIp: true, recentFailedLogins: 0 }), "medium");
  });

  await test("failed-login burst alone (not anomalous IP) → medium", () => {
    assert.equal(
      mapRiskSignalToLevel({ anomalousIp: false, recentFailedLogins: RISK_FAILED_LOGIN_BURST_THRESHOLD }),
      "medium",
    );
  });

  await test("below the burst threshold, with no anomalous IP → low", () => {
    assert.equal(
      mapRiskSignalToLevel({ anomalousIp: false, recentFailedLogins: RISK_FAILED_LOGIN_BURST_THRESHOLD - 1 }),
      "low",
    );
  });

  await test("both signals together (anomalous IP AND a failed-login burst) → high", () => {
    assert.equal(
      mapRiskSignalToLevel({ anomalousIp: true, recentFailedLogins: RISK_FAILED_LOGIN_BURST_THRESHOLD }),
      "high",
    );
  });

  await test("burst threshold boundary is exact — one below the threshold does not count", () => {
    assert.equal(
      mapRiskSignalToLevel({ anomalousIp: true, recentFailedLogins: RISK_FAILED_LOGIN_BURST_THRESHOLD - 1 }),
      "medium", // anomalous IP alone still qualifies for medium
    );
  });

  // ── Part 2: withRiskLevel() ─────────────────────────────────────────────

  await test("withRiskLevel: populates riskLevel without mutating the original Subject", async () => {
    const provider = new FakeRiskLevelProvider();
    provider.set(1, { anomalousIp: false, recentFailedLogins: 0 });
    const original: Subject = { userId: 1, role: "user", authType: "session" };
    const enriched = await withRiskLevel(original, ctx("203.0.113.5"), provider);
    assert.equal(original.riskLevel, undefined); // original untouched
    assert.equal(enriched.riskLevel, "low");
  });

  await test("withRiskLevel: unknown user (provider has nothing on file) → low, never throws", async () => {
    const provider = new FakeRiskLevelProvider();
    const subject: Subject = { userId: 999, role: "user", authType: "session" };
    const enriched = await withRiskLevel(subject, ctx("203.0.113.5"), provider);
    assert.equal(enriched.riskLevel, "low");
  });

  await test("withRiskLevel: always overwrites a pre-set riskLevel, never merges", async () => {
    const provider = new FakeRiskLevelProvider();
    provider.set(1, { anomalousIp: true, recentFailedLogins: RISK_FAILED_LOGIN_BURST_THRESHOLD });
    const subject: Subject = { userId: 1, role: "user", authType: "session", riskLevel: "low" };
    const enriched = await withRiskLevel(subject, ctx("203.0.113.5"), provider);
    assert.equal(enriched.riskLevel, "high"); // provider's real signal wins over the stale pre-set value
  });

  // ── Part 3: end-to-end with a real PolicyEngine + createRiskRule() ──────

  await test("composition: HIGH risk (both signals) short-circuits a real RBAC allow — DENY wins", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const riskProvider = new FakeRiskLevelProvider();
    riskProvider.set(1, { anomalousIp: true, recentFailedLogins: RISK_FAILED_LOGIN_BURST_THRESHOLD });

    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const rawSubject: Subject = { userId: 1, role: "user", authType: "session" };
    const subject = await withRiskLevel(rawSubject, ctx("198.51.100.9"), riskProvider);

    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx("198.51.100.9") });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "HIGH_RISK_DENIED");
  });

  await test("composition: a clean signal (neither anomalous IP nor a failed-login burst) lets the same RBAC allow through", async () => {
    const rbac = new FakeRbacProvider();
    rbac.addRole("user", null);
    rbac.grant("user", "ryft.payment.read");

    const riskProvider = new FakeRiskLevelProvider();
    riskProvider.set(1, { anomalousIp: false, recentFailedLogins: 0 });

    const engine = new PolicyEngine();
    engine.registerRule(RISK_POLICY_ID, createRiskRule());
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbac));

    const rawSubject: Subject = { userId: 1, role: "user", authType: "session" };
    const subject = await withRiskLevel(rawSubject, ctx("203.0.113.5"), riskProvider);

    const decision = await engine.evaluate({ subject, action: "ryft.payment.read", resource, context: ctx("203.0.113.5") });
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, RBAC_POLICY_ID);
  });

  console.log("\nAll Phase 10B risk-level adapter tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
