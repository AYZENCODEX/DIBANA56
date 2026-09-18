/**
 * scripts/src/test-policy-explainability.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 15 (Explainability) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-explainability.ts
 *
 * Covers:
 *   - userMessage is the fixed GENERIC_DENIAL_MESSAGE for every non-ALLOW
 *     effect (DENY/STEP_UP/APPROVAL_REQUIRED), regardless of reason code
 *   - userMessage is undefined for ALLOW
 *   - detail is undefined whenever includeDetail is false/omitted,
 *     regardless of how sensitive the underlying decision was
 *   - detail, when included, carries policyId/matchedRule, reasonCode +
 *     matching reasonDescription, requiredAssurance passthrough, and
 *     requestId/evaluatedAt copied verbatim from the decision
 *   - detail.matchedRules passes an already-built trace through verbatim
 *     when supplied, and is undefined (not []) when omitted
 *   - detail.assuranceLevel/risk/resource are all undefined when no
 *     `request` is supplied, and populated (assuranceLevel via the real
 *     Phase 09 computeAssuranceLevel(), risk from subject.riskLevel,
 *     resource from request.resource) when one is
 *   - determinism: two identical calls produce the same shape
 *   - canViewExplanationDetail(): unauthenticated denied; a role granted
 *     the exact admin.policy.explain permission allowed; a role granted
 *     only an unrelated permission denied; a wildcard grant (admin.*, *)
 *     allowed; inherited-role grant allowed; revoked grant denied
 *   - end-to-end: a real PolicyEngine (RBAC + risk rules registered) run
 *     via evaluateWithTrace(), explained once for an ordinary end user
 *     (includeDetail: false — sees only the generic message, and
 *     specifically never sees the real HIGH_RISK_DENIED reason code) and
 *     once for an admin viewer (includeDetail: true, decided by
 *     canViewExplanationDetail() against a real FakeRbacProvider — sees
 *     full detail including the actual reason code and risk level)
 *
 * Run: npx tsx scripts/src/test-policy-explainability.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createRbacRule,
  createRiskRule,
  RBAC_POLICY_ID,
  RISK_POLICY_ID,
  allow,
  deny,
  stepUp,
  approvalRequired,
  explainAuthorizationDecision,
  canViewExplanationDetail,
  GENERIC_DENIAL_MESSAGE,
  POLICY_EXPLANATION_PERMISSION,
  DECISION_REASON_DESCRIPTIONS,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type BuildAuthorizationRequestInput,
  type MatchedRuleTrace,
  type RbacProvider,
  type RoleRecord,
  type Subject,
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

// ── FakeRbacProvider — same in-memory stand-in test-policy-rbac.ts uses ────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoles = new Map<number, Set<string>>();

  addRole(key: string, parentRoleKey: string | null = null): void {
    this.roles.set(key, { key, parentRoleKey });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }

  grant(roleKey: string, permissionKey: string): void {
    if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }

  revoke(roleKey: string, permissionKey: string): void {
    this.rolePermissions.get(roleKey)?.delete(permissionKey);
  }

  assignUserRole(userId: number, roleKey: string): void {
    if (!this.userRoles.has(userId)) this.userRoles.set(userId, new Set());
    this.userRoles.get(userId)!.add(roleKey);
  }

  unassignUserRole(userId: number, roleKey: string): void {
    this.userRoles.get(userId)?.delete(roleKey);
  }

  async getUserRoleKeys(userId: number): Promise<string[]> {
    return [...(this.userRoles.get(userId) ?? [])];
  }

  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }

  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.roles.get(roleKey) ?? null;
  }
}

const alice: Subject = { userId: 1, role: "user", authType: "session" };

function baseInput(overrides: Partial<BuildAuthorizationRequestInput> = {}): BuildAuthorizationRequestInput {
  return {
    subject: alice,
    action: "sylo.vault.read",
    resource: { type: "sylo.vault_item", id: 42, ownerId: 1 },
    ...overrides,
  };
}

async function run() {
  console.log("Phase 15 — Explainability tests\n");

  // ── userMessage ──────────────────────────────────────────────────────

  await test("userMessage is the generic message for DENY", () => {
    const decision = deny({ subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r1", timestamp: new Date() } }, "EXPLICIT_DENY");
    const explanation = explainAuthorizationDecision({ decision });
    assert.equal(explanation.userMessage, GENERIC_DENIAL_MESSAGE);
  });

  await test("userMessage is the generic message for STEP_UP", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r2", timestamp: new Date() } };
    const decision = stepUp(req, { requiredAssurance: "L3" });
    const explanation = explainAuthorizationDecision({ decision });
    assert.equal(explanation.userMessage, GENERIC_DENIAL_MESSAGE);
  });

  await test("userMessage is the generic message for APPROVAL_REQUIRED", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r3", timestamp: new Date() } };
    const decision = approvalRequired(req);
    const explanation = explainAuthorizationDecision({ decision });
    assert.equal(explanation.userMessage, GENERIC_DENIAL_MESSAGE);
  });

  await test("userMessage is undefined for ALLOW", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r4", timestamp: new Date() } };
    const decision = allow(req, "EXPLICIT_ALLOW");
    const explanation = explainAuthorizationDecision({ decision });
    assert.equal(explanation.userMessage, undefined);
  });

  await test("userMessage does not vary by reason code (never leaks which rule fired)", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r5", timestamp: new Date() } };
    const deny1 = deny(req, "HIGH_RISK_DENIED");
    const deny2 = deny(req, "RESOURCE_LOCKED");
    const m1 = explainAuthorizationDecision({ decision: deny1 }).userMessage;
    const m2 = explainAuthorizationDecision({ decision: deny2 }).userMessage;
    assert.equal(m1, m2);
    assert.equal(m1, GENERIC_DENIAL_MESSAGE);
  });

  // ── detail gating ────────────────────────────────────────────────────

  await test("detail is undefined when includeDetail is omitted", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r6", timestamp: new Date() } };
    const decision = deny(req, "HIGH_RISK_DENIED", { message: "sensitive internal detail" });
    const explanation = explainAuthorizationDecision({ decision, request: req });
    assert.equal(explanation.detail, undefined);
  });

  await test("detail is undefined when includeDetail is explicitly false", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r7", timestamp: new Date() } };
    const decision = deny(req, "HIGH_RISK_DENIED");
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: false });
    assert.equal(explanation.detail, undefined);
  });

  await test("detail is populated when includeDetail is true", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r8", timestamp: new Date() } };
    const decision = deny(req, "HIGH_RISK_DENIED", { policyId: RISK_POLICY_ID });
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.ok(explanation.detail);
    assert.equal(explanation.detail!.policyId, RISK_POLICY_ID);
    assert.equal(explanation.detail!.matchedRule, RISK_POLICY_ID);
    assert.equal(explanation.detail!.decision, "DENY");
    assert.equal(explanation.detail!.reasonCode, "HIGH_RISK_DENIED");
    assert.equal(explanation.detail!.reasonDescription, DECISION_REASON_DESCRIPTIONS.HIGH_RISK_DENIED);
    assert.equal(explanation.detail!.requestId, decision.requestId);
    assert.equal(explanation.detail!.evaluatedAt, decision.evaluatedAt);
  });

  await test("detail.requiredAssurance passes through verbatim for an assurance-gated STEP_UP", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r9", timestamp: new Date() } };
    const decision = stepUp(req, { requiredAssurance: "L3" });
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.equal(explanation.detail!.requiredAssurance, "L3");
  });

  await test("detail.requiredAssurance is undefined for a risk-gated STEP_UP (no named level)", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r10", timestamp: new Date() } };
    const decision = stepUp(req); // no requiredAssurance option, e.g. risk/risk-rule.ts's MEDIUM path
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.equal(explanation.detail!.requiredAssurance, undefined);
  });

  await test("detail.policyVersion passes through the caller-supplied enrichment verbatim", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r11", timestamp: new Date() } };
    const decision = deny(req, "EXPLICIT_DENY", { policyId: "some-registry-policy" });
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true, policyVersion: 7 });
    assert.equal(explanation.detail!.policyVersion, 7);
  });

  // ── matchedRules passthrough ─────────────────────────────────────────

  await test("detail.matchedRules is undefined when no trace is supplied", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r12", timestamp: new Date() } };
    const decision = allow(req, "EXPLICIT_ALLOW", { policyId: RBAC_POLICY_ID });
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.equal(explanation.detail!.matchedRules, undefined);
  });

  await test("detail.matchedRules passes an already-built trace through verbatim, INCLUDING abstentions", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r13", timestamp: new Date() } };
    const decision = allow(req, "EXPLICIT_ALLOW", { policyId: RBAC_POLICY_ID });
    const trace: MatchedRuleTrace[] = [
      { policyId: "ownership", decision: null }, // abstained
      { policyId: RBAC_POLICY_ID, decision },
    ];
    const explanation = explainAuthorizationDecision({ decision, request: req, trace, includeDetail: true });
    assert.equal(explanation.detail!.matchedRules, trace);
    assert.equal(explanation.detail!.matchedRules!.length, 2);
    assert.equal(explanation.detail!.matchedRules![0].decision, null);
  });

  // ── request-derived fields (assuranceLevel / risk / resource) ────────

  await test("detail.assuranceLevel/risk/resource are all undefined when no request is supplied", () => {
    const decision: AuthorizationDecision = {
      effect: "DENY",
      reason: "HIGH_RISK_DENIED",
      requestId: "r14",
      evaluatedAt: new Date(),
    };
    const explanation = explainAuthorizationDecision({ decision, includeDetail: true });
    assert.equal(explanation.detail!.assuranceLevel, undefined);
    assert.equal(explanation.detail!.risk, undefined);
    assert.equal(explanation.detail!.resource, undefined);
  });

  await test("detail.risk/resource are copied from the request when one is supplied", () => {
    const riskySubject: Subject = { ...alice, riskLevel: "high" };
    const req: AuthorizationRequest = {
      subject: riskySubject,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: 99, ownerId: 1, classification: "confidential" },
      context: { requestId: "r15", timestamp: new Date() },
    };
    const decision = deny(req, "HIGH_RISK_DENIED", { policyId: RISK_POLICY_ID });
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.equal(explanation.detail!.risk, "high");
    assert.deepEqual(explanation.detail!.resource, req.resource);
  });

  await test("detail.assuranceLevel reflects the real computeAssuranceLevel() output, not a guess", () => {
    const passkeySubject: Subject = { ...alice, assuranceMethods: ["passkey"] };
    const req: AuthorizationRequest = {
      subject: passkeySubject,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: 1 },
      context: { requestId: "r16", timestamp: new Date() },
    };
    const decision = allow(req, "EXPLICIT_ALLOW");
    const explanation = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.equal(explanation.detail!.assuranceLevel, "L4"); // passkey => L4, per assurance-level.ts
  });

  // ── determinism ──────────────────────────────────────────────────────

  await test("determinism: identical input produces the same explanation shape twice", () => {
    const req: AuthorizationRequest = { subject: alice, action: "x", resource: { type: "t" }, context: { requestId: "r17", timestamp: new Date() } };
    const decision = deny(req, "HIGH_RISK_DENIED", { policyId: RISK_POLICY_ID });
    const e1 = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    const e2 = explainAuthorizationDecision({ decision, request: req, includeDetail: true });
    assert.deepEqual(e1, e2);
  });

  // ── canViewExplanationDetail() — viewer gating ───────────────────────

  await test("canViewExplanationDetail: unauthenticated (null subject) is denied", async () => {
    const provider = new FakeRbacProvider();
    const result = await canViewExplanationDetail(null, provider);
    assert.equal(result, false);
  });

  await test("canViewExplanationDetail: a role with no relevant grant is denied", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("user", null);
    provider.grant("user", "sylo.vault.read");
    const subject: Subject = { userId: 10, role: "user", authType: "session" };
    const result = await canViewExplanationDetail(subject, provider);
    assert.equal(result, false);
  });

  await test("canViewExplanationDetail: an explicit admin.policy.explain grant is allowed", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("auditor", null);
    provider.grant("auditor", POLICY_EXPLANATION_PERMISSION);
    provider.assignUserRole(20, "auditor");
    // subject.role is a legacy string unrelated to "auditor" — coverage
    // must come from the explicitly-assigned custom role, proving this
    // isn't just matching on legacy role membership.
    const subject: Subject = { userId: 20, role: "user", authType: "session" };
    const result = await canViewExplanationDetail(subject, provider);
    assert.equal(result, true);
  });

  await test("canViewExplanationDetail: the admin legacy role's wildcard grant is allowed", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("user", null);
    provider.addRole("dev", "user");
    provider.addRole("admin", "dev");
    provider.grant("admin", "*"); // migration 096's own seed shape
    const subject: Subject = { userId: 30, role: "admin", authType: "session" };
    const result = await canViewExplanationDetail(subject, provider);
    assert.equal(result, true);
  });

  await test("canViewExplanationDetail: a narrower admin.* wildcard is allowed", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("ops", null);
    provider.grant("ops", "admin.*");
    provider.assignUserRole(40, "ops");
    const subject: Subject = { userId: 40, role: "user", authType: "session" };
    const result = await canViewExplanationDetail(subject, provider);
    assert.equal(result, true);
  });

  await test("canViewExplanationDetail: inherited role grant is allowed", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("base-auditor", null);
    provider.grant("base-auditor", POLICY_EXPLANATION_PERMISSION);
    provider.addRole("senior-auditor", "base-auditor");
    provider.assignUserRole(50, "senior-auditor");
    const subject: Subject = { userId: 50, role: "user", authType: "session" };
    const result = await canViewExplanationDetail(subject, provider);
    assert.equal(result, true);
  });

  await test("canViewExplanationDetail: a revoked grant is denied", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("auditor", null);
    provider.grant("auditor", POLICY_EXPLANATION_PERMISSION);
    provider.assignUserRole(60, "auditor");
    provider.revoke("auditor", POLICY_EXPLANATION_PERMISSION);
    const subject: Subject = { userId: 60, role: "user", authType: "session" };
    const result = await canViewExplanationDetail(subject, provider);
    assert.equal(result, false);
  });

  // ── end-to-end: real engine + real trace + two different viewers ────

  await test("end-to-end: an ordinary end user sees only the generic message, never the real reason code", async () => {
    const engine = new PolicyEngine();
    const rbacProvider = new FakeRbacProvider();
    rbacProvider.addRole("user", null);
    rbacProvider.grant("user", "sylo.vault.read");
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbacProvider));
    engine.registerRule(RISK_POLICY_ID, createRiskRule());

    const riskySubject: Subject = { userId: 70, role: "user", authType: "session", riskLevel: "high" };
    const input = baseInput({ subject: riskySubject });
    const { decision, request } = await engine.evaluateWithTrace(input);
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "HIGH_RISK_DENIED");

    // Ordinary end-user viewer — never even asked canViewExplanationDetail
    // in this app's real flow (a route wouldn't bother calling it for a
    // non-admin), but included here explicitly so the DENY path is
    // exercised too, not only the ALLOW path above.
    const endUserProvider = new FakeRbacProvider();
    endUserProvider.addRole("user", null);
    const endUserCanView = await canViewExplanationDetail(riskySubject, endUserProvider);
    assert.equal(endUserCanView, false);

    const endUserExplanation = explainAuthorizationDecision({ decision, request, includeDetail: endUserCanView });
    assert.equal(endUserExplanation.userMessage, GENERIC_DENIAL_MESSAGE);
    assert.equal(endUserExplanation.detail, undefined);
    // The real reason code must never leak into the rendered user-facing
    // string.
    assert.equal(JSON.stringify(endUserExplanation).includes("HIGH_RISK_DENIED"), false);
  });

  await test("end-to-end: an authorized admin viewer sees full detail, including the real reason code and risk level", async () => {
    const engine = new PolicyEngine();
    const rbacProvider = new FakeRbacProvider();
    rbacProvider.addRole("user", null);
    rbacProvider.grant("user", "sylo.vault.read");
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(rbacProvider));
    engine.registerRule(RISK_POLICY_ID, createRiskRule());

    const riskySubject: Subject = { userId: 71, role: "user", authType: "session", riskLevel: "high" };
    const input = baseInput({ subject: riskySubject });
    const { decision, request, trace } = await engine.evaluateWithTrace(input);

    const adminProvider = new FakeRbacProvider();
    adminProvider.addRole("admin", null);
    adminProvider.grant("admin", "*");
    const adminViewer: Subject = { userId: 999, role: "admin", authType: "session" };
    const adminCanView = await canViewExplanationDetail(adminViewer, adminProvider);
    assert.equal(adminCanView, true);

    const adminExplanation = explainAuthorizationDecision({
      decision,
      request,
      trace: trace.map(({ id, decision: d }) => ({ policyId: id, decision: d })),
      includeDetail: adminCanView,
    });
    assert.equal(adminExplanation.detail!.reasonCode, "HIGH_RISK_DENIED");
    assert.equal(adminExplanation.detail!.risk, "high");
    assert.equal(adminExplanation.detail!.policyId, RISK_POLICY_ID);
    assert.ok(adminExplanation.detail!.matchedRules && adminExplanation.detail!.matchedRules.length >= 1);
  });

  console.log("\nAll Phase 15 (Explainability) tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
