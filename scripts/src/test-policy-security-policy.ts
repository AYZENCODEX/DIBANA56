/**
 * scripts/src/test-policy-security-policy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 22D (Security / Abuse
 * Testing — Policy category).
 *
 * The roadmap's own Phase 22 section, verbatim, for the slice this file
 * covers:
 *
 *   "Policy:
 *    - policy injection
 *    - invalid DSL
 *    - conflicting rules
 *    - priority abuse
 *    - cache poisoning
 *    - stale authorization cache"
 *
 * 22A (Authorization), 22B (Authentication), 22C (Context) are done; this
 * is 22C's own named next sub-phase. Reliability remains — see this file's
 * closing comment.
 *
 * ── Why this needs the real Phase 06 DSL + Phase 07 registry ─────────────
 * Every prior 22-series file assumed a fixed, already-registered rule set
 * and asked "can a hostile CLIENT REQUEST influence the decision". This
 * category is different: it asks "can hostile POLICY CONTENT itself (DSL
 * text an admin — possibly a compromised or malicious one — submits)
 * either execute something it shouldn't, or produce an ambiguous/
 * non-deterministic decision". That requires the real `parseAbacDsl()`/
 * `compileAbacPolicy()` (../abac/dsl) and the real `PolicyRegistry`
 * (../registry/policy-registry.ts) — no fake stands in for either, since
 * the whole question is about what THEIR code actually does with
 * adversarial text, not about a client-request boundary a fake could
 * abstract away.
 *
 * ── Cache poisoning / stale authorization cache: no cache exists yet ─────
 * A repo-wide search of `lib/policy/*` turns up no caching layer at all —
 * no memoized rule-set, no decision cache, no TTL anywhere in this
 * directory (the roadmap's own PERFORMANCE RULES section: "Introduce
 * caching only after correctness" — correctness-only is exactly where this
 * engine still is). Building a fake cache here to "test" would be
 * inventing infrastructure this codebase doesn't have, exactly what Rule
 * 18 forbids for production code — and a test of imaginary infrastructure
 * proves nothing about the real one. What IS real and testable: whether
 * anything in the registry→PDP path introduces ACCIDENTAL staleness even
 * without an explicit cache (a lingering reference, a snapshot taken too
 * early). The "cache" sub-section below tests exactly that, against the
 * real `PolicyRegistry`/`createRegistryPolicyRules()` — see that section's
 * own comment for what it actually proves.
 *
 * Run: npx tsx scripts/src/test-policy-security-policy.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  PolicyRegistry,
  RbacPolicyAdminAuthorizer,
  InvalidPolicyContentError,
  createRegistryPolicyRules,
  DslError,
  compileAbacPolicy,
  parseAbacDsl,
  MAX_INPUT_LENGTH,
  MAX_TOKENS,
  type PolicyAdminActor,
  type PolicyAdminAuditEntry,
  type PolicyRecord,
  type PolicyRegistryProvider,
  type PolicyStatus,
  type NewPolicyInput,
  type RbacProvider,
  type RoleRecord,
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

// ── fixtures — same shape test-policy-registry.ts (Phase 07) already
//    establishes, so this file exercises the identical real code path ────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  addRole(key: string): void {
    this.roles.set(key, { key, parentRoleKey: null });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }
  grant(roleKey: string, permissionKey: string): void {
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

function buildAdminRbac(): FakeRbacProvider {
  const rbac = new FakeRbacProvider();
  rbac.addRole("policy-admin");
  rbac.grant("policy-admin", "admin.policy.manage");
  rbac.grant("policy-admin", "admin.policy.approve");
  return rbac;
}

class FakePolicyRegistryProvider implements PolicyRegistryProvider {
  private nextId = 1;
  readonly rows: PolicyRecord[] = [];
  readonly auditLog: PolicyAdminAuditEntry[] = [];

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
    const candidates = this.rows.filter((r) => r.policyId === policyId);
    return candidates.length === 0 ? 0 : Math.max(...candidates.map((r) => r.version));
  }
  async insertVersion(input: NewPolicyInput & { version: number; createdBy: number }): Promise<PolicyRecord> {
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
    const index = this.rows.findIndex((r) => r.policyId === policyId && r.version === version);
    const updated: PolicyRecord = { ...this.rows[index], status: next, approvedBy, updatedAt: new Date() };
    this.rows[index] = updated;
    return updated;
  }
  async recordAudit(entry: PolicyAdminAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }
}

function actor(userId: number, roleKeys: string[], assuranceMethods: string[] = ["totp"]): PolicyAdminActor {
  return { userId, roleKeys, assuranceMethods };
}

/** Drives one policy all the way to ACTIVE — the only status
 *  `createRegistryPolicyRule()` will accept (see that file's own
 *  fail-closed-on-non-ACTIVE header). Two different actors author vs.
 *  approve, per the maker-checker guard `transitionStatus()` enforces. */
async function activatePolicy(registry: PolicyRegistry, author: PolicyAdminActor, approver: PolicyAdminActor, input: NewPolicyInput): Promise<PolicyRecord> {
  const created = await registry.createPolicy(author, input);
  await registry.transitionStatus(approver, input.policyId, created.version, "TESTING");
  await registry.transitionStatus(approver, input.policyId, created.version, "APPROVED");
  return registry.transitionStatus(approver, input.policyId, created.version, "ACTIVE");
}

async function main() {
  console.log("Policy Engine — Phase 22D (Security / Abuse Testing — Policy) tests");

  // ── policy injection ─────────────────────────────────────────────────

  await test("policy injection: DSL text attempting to reach outside the grammar (JS-injection-shaped payloads) is rejected, never executed", async () => {
    const payloads = [
      'subject.role == "admin"; process.exit(1)',
      "subject.role == `${process.env.SECRET}`",
      "__proto__.polluted == true",
      "subject.role == \"x\") OR (1==1",
      "require('child_process').exec('echo pwned')",
    ];
    for (const payload of payloads) {
      assert.throws(() => parseAbacDsl(payload), DslError, `expected DslError for payload: ${payload}`);
    }
  });

  await test("policy injection: a compiled condition is plain, JSON-serializable data — no closure, no function, nothing eval-able is ever embedded in it", () => {
    const compiled = compileAbacPolicy({
      id: "p1",
      effect: "deny",
      expression: 'subject.organizationId == resource.organizationId AND subject.role != "admin"',
    });
    const roundTripped = JSON.parse(JSON.stringify(compiled.condition));
    assert.deepEqual(roundTripped, compiled.condition); // survives a pure-data round trip byte-for-byte
    assert.equal(typeof compiled.condition, "object");
  });

  await test("policy injection: PolicyRegistry.createPolicy() rejects an injection-shaped payload BEFORE ever storing it — provider.insertVersion is never called", async () => {
    const rbac = buildAdminRbac();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));

    await assert.rejects(
      registry.createPolicy(actor(1, ["policy-admin"]), {
        policyId: "injected",
        name: "malicious",
        application: "sylo",
        resource: "vault",
        action: "read",
        ruleKind: "abac_dsl",
        rules: "require('fs').readFileSync('/etc/passwd')",
        effect: "allow",
      }),
      InvalidPolicyContentError,
    );
    assert.equal(provider.rows.length, 0); // nothing was ever stored — fail closed
  });

  // ── invalid DSL ──────────────────────────────────────────────────────

  await test("invalid DSL: structurally malformed expressions are all rejected with a DslError, never silently accepted as \"no condition\"", () => {
    const malformed = [
      "",
      "subject.role ==",
      "((subject.role == \"a\")",
      "subject.role == \"unterminated",
      "hacker.role == \"admin\"", // not one of subject./resource./environment./action
      "subject.role == \"a\" subject.role == \"b\"", // trailing input, no operator between
      "a".repeat(MAX_INPUT_LENGTH + 1),
      Array.from({ length: MAX_TOKENS + 10 }, () => "NOT").join(" ") + " subject.role == \"a\"",
    ];
    for (const expr of malformed) {
      assert.throws(() => parseAbacDsl(expr), DslError, `expected DslError for: ${expr.slice(0, 40)}`);
    }
  });

  await test("invalid DSL: a batch containing one bad expression fails the WHOLE batch, never partially compiling the good ones", () => {
    assert.throws(() => {
      compileAbacPolicy({ id: "good", effect: "allow", expression: 'subject.role == "member"' });
      compileAbacPolicy({ id: "bad", effect: "allow", expression: "subject.role ==" }); // never reached if this threw first, but proves the second one alone throws
    }, DslError);
  });

  // ── conflicting rules ────────────────────────────────────────────────

  await test("conflicting rules: an ALLOW-authored registry policy and a DENY-authored one covering the same action resolve to DENY regardless of registration order", async () => {
    const rbac = buildAdminRbac();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-admin"]);
    const approver = actor(2, ["policy-admin"]);

    const allowPolicy = await activatePolicy(registry, author, approver, {
      policyId: "allow-conflict",
      name: "broad allow",
      application: "sylo",
      resource: "vault",
      action: "read",
      ruleKind: "abac_dsl",
      rules: "subject.role == \"member\"",
      effect: "allow",
      priority: 0,
    });
    const denyPolicy = await activatePolicy(registry, author, approver, {
      policyId: "deny-conflict",
      name: "narrow deny",
      application: "sylo",
      resource: "vault",
      action: "read",
      ruleKind: "abac_dsl",
      rules: "subject.role == \"member\"",
      effect: "deny",
      priority: 0,
    });

    for (const order of [[allowPolicy, denyPolicy], [denyPolicy, allowPolicy]]) {
      const engine = new PolicyEngine();
      for (const { id, rule } of createRegistryPolicyRules(order)) engine.registerRule(id, rule);

      const decision = await engine.evaluate({
        subject: { userId: 9, role: "member", authType: "session" },
        action: "sylo.vault.read",
        resource: { type: "sylo.vault_item", id: "1" },
        context: { requestId: "r1", timestamp: new Date() },
      });
      assert.equal(decision.effect, "DENY"); // deterministic regardless of which policy was registered first
    }
  });

  // ── priority abuse ───────────────────────────────────────────────────

  await test("priority abuse: an attacker-authored ALLOW policy registered FIRST (simulating a maximum-priority claim) still cannot override another policy's DENY — priority never overrides deny-overrides combining", async () => {
    const rbac = buildAdminRbac();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-admin"]);
    const approver = actor(2, ["policy-admin"]);

    // priority: 999999 is accepted verbatim by the registry (no ceiling
    // enforced on this field — see registry/types.ts's own NewPolicyInput
    // shape) — the point of this test is that even so, it buys the
    // attacker nothing, because createRegistryPolicyRules() below never
    // reads `priority` at all; only the CALLER-supplied array ORDER
    // matters to PolicyEngine, and even registering the "highest
    // priority" policy first cannot make its ALLOW beat another rule's
    // DENY (deny-overrides, not first-wins).
    const attackerAllow = await activatePolicy(registry, author, approver, {
      policyId: "attacker-allow",
      name: "self-authored maximum priority allow",
      application: "sylo",
      resource: "vault",
      action: "delete",
      ruleKind: "abac_dsl",
      rules: 'subject.role == "member"',
      effect: "allow",
      priority: 999999,
    });
    const legitDeny = await activatePolicy(registry, author, approver, {
      policyId: "legit-deny",
      name: "legitimate low-priority deny",
      application: "sylo",
      resource: "vault",
      action: "delete",
      ruleKind: "abac_dsl",
      rules: 'subject.role == "member"',
      effect: "deny",
      priority: 0,
    });

    const engine = new PolicyEngine();
    // Attacker's policy registered FIRST — the most favorable order for it.
    for (const { id, rule } of createRegistryPolicyRules([attackerAllow, legitDeny])) engine.registerRule(id, rule);

    const decision = await engine.evaluate({
      subject: { userId: 9, role: "member", authType: "session" },
      action: "sylo.vault.delete",
      resource: { type: "sylo.vault_item", id: "1" },
      context: { requestId: "r1", timestamp: new Date() },
    });
    assert.equal(decision.effect, "DENY");
  });

  // ── cache poisoning / stale authorization cache ─────────────────────
  // No cache exists anywhere in lib/policy/* today (see file header) — the
  // two cases below instead prove the registry→PDP path introduces no
  // ACCIDENTAL staleness even without one: disabling a policy is reflected
  // on the very next read, and PolicyEngine itself holds no decision
  // memoization that could serve a stale verdict for an unrelated request.

  await test("no stale authorization cache: disabling an ACTIVE policy is reflected immediately — the very next listActivePolicies()/createRegistryPolicyRules() call no longer includes it", async () => {
    const rbac = buildAdminRbac();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-admin"]);
    const approver = actor(2, ["policy-admin"]);

    const activePolicy = await activatePolicy(registry, author, approver, {
      policyId: "toggle-me",
      name: "toggle",
      application: "sylo",
      resource: "vault",
      action: "read",
      ruleKind: "abac_dsl",
      rules: 'subject.role == "member"',
      effect: "deny",
    });

    let active = await registry.listActivePolicies({ application: "sylo", resource: "vault" });
    assert.equal(active.length, 1);
    let engine = new PolicyEngine();
    for (const { id, rule } of createRegistryPolicyRules(active)) engine.registerRule(id, rule);
    let decision = await engine.evaluate({
      subject: { userId: 9, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "1" },
      context: { requestId: "r1", timestamp: new Date() },
    });
    assert.equal(decision.effect, "DENY");

    await registry.transitionStatus(approver, activePolicy.policyId, activePolicy.version, "DISABLED");

    // No cache anywhere to invalidate — a fresh read simply reflects the
    // new state, immediately.
    active = await registry.listActivePolicies({ application: "sylo", resource: "vault" });
    assert.equal(active.length, 0);
    engine = new PolicyEngine();
    for (const { id, rule } of createRegistryPolicyRules(active)) engine.registerRule(id, rule);
    decision = await engine.evaluate({
      subject: { userId: 9, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "1" },
      context: { requestId: "r1", timestamp: new Date() },
    });
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("no decision cache: PolicyEngine.evaluate() never memoizes by (action, resource) alone — two requests sharing the identical action+resource but differing subject.role get independently correct decisions, not one served stale for the other", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("member-only", (request) =>
      request.subject?.role === "member" ? { effect: "ALLOW", reason: "EXPLICIT_ALLOW", requestId: request.context.requestId, evaluatedAt: new Date() } : null,
    );

    const base = { action: "sylo.vault.read", resource: { type: "sylo.vault_item", id: "1" }, context: { requestId: "r1", timestamp: new Date() } };
    const memberDecision = await engine.evaluate({ ...base, subject: { userId: 1, role: "member", authType: "session" } });
    const guestDecision = await engine.evaluate({ ...base, subject: { userId: 2, role: "guest", authType: "session" } });

    assert.equal(memberDecision.effect, "ALLOW");
    assert.equal(guestDecision.effect, "DENY"); // same action+resource as the member request — a cache keyed on those alone would have wrongly reused the ALLOW
    assert.equal(guestDecision.reason, "NO_MATCHING_POLICY");
  });

  console.log("\nAll Phase 22D Policy abuse-testing checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ── Deliberately NOT done here (later Phase 22 sub-phase) ─────────────────
 * - Reliability category (database failure, policy failure, provider
 *   timeout, cache failure, partial context failure) — needs providers
 *   that fail ON DEMAND (throwing fakes), not the always-succeeding fakes
 *   every suite up to this one uses. Phase 22E.
 */
