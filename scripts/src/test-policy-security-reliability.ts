/**
 * scripts/src/test-policy-security-reliability.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 22E (Security / Abuse
 * Testing — Reliability category). LAST sub-phase of Phase 22.
 *
 * The roadmap's own Phase 22 section, verbatim, for the slice this file
 * covers:
 *
 *   "Reliability:
 *    - database failure
 *    - policy failure
 *    - provider timeout
 *    - cache failure
 *    - partial context failure
 *
 *    Authorization failures must fail closed."
 *
 * Phase 22 has five categories. 22A (Authorization), 22B (Authentication),
 * 22C (Context), 22D (Policy) are done. This is Reliability — 22D's own
 * named follow-up: "needs providers that fail ON DEMAND (throwing fakes),
 * not [22D's] always-succeeding-or-cleanly-rejecting fakes." After this
 * file, Phase 22 is complete.
 *
 * ── This file found a real fail-closed gap, and fixed it ──────────────────
 * Every prior Phase 22 sub-phase (22A-22D) was test-only: existing behavior
 * was already correct, so nothing needed to change. Writing THIS file's
 * fixtures — a `SubjectProvider`/`RiskProvider`/`SessionProvider`/
 * `DeviceProvider` that throws on demand, fed through `authorize()` via
 * `enrichment.pip` (Phase 18/19, same wiring 22C's own fixtures use) —
 * surfaced a real one: `pip/policy-information-point.ts`'s
 * `resolveSubject()`/`resolveContext()` and `pep/authorize.ts` itself had
 * NO try/catch anywhere around a PIP provider call. A throwing provider
 * (a DB outage, a network timeout — exactly what this category is named
 * for) propagated out of `authorize()` as a REJECTED PROMISE, not a DENY
 * decision — a direct violation of the roadmap's own NON-NEGOTIABLE Rule 8
 * ("Authorization failures must fail closed") and this exact phase's own
 * closing line, quoted above. Every OTHER provider-backed rule in this
 * engine (RBAC, ReBAC, resource-grant, ...) already fails closed correctly
 * today, because `PolicyEngine.evaluateCore()` (policy-engine.ts) wraps
 * every registered rule call in a try/catch that converts any throw into a
 * `POLICY_EVALUATION_ERROR` DENY (see that file's own header, "Fail-closed
 * (Rule 8)") — but a PIP provider throws BEFORE a request (and therefore
 * before any rule) even exists, entirely outside that mechanism's reach.
 *
 * Given Rule 8 is NON-NEGOTIABLE and this phase's own roadmap text names
 * "provider timeout"/"database failure"/"partial context failure" as
 * exactly the scenarios to test, documenting a fail-OPEN gap here (the way
 * 22C/22D documented already-safe absences, e.g. "no organizations table")
 * would not be the same kind of finding — it would mean shipping a test
 * suite whose own header has to say "this category does not actually pass
 * Rule 8". Per Rule 15 ("every phase requires an audit/review before
 * continuing") this was fixed as part of completing THIS phase, not
 * deferred to a hypothetical Phase 22F: `pep/authorize.ts` now wraps its
 * PIP calls in a try/catch and returns a synthesized `PIP_ENRICHMENT_ERROR`
 * DENY (new reason code, decision-reasons.ts) instead of letting the
 * exception propagate. See `authorize.ts`'s own header, "Phase 22E
 * hardening" section, for the exact mechanics and why this is a narrow,
 * deliberate exception to that file's "always call the real engine"
 * invariant — and CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE22E.md for the
 * full before/after. Every case in the "provider timeout" and "partial
 * context failure" sections below fails against the pre-fix code (the
 * `authorize()` call would reject instead of resolving to a decision) and
 * passes against the current, fixed source — this file exercises the FIX,
 * it does not merely describe it.
 *
 * ── "database failure" / "policy failure": already correct, verified here ─
 * The PDP-side half of this category (a `RbacProvider`, or any other
 * rule-level provider, throwing mid-evaluation) was ALREADY fail-closed
 * before this phase — `evaluateCore()`'s try/catch has existed since Phase
 * 1A. This file's "database failure"/"policy failure" sections exist to
 * pin that down with throwing fakes (not just read the source and trust
 * it), the same discipline 22A-D already apply to every OTHER claim in
 * this engine, and to show the guarantee is general: it holds regardless
 * of WHICH registered rule throws, WHAT it throws, or whether an earlier
 * rule had already produced ALLOW.
 *
 * ── "cache failure": no cache exists — same finding 22D already made ───────
 * 22D's own file header already searched this whole directory for a cache
 * and found none (`PolicyEngine.evaluate()` re-runs every rule every call;
 * `PolicyRegistry` reads straight through to its provider every call) —
 * see that file's "cache poisoning" section for the full reasoning, which
 * this file does not repeat wholesale. From a RELIABILITY angle specifically
 * (rather than 22D's poisoning/staleness angle), the same absence has a
 * direct consequence: there is no separate "cache is down" failure mode
 * for this engine to have today, because there is no cache sitting between
 * an evaluation and its provider that could BE down independently of the
 * provider itself — a "cache failure" here is just "database failure"
 * (the section already above) under a different name, and the "no cache"
 * check below reconfirms the specific claim that consequence rests on
 * (every read goes straight through, every single call) rather than
 * re-asserting 22D's conclusion on faith.
 *
 * Run: npx tsx scripts/src/test-policy-security-reliability.ts
 */

import assert from "node:assert/strict";
import type { Request } from "express";
import {
  authorize,
  PolicyEngine,
  PolicyInformationPoint,
  PolicyRegistry,
  RbacPolicyAdminAuthorizer,
  createRbacRule,
  type RbacProvider,
  type RoleRecord,
  type SubjectProvider,
  type RiskProvider,
  type SessionProvider,
  type DeviceProvider,
  type Subject,
  type PolicyAdminActor,
  type PolicyRecord,
  type PolicyRegistryProvider,
  type PolicyAdminAuditEntry,
  type NewPolicyInput,
  type PolicyStatus,
  type RuleEvaluationTrace,
} from "../../artifacts/api-server/src/lib/policy";
import type { AuthenticatedUserLike } from "../../artifacts/api-server/src/lib/policy/pip/subject-adapter";
import type { RiskSignal } from "../../artifacts/api-server/src/lib/policy/pip/risk-level-adapter";
import type { SessionRecord } from "../../artifacts/api-server/src/lib/policy/pip/session-context-adapter";
import type { DeviceSignal } from "../../artifacts/api-server/src/lib/policy/pip/device-trust-adapter";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

// ── error shapes a real failure would actually throw ──────────────────────
// Named/shaped like the real thing each scenario models, so a case reads as
// "what happens when THIS actually happens" rather than a generic Error.

/** Shape of what `pg`/Drizzle throws on a lost connection — this codebase's
 *  `DrizzleRbacProvider`/`DrizzleSubjectProvider`/etc. (rbac/drizzle-rbac-provider.ts
 *  and siblings) issue plain `db.select(...)` calls with nothing wrapping
 *  them; a real outage surfaces exactly like this. */
class DatabaseConnectionError extends Error {
  constructor(detail: string) {
    super(`Connection terminated unexpectedly: ${detail}`);
    this.name = "DatabaseConnectionError";
  }
}

/** Shape of a network call that exceeded its deadline. */
class ProviderTimeoutError extends Error {
  constructor(provider: string) {
    super(`${provider} timed out after 5000ms`);
    this.name = "ProviderTimeoutError";
  }
}

/** Models a rule with an actual bug — not a provider/DB problem at all,
 *  just a programmer error (e.g. a null-deref) inside rule logic. Kept
 *  distinct from the two above so "policy failure" is tested as its own
 *  named case, not merely re-run under "database failure"'s error type. */
class RuleLogicError extends TypeError {
  constructor() {
    super("Cannot read properties of undefined (reading 'tier')");
  }
}

// ── fakes — RBAC provider that can be told to fail on demand ──────────────

class FlakyRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoles = new Map<number, Set<string>>();
  failUserRoleKeysWith: Error | null = null;
  failRolePermissionKeysWith: Error | null = null;
  getUserRoleKeysCalls = 0;
  getRolePermissionKeysCalls = 0;

  addRole(key: string): void {
    this.roles.set(key, { key, parentRoleKey: null });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }
  grant(roleKey: string, permissionKey: string): void {
    if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }
  assignUserRole(userId: number, roleKey: string): void {
    if (!this.userRoles.has(userId)) this.userRoles.set(userId, new Set());
    this.userRoles.get(userId)!.add(roleKey);
  }
  async getUserRoleKeys(userId: number): Promise<string[]> {
    this.getUserRoleKeysCalls++;
    if (this.failUserRoleKeysWith) throw this.failUserRoleKeysWith;
    return [...(this.userRoles.get(userId) ?? [])];
  }
  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    this.getRolePermissionKeysCalls++;
    if (this.failRolePermissionKeysWith) throw this.failRolePermissionKeysWith;
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }
  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.roles.get(roleKey) ?? null;
  }
}

/** Same in-memory shape 22D's own `FakePolicyRegistryProvider` establishes,
 *  plus an on-demand failure toggle on `getLatestVersionNumber()` — the
 *  first provider call `createPolicy()`/`createNewVersion()` makes, so
 *  failing it here models "the DB was unreachable for this whole
 *  operation" without needing a failure toggle on every method. */
class FlakyPolicyRegistryProvider implements PolicyRegistryProvider {
  private nextId = 1;
  readonly rows: PolicyRecord[] = [];
  readonly auditLog: PolicyAdminAuditEntry[] = [];
  insertVersionCalls = 0;
  recordAuditCalls = 0;
  failGetLatestVersionNumberWith: Error | null = null;

  async getPolicy(policyId: string, version?: number): Promise<PolicyRecord | null> {
    const candidates = this.rows.filter((r) => r.policyId === policyId);
    if (version !== undefined) return candidates.find((r) => r.version === version) ?? null;
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.version > a.version ? b : a));
  }
  async getActivePolicy(policyId: string): Promise<PolicyRecord | null> {
    return this.rows.find((r) => r.policyId === policyId && r.status === "ACTIVE") ?? null;
  }
  async listActivePolicies(filter?: { application?: string; resource?: string }): Promise<PolicyRecord[]> {
    return this.rows.filter(
      (r) =>
        r.status === "ACTIVE" &&
        (filter?.application === undefined || r.application === filter.application) &&
        (filter?.resource === undefined || r.resource === filter.resource),
    );
  }
  async listVersions(policyId: string): Promise<PolicyRecord[]> {
    return this.rows.filter((r) => r.policyId === policyId).sort((a, b) => b.version - a.version);
  }
  async getLatestVersionNumber(policyId: string): Promise<number> {
    if (this.failGetLatestVersionNumberWith) throw this.failGetLatestVersionNumberWith;
    const candidates = this.rows.filter((r) => r.policyId === policyId);
    return candidates.length === 0 ? 0 : Math.max(...candidates.map((r) => r.version));
  }
  async insertVersion(input: NewPolicyInput & { version: number; createdBy: number }): Promise<PolicyRecord> {
    this.insertVersionCalls++;
    const now = new Date();
    const row: PolicyRecord = {
      id: this.nextId++,
      policyId: input.policyId,
      version: input.version,
      name: input.name,
      description: input.description ?? null,
      application: input.application,
      resource: input.resource,
      action: input.action,
      ruleKind: input.ruleKind,
      rules: input.rules,
      effect: input.effect,
      priority: input.priority ?? 0,
      status: "DRAFT",
      createdBy: input.createdBy,
      approvedBy: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
    };
    this.rows.push(row);
    return row;
  }
  async updateStatus(policyId: string, version: number, next: PolicyStatus, approvedBy: number | null): Promise<PolicyRecord> {
    const row = this.rows.find((r) => r.policyId === policyId && r.version === version);
    if (!row) throw new Error("not found");
    row.status = next;
    row.approvedBy = approvedBy;
    row.updatedAt = new Date();
    if (next === "APPROVED") row.approvedAt = new Date();
    return { ...row };
  }
  async recordAudit(entry: PolicyAdminAuditEntry): Promise<void> {
    this.recordAuditCalls++;
    this.auditLog.push(entry);
  }
}

// ── fakes — PIP providers that can be told to fail on demand ──────────────
// Same shapes 22C's own fixtures establish (keyed by server-verified facts
// only), each with an on/off failure switch instead of always succeeding.

class FlakySubjectProvider implements SubjectProvider {
  calls = 0;
  failWith: Error | null = null;
  constructor(private readonly byUserId: Map<number, Subject>) {}
  async getSubject(user: AuthenticatedUserLike | null | undefined): Promise<Subject | null> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    if (!user) return null;
    return this.byUserId.get(user.userId) ?? null;
  }
}

class FlakyRiskProvider implements RiskProvider {
  calls = 0;
  failWith: Error | null = null;
  constructor(private readonly signal: RiskSignal) {}
  async getRiskSignal(userId: number, ip: string | undefined): Promise<RiskSignal> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.signal;
  }
}

class FlakySessionProvider implements SessionProvider {
  calls = 0;
  failWith: Error | null = null;
  constructor(private readonly record: SessionRecord | null) {}
  async getSessionRecord(jti: string): Promise<SessionRecord | null> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.record;
  }
}

class FlakyDeviceProvider implements DeviceProvider {
  calls = 0;
  failWith: Error | null = null;
  constructor(private readonly signal: DeviceSignal) {}
  async getDeviceSignal(userId: number, userAgent: string): Promise<DeviceSignal> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.signal;
  }
}

/** Wraps a real `PolicyEngine` and counts `evaluate()` calls — used to
 *  prove, not merely assert from the decision shape, that a PIP failure
 *  short-circuits BEFORE the engine is ever reached (this file's "Phase
 *  22E hardening" claim in authorize.ts's own header). */
class CountingEngine {
  evaluateCalls = 0;
  constructor(private readonly inner: PolicyEngine) {}
  async evaluate(input: Parameters<PolicyEngine["evaluate"]>[0]) {
    this.evaluateCalls++;
    return this.inner.evaluate(input);
  }
}

function fakeRequest(overrides: { user?: unknown; headers?: Record<string, string>; ip?: string }): Request {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    body: {},
    query: {},
    ip: overrides.ip ?? "203.0.113.5",
  } as unknown as Request;
}

async function main() {
  console.log("Policy Engine — Phase 22E (Security / Abuse Testing — Reliability) tests");

  // ── database failure ─────────────────────────────────────────────────

  await test("database failure: RbacProvider.getUserRoleKeys() throwing a connection error mid-evaluation resolves to DENY/POLICY_EVALUATION_ERROR, never a hang or an unhandled rejection", async () => {
    const provider = new FlakyRbacProvider();
    provider.addRole("member");
    provider.grant("member", "sylo.vault.read");
    provider.assignUserRole(7, "member");
    provider.failUserRoleKeysWith = new DatabaseConnectionError("the database system is shutting down");

    const engine = new PolicyEngine();
    engine.registerRule("rbac", createRbacRule(provider));

    const decision = await engine.evaluate({
      subject: { userId: 7, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "r1", timestamp: new Date() },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    // Note: `PolicyEvaluationError`'s own message (policy-errors.ts) is a
    // fixed template — `Policy "<id>" threw during evaluation` — not the
    // underlying cause's message. The DatabaseConnectionError's own text
    // ("Connection terminated unexpectedly: ...") is preserved on
    // `PolicyEvaluationError.cause` but that wrapper (and its `.cause`)
    // is never itself attached to the returned `AuthorizationDecision` —
    // only `.message` is read (see evaluateCore()'s catch branch). This
    // is a real audit-detail gap (Rule 10 cares about WHY, and today's
    // decision only ever says "a policy threw", never what it threw) but
    // NOT a fail-closed gap — the DENY itself, and `policyId` naming which
    // rule failed, are both still fully correct and are what this case
    // actually asserts.
    assert.match(decision.message ?? "", /Policy "rbac" threw during evaluation/);
    assert.equal(decision.policyId, "rbac");
  });

  await test("database failure: RbacProvider.getRolePermissionKeys() throwing (deeper in role-resolver.ts's BFS) is caught the exact same way as getUserRoleKeys() throwing", async () => {
    const provider = new FlakyRbacProvider();
    provider.addRole("member");
    provider.assignUserRole(7, "member");
    provider.failRolePermissionKeysWith = new DatabaseConnectionError("connection reset by peer");

    const engine = new PolicyEngine();
    engine.registerRule("rbac", createRbacRule(provider));

    const decision = await engine.evaluate({
      subject: { userId: 7, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "r2", timestamp: new Date() },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
  });

  await test("database failure: PolicyRegistry.createPolicy() rejects (never partially writes) when the provider's very first read fails — insertVersion() and recordAudit() are never called", async () => {
    const rbacProvider = new FlakyRbacProvider();
    rbacProvider.addRole("policy-admin");
    rbacProvider.grant("policy-admin", "admin.policy.manage");
    rbacProvider.assignUserRole(1, "policy-admin");
    const authorizer = new RbacPolicyAdminAuthorizer(rbacProvider);
    const registryProvider = new FlakyPolicyRegistryProvider();
    registryProvider.failGetLatestVersionNumberWith = new DatabaseConnectionError("terminating connection due to administrator command");
    const registry = new PolicyRegistry(registryProvider, authorizer);
    const actor: PolicyAdminActor = { userId: 1, roleKeys: ["policy-admin"] };

    await assert.rejects(
      () =>
        registry.createPolicy(actor, {
          policyId: "outage-test",
          name: "Outage Test Policy",
          application: "sylo",
          resource: "vault",
          action: "read",
          effect: "allow",
          ruleKind: "abac_dsl",
          rules: 'subject.role == "member"',
        }),
      DatabaseConnectionError,
    );
    assert.equal(registryProvider.insertVersionCalls, 0);
    assert.equal(registryProvider.recordAuditCalls, 0);
  });

  // ── policy failure ───────────────────────────────────────────────────

  await test("policy failure: a registered rule with a plain programmer bug (not a provider/DB problem) still resolves to DENY/POLICY_EVALUATION_ERROR — fail-closed does not care WHY a rule threw", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("buggy-rule", () => {
      throw new RuleLogicError();
    });

    const decision = await engine.evaluate({
      subject: { userId: 1, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "r3", timestamp: new Date() },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    assert.equal(decision.policyId, "buggy-rule");
  });

  await test("policy failure: a LATER rule throwing overrides an EARLIER rule's ALLOW — deny-overrides combining (policy-engine.ts) treats a thrown rule as an immediate, unconditional deny regardless of what already ran", async () => {
    const engine = new PolicyEngine();
    let thirdRuleCalls = 0;
    engine.registerRule("first-allows", () => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: "r4",
      evaluatedAt: new Date(),
    }));
    engine.registerRule("second-throws", () => {
      throw new RuleLogicError();
    });
    engine.registerRule("third-never-runs", () => {
      thirdRuleCalls++;
      return null;
    });

    const decision = await engine.evaluate({
      subject: { userId: 1, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "r4", timestamp: new Date() },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    assert.equal(thirdRuleCalls, 0); // short-circuited — rules after the throw never ran
  });

  await test("policy failure: evaluateWithTrace() records the throwing rule's own synthesized DENY in the trace, in position, and stops — trace never shows a rule that didn't actually run", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("abstains", () => null);
    engine.registerRule("throws", () => {
      throw new RuleLogicError();
    });
    engine.registerRule("never-reached", () => null);

    const { decision, trace } = await engine.evaluateWithTrace({
      subject: { userId: 1, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "r5", timestamp: new Date() },
    });

    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    const ids = trace.map((t: RuleEvaluationTrace) => t.id);
    assert.deepEqual(ids, ["abstains", "throws"]); // "never-reached" is genuinely never reached
    assert.equal(trace[1].decision?.reason, "POLICY_EVALUATION_ERROR");
  });

  // ── provider timeout ─────────────────────────────────────────────────

  await test("provider timeout: an RbacProvider call that rejects with a timeout error (PDP layer) fails closed exactly like any other provider throw — timeouts are not a special case this engine treats differently from a hard failure", async () => {
    const provider = new FlakyRbacProvider();
    provider.addRole("member");
    provider.assignUserRole(7, "member");
    provider.failUserRoleKeysWith = new ProviderTimeoutError("DrizzleRbacProvider.getUserRoleKeys");

    const engine = new PolicyEngine();
    engine.registerRule("rbac", createRbacRule(provider));

    const decision = await engine.evaluate({
      subject: { userId: 7, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "r6", timestamp: new Date() },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    // Same generic-message note as the "database failure" case above — the
    // timeout-specific text lives on the swallowed cause, not on the
    // decision itself.
    assert.match(decision.message ?? "", /Policy "rbac" threw during evaluation/);
  });

  await test("provider timeout: a RiskProvider timing out inside enrichment.pip.resolveSubject() (PIP layer) now resolves authorize() to DENY/PIP_ENRICHMENT_ERROR instead of rejecting the returned promise — the Phase 22E fix, exercised end to end", async () => {
    const subjectProvider = new FlakySubjectProvider(new Map([[9, { userId: 9, role: "member", authType: "session" }]]));
    const riskProvider = new FlakyRiskProvider({ anomalousIp: false, recentFailedLogins: 0 });
    riskProvider.failWith = new ProviderTimeoutError("LoginSecurityRiskProvider.getRiskSignal");
    const pip = new PolicyInformationPoint({ subject: subjectProvider, risk: riskProvider });
    const innerEngine = new PolicyEngine();
    innerEngine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));
    const engine = new CountingEngine(innerEngine);

    const req = fakeRequest({ user: { userId: 9, role: "member" } });
    // Before this fix, this line would REJECT (unhandled promise rejection)
    // rather than resolve — see this file's own header. Reaching the
    // assertions below at all is part of what this case is checking.
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "vault_item", id: "1" }, enrichment: { pip } });

    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "PIP_ENRICHMENT_ERROR");
    assert.match(outcome.decision.message ?? "", /timed out/);
    assert.equal(outcome.subject, null);
    assert.equal(outcome.request, undefined);
    assert.equal(engine.evaluateCalls, 0); // the always-allow rule never ran — no unsafe fallback ALLOW was possible
  });

  // ── cache failure ────────────────────────────────────────────────────

  await test("cache failure: there is no cache to fail — PolicyRegistry.getActivePolicy() reads through to the provider on EVERY call, with no memoization, so a 'cache down' scenario cannot occur independently of a 'provider down' scenario (already covered above)", async () => {
    const rbacProvider = new FlakyRbacProvider();
    rbacProvider.addRole("policy-admin");
    rbacProvider.grant("policy-admin", "admin.policy.manage");
    rbacProvider.grant("policy-admin", "admin.policy.approve");
    rbacProvider.assignUserRole(1, "policy-admin");
    rbacProvider.assignUserRole(2, "policy-admin");
    const authorizer = new RbacPolicyAdminAuthorizer(rbacProvider);
    const registryProvider = new FlakyPolicyRegistryProvider();
    const registry = new PolicyRegistry(registryProvider, authorizer);
    const author: PolicyAdminActor = { userId: 1, roleKeys: ["policy-admin"] };
    const approver: PolicyAdminActor = { userId: 2, roleKeys: ["policy-admin"], assuranceMethods: ["totp"] };

    const created = await registry.createPolicy(author, {
      policyId: "no-cache-check",
      name: "No Cache Check Policy",
      application: "sylo",
      resource: "vault",
      action: "read",
      effect: "allow",
      ruleKind: "abac_dsl",
      rules: 'subject.role == "member"',
    });
    await registry.transitionStatus(author, created.policyId, created.version, "TESTING");
    await registry.transitionStatus(approver, created.policyId, created.version, "APPROVED");
    await registry.transitionStatus(approver, created.policyId, created.version, "ACTIVE");

    // Delegate every method explicitly (not a `{ ...registryProvider }`
    // spread, which would copy zero of a class instance's own prototype
    // methods) so `getActivePolicy` alone can be call-counted while every
    // other method still reads through to the real fixture.
    let providerReads = 0;
    const countedProvider: PolicyRegistryProvider = {
      getPolicy: (policyId, version) => registryProvider.getPolicy(policyId, version),
      getActivePolicy: async (policyId: string) => {
        providerReads++;
        return registryProvider.getActivePolicy(policyId);
      },
      listActivePolicies: (filter) => registryProvider.listActivePolicies(filter),
      listVersions: (policyId) => registryProvider.listVersions(policyId),
      getLatestVersionNumber: (policyId) => registryProvider.getLatestVersionNumber(policyId),
      insertVersion: (input) => registryProvider.insertVersion(input),
      updateStatus: (policyId, version, next, approvedBy) => registryProvider.updateStatus(policyId, version, next, approvedBy),
      recordAudit: (entry) => registryProvider.recordAudit(entry),
    };
    const countedRegistry = new PolicyRegistry(countedProvider, authorizer);
    await countedRegistry.getActivePolicy("no-cache-check");
    await countedRegistry.getActivePolicy("no-cache-check");
    await countedRegistry.getActivePolicy("no-cache-check");
    assert.equal(providerReads, 3); // every call reached the provider — nothing short-circuited by a cache
  });

  // ── partial context failure ──────────────────────────────────────────

  await test("partial context failure: SubjectProvider + RiskProvider both succeed, but SessionProvider throws during resolveContext() — the whole authorize() call fails closed rather than proceeding with a partially-enriched context", async () => {
    const subjectProvider = new FlakySubjectProvider(new Map([[11, { userId: 11, role: "member", authType: "session" }]]));
    const riskProvider = new FlakyRiskProvider({ anomalousIp: false, recentFailedLogins: 0 });
    const sessionProvider = new FlakySessionProvider({ createdAt: new Date() });
    sessionProvider.failWith = new DatabaseConnectionError("user_sessions read failed");
    const pip = new PolicyInformationPoint({ subject: subjectProvider, risk: riskProvider, session: sessionProvider });
    const innerEngine = new PolicyEngine();
    innerEngine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));
    const engine = new CountingEngine(innerEngine);

    const req = fakeRequest({ user: { userId: 11, role: "member" }, headers: { "user-agent": "TestAgent/1.0" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "vault_item", id: "1" }, enrichment: { pip, sessionId: () => "jti-123" } });

    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "PIP_ENRICHMENT_ERROR");
    // subject/risk enrichment DID succeed before the session read threw —
    // outcome.subject is still null, honestly reflecting that the overall
    // resolution failed, not the partial success along the way.
    assert.equal(outcome.subject, null);
    assert.equal(riskProvider.calls, 1); // ran — risk enrichment happens inside resolveSubject(), before resolveContext()
    assert.equal(engine.evaluateCalls, 0); // never reached the engine with the partial context
  });

  await test("partial context failure: SubjectProvider + SessionProvider succeed, but DeviceProvider throws — same fail-closed outcome regardless of WHICH enrichment step is the one that fails", async () => {
    const subjectProvider = new FlakySubjectProvider(new Map([[12, { userId: 12, role: "member", authType: "session" }]]));
    const sessionProvider = new FlakySessionProvider({ createdAt: new Date() });
    const deviceProvider = new FlakyDeviceProvider({ seenBefore: true });
    deviceProvider.failWith = new ProviderTimeoutError("DrizzleDeviceTrustProvider.getDeviceSignal");
    const pip = new PolicyInformationPoint({ subject: subjectProvider, session: sessionProvider, device: deviceProvider });
    const innerEngine = new PolicyEngine();
    innerEngine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));
    const engine = new CountingEngine(innerEngine);

    const req = fakeRequest({ user: { userId: 12, role: "member" }, headers: { "user-agent": "TestAgent/1.0" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "vault_item", id: "1" }, enrichment: { pip, sessionId: () => "jti-456" } });

    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "PIP_ENRICHMENT_ERROR");
    assert.equal(sessionProvider.calls, 1); // session enrichment ran and succeeded before device enrichment threw
    assert.equal(engine.evaluateCalls, 0);
  });

  await test("partial context failure: with no enrichment.pip supplied at all (Phase 1B fallback), there is no PIP-layer partial-failure surface to begin with — subjectFromAuthUser()/policyContextFromRequest() are pure, DB-free, and cannot throw", async () => {
    const innerEngine = new PolicyEngine();
    innerEngine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));
    const engine = new CountingEngine(innerEngine);
    const req = fakeRequest({ user: { userId: 1, role: "member" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "vault_item", id: "1" } });
    assert.equal(outcome.decision.effect, "ALLOW");
    assert.equal(engine.evaluateCalls, 1);
  });

  console.log("\nAll Phase 22E Reliability abuse-testing checks passed.");
  console.log("Phase 22 (Security / Abuse Testing) — all five categories (Authorization, Authentication, Context, Policy, Reliability) complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ── Known limitations ──────────────────────────────────────────────────
 * - **Not executed live** — same constraint every Phase 22 sub-phase's own
 *   "Tests"/"Known limitations" section documents (no network access, no
 *   installed `node_modules` in this sandbox). Every case here was traced
 *   by hand against the current, real source of `policy-engine.ts`,
 *   `pip/policy-information-point.ts`, `pep/authorize.ts` (post-fix),
 *   `rbac/role-resolver.ts`, `rbac/rbac-rule.ts`, and `registry/policy-registry.ts`
 *   to confirm the exact code path each assertion exercises. Please run
 *   `npx tsx scripts/src/test-policy-security-reliability.ts` in a real
 *   environment and report back if any case doesn't match this analysis.
 * - **No provider-level timeout/deadline exists anywhere in this engine —
 *   a HANGING provider (one whose promise never settles, as opposed to one
 *   that quickly rejects) will hang the whole authorization decision
 *   indefinitely**, at both the PDP layer (a rule awaiting a provider) and
 *   the PIP layer (even after this phase's fix — the fix catches a THROW,
 *   it does not race a slow provider against a clock). Every "provider
 *   timeout" case in this file models a provider that REJECTS with a
 *   timeout-shaped error (what a real HTTP/DB client library actually does
 *   once its own internal deadline fires), which is the realistic shape a
 *   caller of this engine will actually observe — this engine has never
 *   had a deadline of its own to race against. Adding one (an
 *   `AbortSignal`/`Promise.race` wrapper around every provider call) is
 *   real, additive infrastructure work, not a test-phase fix, and is
 *   deliberately left to a future phase (Rule 16 — do not implement future
 *   phases prematurely; Rule 17 — avoid unnecessary infrastructure
 *   introduced reactively rather than by deliberate design).
 * - **The "database failure" PAP-layer case only fails `getLatestVersionNumber()`**,
 *   the first call `createPolicy()`/`createNewVersion()` make — not every
 *   `PolicyRegistryProvider` method individually. This models "the DB was
 *   unreachable for this whole operation" (the realistic failure mode) and
 *   is sufficient to confirm no partial write occurs; it does not claim
 *   every individual method has its own bespoke handling (none of them
 *   needs one — `PolicyRegistry` has no try/catch anywhere, so ANY method
 *   throwing simply rejects the whole call, uniformly).
 */
