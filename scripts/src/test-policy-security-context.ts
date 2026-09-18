/**
 * scripts/src/test-policy-security-context.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 22C (Security / Abuse
 * Testing — Context category).
 *
 * The roadmap's own Phase 22 section, verbatim, for the slice this file
 * covers:
 *
 *   "Context:
 *    - spoofed organization
 *    - spoofed role
 *    - spoofed risk
 *    - spoofed device
 *    - spoofed assurance"
 *
 * 22A (Authorization) and 22B (Authentication) are done; this is 22B's own
 * named next sub-phase. Policy and Reliability remain — see this file's
 * closing comment.
 *
 * ── Why this needs the Phase 18 PIP, not 22A's fixtures ──────────────────
 * 22A already proved `authorize()` never reads `req.body`/`req.query` for
 * role/organizationId at the PEP boundary — but 22A always built its
 * `Subject`/`PolicyContext` the Phase 1B way (`subjectFromAuthUser()` +
 * `policyContextFromRequest()`, no PIP), so it never touched a
 * `RiskProvider`/`DeviceProvider`/PIP-composed `organizationId` at all —
 * those fields are only ever populated when a caller supplies
 * `enrichment.pip` (a `PolicyInformationPoint`, Phase 18). This file's
 * whole point is that composition path: does a hostile request body/header
 * influence what a PIP *provider* reports, given the exact same userId a
 * legitimate provider would key its own DB lookup on. Every fake provider
 * below is written the way `drizzle-subject-provider.ts` /
 * `login-security-risk-provider.ts` / `drizzle-device-trust-provider.ts`
 * are: keyed ONLY on `userId` (or `userId` + `ip`/`userAgent`, both
 * server-resolved — see `context-adapter.ts`), never on anything read off
 * `user` beyond `userId` itself, and never on `req.body`/`req.query`.
 *
 * ── What counts as "spoofed" here ─────────────────────────────────────────
 * Every case sends a `req.body`/`req.query`/extra-`req.user`-property claim
 * that, if it were ever consulted, would change the resulting decision —
 * then asserts the decision is exactly what the AUTHENTIC provider data
 * implies, proving the claim was never consulted. "Spoofed assurance" is
 * the one category with no real provider AT ALL yet
 * (`verification-level-adapter.ts`'s own header: populating
 * `assuranceMethods` from account capability, rather than session usage,
 * would be a real regression — deliberately still unbuilt) — so that case
 * proves the NEGATIVE: nothing populates it from a request body either,
 * so a forged claim has literally nowhere to be read from.
 *
 * Run: npx tsx scripts/src/test-policy-security-context.ts
 */

import assert from "node:assert/strict";
import type { Request } from "express";
import {
  PolicyEngine,
  authorize,
  createRbacRule,
  createOrganizationAccessRule,
  createRiskRule,
  createAssuranceRule,
  PolicyInformationPoint,
  allow,
  type RbacProvider,
  type RoleRecord,
  type SubjectProvider,
  type RiskProvider,
  type RiskSignal,
  type DeviceProvider,
  type DeviceSignal,
  type AuthenticatedUserLike,
  type Subject,
  subjectFromAuthUser,
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

// ── fakes: keyed only by userId/ip/userAgent, exactly like the real
//    Drizzle-backed providers — never by anything a client controls ───────

class FakeRbacProvider implements RbacProvider {
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoles = new Map<number, Set<string>>();
  addRole(key: string): void {
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }
  grant(roleKey: string, permissionKey: string): void {
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }
  assignUserRole(userId: number, roleKey: string): void {
    if (!this.userRoles.has(userId)) this.userRoles.set(userId, new Set());
    this.userRoles.get(userId)!.add(roleKey);
  }
  async getUserRoleKeys(userId: number): Promise<string[]> {
    return [...(this.userRoles.get(userId) ?? [])];
  }
  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }
  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.rolePermissions.has(roleKey) ? { key: roleKey, parentRoleKey: null } : null;
  }
}

/** Represents a hypothetical org-membership-aware `SubjectProvider` — the
 *  real `DrizzleSubjectProvider` does not populate `organizationId` at all
 *  yet (see that file's own header), so this fixture stands in for the
 *  eventual real one, to pin down the CONTRACT: org membership always
 *  comes from the provider's own store, keyed on `user.userId` alone. */
class FakeOrgSubjectProvider implements SubjectProvider {
  constructor(private readonly orgByUserId: Map<number, number>) {}
  async getSubject(user: AuthenticatedUserLike | null | undefined): Promise<Subject | null> {
    const base = subjectFromAuthUser(user);
    if (!base) return null;
    // Only ever keyed on the authentic userId — never reads any other
    // property that might be present on `user` (see file header).
    const organizationId = this.orgByUserId.get(base.userId) ?? null;
    return { ...base, organizationId };
  }
}

class FakeRiskProvider implements RiskProvider {
  constructor(private readonly signalByUserId: Map<number, RiskSignal>) {}
  async getRiskSignal(userId: number, _ip: string | undefined): Promise<RiskSignal> {
    return this.signalByUserId.get(userId) ?? { anomalousIp: false, recentFailedLogins: 0 };
  }
}

class FakeDeviceProvider implements DeviceProvider {
  constructor(private readonly signalByUserId: Map<number, DeviceSignal>) {}
  async getDeviceSignal(userId: number, _userAgent: string): Promise<DeviceSignal> {
    return this.signalByUserId.get(userId) ?? { seenBefore: false };
  }
}

function fakeRequest(overrides: {
  user?: unknown;
  headers?: Record<string, string>;
  body?: unknown;
  query?: unknown;
}): Request {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    body: overrides.body ?? {},
    query: overrides.query ?? {},
    ip: "203.0.113.9",
  } as unknown as Request;
}

async function main() {
  console.log("Policy Engine — Phase 22C (Security / Abuse Testing — Context) tests");

  // ── spoofed role ─────────────────────────────────────────────────────

  await test("spoofed role: PIP-composed subject still carries only the authentic req.user.role, never req.body.role", async () => {
    const rbacProvider = new FakeRbacProvider();
    rbacProvider.addRole("member");
    rbacProvider.grant("member", "sylo.vault.read"); // read-only, deliberately no delete
    rbacProvider.assignUserRole(7, "member");

    const engine = new PolicyEngine();
    engine.registerRule("rbac", createRbacRule(rbacProvider));

    const pip = new PolicyInformationPoint({});
    const req = fakeRequest({ user: { userId: 7, role: "member" }, body: { role: "admin" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.delete", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.subject?.role, "member");
    assert.equal(outcome.decision.effect, "DENY");
  });

  // ── spoofed organization ─────────────────────────────────────────────

  await test("spoofed organization: organization-access ALLOWs only against the provider's real membership (100), not a body-forged target org (200)", async () => {
    const orgProvider = new FakeOrgSubjectProvider(new Map([[7, 100]]));
    const pip = new PolicyInformationPoint({ subject: orgProvider });

    const engine = new PolicyEngine();
    engine.registerRule("organization-access", createOrganizationAccessRule());

    const req = fakeRequest({ user: { userId: 7, role: "member" }, body: { organizationId: 200 } });
    const outcome = await authorize({
      req,
      engine,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "5", organizationId: 200 }, // resource belongs to the org the body is trying to claim
      enrichment: { pip },
    });

    assert.equal(outcome.subject?.organizationId, 100); // provider's real fact, unaffected by the body
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
  });

  await test("spoofed organization: positive control — the real membership (100) legitimately grants access to a resource actually in org 100", async () => {
    const orgProvider = new FakeOrgSubjectProvider(new Map([[7, 100]]));
    const pip = new PolicyInformationPoint({ subject: orgProvider });
    const engine = new PolicyEngine();
    engine.registerRule("organization-access", createOrganizationAccessRule());

    const req = fakeRequest({ user: { userId: 7, role: "member" } });
    const outcome = await authorize({
      req,
      engine,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "5", organizationId: 100 },
      enrichment: { pip },
    });

    assert.equal(outcome.decision.effect, "ALLOW");
  });

  // ── spoofed risk ─────────────────────────────────────────────────────

  await test("spoofed risk: a HIGH-risk subject (per the provider's own signal) is still denied even when the body claims a low risk level", async () => {
    const riskProvider = new FakeRiskProvider(new Map([[7, { anomalousIp: true, recentFailedLogins: 5 }]])); // -> "high"
    const pip = new PolicyInformationPoint({ risk: riskProvider });

    const engine = new PolicyEngine();
    engine.registerRule("risk", createRiskRule());

    const req = fakeRequest({
      user: { userId: 7, role: "member" },
      body: { riskLevel: "low" },
      headers: { "x-risk-level": "low" },
    });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.subject?.riskLevel, "high"); // the provider's real signal, not the forged claim
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "HIGH_RISK_DENIED");
  });

  await test("spoofed risk: a genuinely LOW-risk subject is unaffected by a body that (uselessly) also claims low risk — positive control", async () => {
    const riskProvider = new FakeRiskProvider(new Map([[7, { anomalousIp: false, recentFailedLogins: 0 }]])); // -> "low"
    const pip = new PolicyInformationPoint({ risk: riskProvider });
    const engine = new PolicyEngine();
    engine.registerRule("risk", createRiskRule());
    engine.registerRule("allow-all", (request) => allow(request, "EXPLICIT_ALLOW", {}));

    const req = fakeRequest({ user: { userId: 7, role: "member" }, body: { riskLevel: "low" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.subject?.riskLevel, "low");
    assert.equal(outcome.decision.effect, "ALLOW");
  });

  // ── spoofed device ───────────────────────────────────────────────────

  await test("spoofed device: context.deviceTrust is always the provider's own signal — a body/header claiming \"trusted\" for a never-seen device has no effect", async () => {
    const deviceProvider = new FakeDeviceProvider(new Map([[7, { seenBefore: false }]])); // -> "unknown"
    const pip = new PolicyInformationPoint({ device: deviceProvider });
    const engine = new PolicyEngine();
    engine.registerRule("noop", () => null);

    const req = fakeRequest({
      user: { userId: 7, role: "member" },
      headers: { "user-agent": "AttackerBrowser/1.0" },
      body: { deviceTrust: "trusted" },
    });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.request?.context.deviceTrust, "unknown");
  });

  await test("spoofed device: positive control — a genuinely seen-before device correctly reports \"trusted\" from the provider", async () => {
    const deviceProvider = new FakeDeviceProvider(new Map([[7, { seenBefore: true }]]));
    const pip = new PolicyInformationPoint({ device: deviceProvider });
    const engine = new PolicyEngine();
    engine.registerRule("noop", () => null);

    const req = fakeRequest({ user: { userId: 7, role: "member" }, headers: { "user-agent": "RealBrowser/1.0" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.request?.context.deviceTrust, "trusted");
  });

  // ── spoofed assurance ────────────────────────────────────────────────

  await test("spoofed assurance: a body claiming assuranceMethods=[\"passkey\"] has nowhere to be read from — the subject still computes to the L1 floor and STEP_UPs against an L3 requirement", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("assurance", createAssuranceRule([{ id: "req-1", minimumLevel: "L3", actions: ["sylo.vault.delete"] }]));

    const pip = new PolicyInformationPoint({}); // no provider populates assuranceMethods today — see file header
    const req = fakeRequest({
      user: { userId: 7, role: "member" },
      body: { assuranceMethods: ["passkey"], authenticationFreshnessSeconds: 5 },
    });
    const outcome = await authorize({ req, engine, action: "sylo.vault.delete", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.subject?.assuranceMethods, undefined);
    assert.equal(outcome.request?.context.authenticationFreshnessSeconds, undefined);
    assert.equal(outcome.decision.effect, "STEP_UP");
    assert.equal(outcome.decision.requiredAssurance, "L3");
  });

  // ── composition: a fully-doctored req.user object still can't smuggle
  //    context attributes past provider composition ────────────────────

  await test("composition: extra ad-hoc properties bolted onto req.user (organizationId, riskLevel, deviceTrust, assuranceMethods) are never read by any adapter — only userId/role/authType/keyType/scopes are", async () => {
    const orgProvider = new FakeOrgSubjectProvider(new Map([[7, 100]]));
    const riskProvider = new FakeRiskProvider(new Map([[7, { anomalousIp: false, recentFailedLogins: 0 }]]));
    const pip = new PolicyInformationPoint({ subject: orgProvider, risk: riskProvider });

    const engine = new PolicyEngine();
    engine.registerRule("noop", () => null);

    const doctoredUser = {
      userId: 7,
      role: "member",
      organizationId: 999, // not a real AuthenticatedUserLike field
      riskLevel: "high", // not a real AuthenticatedUserLike field
      deviceTrust: "trusted", // not a real AuthenticatedUserLike field
      assuranceMethods: ["passkey"], // not a real AuthenticatedUserLike field
    };
    const req = fakeRequest({ user: doctoredUser });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.subject?.organizationId, 100); // the provider's real fact for userId 7, not 999
    assert.equal(outcome.subject?.riskLevel, "low"); // the provider's real signal, not "high"
    assert.equal(outcome.request?.context.deviceTrust, undefined); // no device provider configured — stays unset, never "trusted"
    assert.equal(outcome.subject?.assuranceMethods, undefined); // never copied from the doctored object
  });

  console.log("\nAll Phase 22C Context abuse-testing checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ── Deliberately NOT done here (later Phase 22 sub-phases) ───────────────
 * - Policy category (policy injection, invalid DSL, conflicting rules,
 *   priority abuse, cache poisoning, stale authorization cache) — needs
 *   the Phase 06 DSL compiler and Phase 07 registry/PAP layer exercised
 *   adversarially. Phase 22D.
 * - Reliability category (database/policy/provider/cache failure, partial
 *   context failure) — needs providers that fail on demand (throwing
 *   fakes), not the always-succeeding fakes this file uses. Phase 22E.
 */
