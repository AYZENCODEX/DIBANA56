/**
 * scripts/src/test-policy-versioning.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 16 (Policy Versioning) tests.
 *
 * Run: npx tsx scripts/src/test-policy-versioning.ts
 *
 * Covers:
 *   - allow()/deny() thread an optional policyVersion onto the decision;
 *     absent when not supplied (byte-for-byte same shape as before Phase 16)
 *   - PolicyRegistry.createNewVersion()/createPolicy() throw
 *     PolicyVersionConflictError on a simulated TOCTOU race (stale
 *     getLatestVersionNumber()) instead of silently double-inserting
 *   - normal, non-racing create/version-bump flows are completely
 *     unaffected by the new guard (regression coverage)
 *   - createRegistryPolicyRule(): throws for a non-ACTIVE record; abstains
 *     for a non-matching action; abstains when the condition doesn't
 *     match; stamps policyId+policyVersion on both ALLOW and DENY outcomes
 *   - createRegistryPolicyRules(): silently skips non-ACTIVE rows
 *   - end-to-end: a registry-backed rule registered on a real PolicyEngine
 *     produces a decision whose policyId/policyVersion match the record
 *   - getDecisionPolicySnapshot(): null with no policyId/policyVersion on
 *     the decision; null for an unknown pair; and — the core reproducibility
 *     guarantee — still resolves the ORIGINAL version even after a newer
 *     version of the same policyId has since become ACTIVE
 *   - createLoggingObserver() (Phase 1C) now includes policyVersion in its
 *     log fields
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  allow,
  deny,
  createLoggingObserver,
  createRegistryPolicyRule,
  createRegistryPolicyRules,
  getDecisionPolicySnapshot,
  PolicyVersionConflictError,
  PolicyNotFoundError,
  type AuthorizationRequest,
  type BuildAuthorizationRequestInput,
  type NewPolicyInput,
  type PolicyAdminActor,
  type PolicyRecord,
  type PolicyRegistryProvider,
  type PolicyStatus,
} from "../../artifacts/api-server/src/lib/policy";
import { PolicyRegistry } from "../../artifacts/api-server/src/lib/policy/registry/policy-registry";
import type { PolicyAdminAuditEntry, PolicyAdminAuthorizer } from "../../artifacts/api-server/src/lib/policy/registry/types";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

// ── In-memory registry provider + always-allow authorizer, same shape as
//    scripts/src/test-policy-registry.ts's own fakes ─────────────────────

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
    if (index === -1) throw new PolicyNotFoundError(policyId, version);
    const updated: PolicyRecord = {
      ...this.rows[index],
      status: next,
      approvedBy,
      updatedAt: new Date(),
      approvedAt: next === "APPROVED" ? new Date() : this.rows[index].approvedAt,
    };
    this.rows[index] = updated;
    return updated;
  }

  async recordAudit(entry: PolicyAdminAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }
}

/** Decorator that pins `getLatestVersionNumber()` to a fixed, stale value —
 *  used to deterministically simulate the TOCTOU race
 *  `assertVersionSlotFree()` guards against, without any real concurrency. */
class StaleLatestVersionProvider implements PolicyRegistryProvider {
  constructor(
    private readonly inner: PolicyRegistryProvider,
    private readonly staleLatest: number,
  ) {}
  getPolicy = (policyId: string, version?: number) => this.inner.getPolicy(policyId, version);
  getActivePolicy = (policyId: string) => this.inner.getActivePolicy(policyId);
  listActivePolicies = (filter?: { application?: string; resource?: string }) => this.inner.listActivePolicies(filter);
  listVersions = (policyId: string) => this.inner.listVersions(policyId);
  async getLatestVersionNumber(_policyId: string): Promise<number> {
    return this.staleLatest;
  }
  insertVersion = (input: NewPolicyInput & { version: number; createdBy: number }) => this.inner.insertVersion(input);
  updateStatus = (policyId: string, version: number, next: PolicyStatus, approvedBy: number | null) =>
    this.inner.updateStatus(policyId, version, next, approvedBy);
  recordAudit = (entry: PolicyAdminAuditEntry) => this.inner.recordAudit(entry);
}

class AllowAllAuthorizer implements PolicyAdminAuthorizer {
  async assertCanManagePolicies(_actor: PolicyAdminActor): Promise<void> {}
  async assertCanApprovePolicies(_actor: PolicyAdminActor): Promise<void> {}
}

function actor(userId: number): PolicyAdminActor {
  return { userId, roleKeys: ["admin"], assuranceMethods: ["passkey"] };
}

const VALID_DSL = 'subject.organizationId == resource.organizationId AND subject.verificationLevel == "email_verified"';

function baseNewPolicyInput(policyId: string, overrides: Partial<NewPolicyInput> = {}): NewPolicyInput {
  return {
    policyId,
    name: "Cross-org deny for Sylo vault",
    description: "test policy",
    application: "sylo",
    resource: "vault",
    action: "read",
    ruleKind: "abac_dsl",
    rules: VALID_DSL,
    effect: "deny",
    priority: 10,
    ...overrides,
  };
}

async function run() {
  console.log("Phase 16 — Policy Versioning tests\n");

  // ── allow()/deny() policyVersion passthrough ────────────────────────

  await test("allow() leaves policyVersion undefined when not supplied", () => {
    const req: AuthorizationRequest = { subject: null, action: "x", resource: { type: "t" }, context: { requestId: "v1", timestamp: new Date() } };
    const decision = allow(req, "EXPLICIT_ALLOW");
    assert.equal(decision.policyVersion, undefined);
  });

  await test("allow()/deny() stamp policyVersion verbatim when supplied", () => {
    const req: AuthorizationRequest = { subject: null, action: "x", resource: { type: "t" }, context: { requestId: "v2", timestamp: new Date() } };
    const allowed = allow(req, "EXPLICIT_ALLOW", { policyId: "p1", policyVersion: 3 });
    const denied = deny(req, "EXPLICIT_DENY", { policyId: "p1", policyVersion: 3 });
    assert.equal(allowed.policyVersion, 3);
    assert.equal(denied.policyVersion, 3);
  });

  // ── PolicyRegistry immutability guard ────────────────────────────────

  await test("createPolicy(): normal (non-racing) create is unaffected by the new guard", async () => {
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new AllowAllAuthorizer());
    const created = await registry.createPolicy(actor(1), baseNewPolicyInput("p-normal"));
    assert.equal(created.version, 1);
  });

  await test("createNewVersion(): normal (non-racing) version bump is unaffected by the new guard", async () => {
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new AllowAllAuthorizer());
    await registry.createPolicy(actor(1), baseNewPolicyInput("p-bump"));
    const v2 = await registry.createNewVersion(actor(1), "p-bump", baseNewPolicyInput("p-bump"));
    assert.equal(v2.version, 2);
  });

  await test("createNewVersion(): throws PolicyVersionConflictError on a simulated TOCTOU race", async () => {
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new AllowAllAuthorizer());
    await registry.createPolicy(actor(1), baseNewPolicyInput("p-race"));
    // Simulate a concurrent writer that already inserted version 2 for this
    // policyId, behind this registry's back.
    await provider.insertVersion({ ...baseNewPolicyInput("p-race"), version: 2, createdBy: 1 });

    // This registry instance still believes latest=1 (a stale read from
    // BEFORE the concurrent insert above), so it will also try to insert
    // version 2 — assertVersionSlotFree() must catch this.
    const racyRegistry = new PolicyRegistry(new StaleLatestVersionProvider(provider, 1), new AllowAllAuthorizer());
    await assert.rejects(
      () => racyRegistry.createNewVersion(actor(1), "p-race", baseNewPolicyInput("p-race")),
      PolicyVersionConflictError,
    );
    // And the slot was NOT double-inserted — still exactly one row at v2.
    const versions = await provider.listVersions("p-race");
    assert.equal(versions.filter((v) => v.version === 2).length, 1);
  });

  await test("createPolicy(): throws PolicyVersionConflictError if version 1 is already occupied behind its back", async () => {
    const provider = new FakePolicyRegistryProvider();
    // Pre-seed version 1 directly (bypassing PolicyRegistry entirely) to
    // simulate a slot that's already occupied despite getLatestVersionNumber
    // (below) claiming otherwise.
    await provider.insertVersion({ ...baseNewPolicyInput("p-seeded"), version: 1, createdBy: 1 });
    const racyProvider = new StaleLatestVersionProvider(provider, 0); // stale: claims no version exists yet
    const registry = new PolicyRegistry(racyProvider, new AllowAllAuthorizer());
    await assert.rejects(
      () => registry.createPolicy(actor(1), baseNewPolicyInput("p-seeded")),
      PolicyVersionConflictError,
    );
  });

  // ── createRegistryPolicyRule() ────────────────────────────────────────

  function activeRecord(overrides: Partial<PolicyRecord> = {}): PolicyRecord {
    const now = new Date();
    return {
      id: 1,
      policyId: "sylo-vault-cross-org-deny",
      version: 1,
      name: "Cross-org deny",
      description: null,
      application: "sylo",
      resource: "vault",
      action: "read",
      ruleKind: "abac_dsl",
      rules: VALID_DSL,
      effect: "deny",
      priority: 10,
      status: "ACTIVE",
      createdBy: 1,
      approvedBy: 2,
      createdAt: now,
      updatedAt: now,
      approvedAt: now,
      ...overrides,
    };
  }

  function requestInput(overrides: Partial<BuildAuthorizationRequestInput> = {}): BuildAuthorizationRequestInput {
    return {
      subject: { userId: 5, role: "user", authType: "session", organizationId: 1, verificationLevel: "email_verified" },
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: 1, organizationId: 1 },
      ...overrides,
    };
  }

  await test("createRegistryPolicyRule(): throws for a non-ACTIVE record", () => {
    assert.throws(() => createRegistryPolicyRule(activeRecord({ status: "DRAFT" })));
  });

  await test("createRegistryPolicyRule(): abstains for a non-matching action", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("registry", createRegistryPolicyRule(activeRecord()));
    const decision = await engine.evaluate(requestInput({ action: "sylo.vault.write" }));
    // No rule had an opinion -> default deny, and NOT because our rule
    // matched (its own policyId must not appear).
    assert.equal(decision.effect, "DENY");
    assert.notEqual(decision.policyId, "sylo-vault-cross-org-deny");
  });

  await test("createRegistryPolicyRule(): abstains when the condition doesn't match, letting default-deny apply", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("registry", createRegistryPolicyRule(activeRecord()));
    // Different organizationId -> condition (subject.org == resource.org) is FALSE -> abstain.
    const decision = await engine.evaluate(
      requestInput({ resource: { type: "sylo.vault_item", id: 1, organizationId: 999 } }),
    );
    assert.notEqual(decision.policyId, "sylo-vault-cross-org-deny");
  });

  await test("createRegistryPolicyRule(): DENY outcome stamps policyId + policyVersion", async () => {
    const engine = new PolicyEngine();
    const record = activeRecord({ version: 4 });
    engine.registerRule("registry", createRegistryPolicyRule(record));
    // Same organizationId (matches subject's) -> condition TRUE -> deny.
    const decision = await engine.evaluate(
      requestInput({ resource: { type: "sylo.vault_item", id: 1, organizationId: 1 } }),
    );
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.policyId, "sylo-vault-cross-org-deny");
    assert.equal(decision.policyVersion, 4);
  });

  await test("createRegistryPolicyRule(): ALLOW outcome also stamps policyId + policyVersion", async () => {
    const engine = new PolicyEngine();
    const record = activeRecord({ effect: "allow", version: 7 });
    engine.registerRule("registry", createRegistryPolicyRule(record));
    const decision = await engine.evaluate(
      requestInput({ resource: { type: "sylo.vault_item", id: 1, organizationId: 1 } }),
    );
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, "sylo-vault-cross-org-deny");
    assert.equal(decision.policyVersion, 7);
  });

  await test("createRegistryPolicyRules(): silently skips non-ACTIVE rows", () => {
    const rules = createRegistryPolicyRules([activeRecord({ policyId: "a" }), activeRecord({ policyId: "b", status: "DISABLED" })]);
    assert.equal(rules.length, 1);
  });

  // ── getDecisionPolicySnapshot() — reproducibility ────────────────────

  await test("getDecisionPolicySnapshot(): null when the decision has no policyId/policyVersion", async () => {
    const provider = new FakePolicyRegistryProvider();
    const snapshot = await getDecisionPolicySnapshot({ policyId: undefined, policyVersion: undefined }, provider);
    assert.equal(snapshot, null);
  });

  await test("getDecisionPolicySnapshot(): null for an unknown (policyId, version) pair", async () => {
    const provider = new FakePolicyRegistryProvider();
    const snapshot = await getDecisionPolicySnapshot({ policyId: "nope", policyVersion: 1 }, provider);
    assert.equal(snapshot, null);
  });

  await test("getDecisionPolicySnapshot(): resolves the ORIGINAL version even after a newer version has since become ACTIVE", async () => {
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new AllowAllAuthorizer());

    // v1 goes all the way to ACTIVE.
    const v1 = await registry.createPolicy(actor(1), baseNewPolicyInput("p-repro"));
    await registry.transitionStatus(actor(1), "p-repro", 1, "TESTING");
    await registry.transitionStatus(actor(2), "p-repro", 1, "APPROVED");
    await registry.transitionStatus(actor(1), "p-repro", 1, "ACTIVE");

    // A decision is made against v1 (stamped by createRegistryPolicyRule()).
    // NOTE: organizationId: 1 here (matching subject.organizationId: 1),
    // not 999 — the condition (subject.org == resource.org) must be TRUE
    // for this record's rule to fire at all (see the "DENY outcome stamps
    // policyId + policyVersion" test above); org 999 would abstain, same
    // as the "abstains when the condition doesn't match" test, and never
    // stamp policyVersion.
    const engine = new PolicyEngine();
    engine.registerRule("registry", createRegistryPolicyRule({ ...v1, status: "ACTIVE" }));
    const decisionAgainstV1 = await engine.evaluate(
      requestInput({ resource: { type: "sylo.vault_item", id: 1, organizationId: 1 } }),
    );
    assert.equal(decisionAgainstV1.policyVersion, 1);

    // Now v2 is authored and promoted to ACTIVE, superseding v1 (which the
    // registry auto-disables per transitionStatus()'s own "at most one
    // ACTIVE version" rule).
    await registry.createNewVersion(actor(1), "p-repro", baseNewPolicyInput("p-repro", { priority: 20 }));
    await registry.transitionStatus(actor(1), "p-repro", 2, "TESTING");
    await registry.transitionStatus(actor(2), "p-repro", 2, "APPROVED");
    await registry.transitionStatus(actor(1), "p-repro", 2, "ACTIVE");

    const currentlyActive = await registry.getActivePolicy("p-repro");
    assert.equal(currentlyActive!.version, 2); // confirms v1 really was superseded

    // The OLD decision must still resolve back to v1's exact snapshot, not
    // whatever is active now.
    const snapshot = await getDecisionPolicySnapshot(decisionAgainstV1, provider);
    assert.ok(snapshot);
    assert.equal(snapshot!.version, 1);
    assert.equal(snapshot!.priority, 10); // v1's own priority, not v2's (20)
  });

  // ── decision-observer.ts (Phase 1C) — policyVersion now included ─────

  await test("createLoggingObserver(): includes policyVersion in the logged fields", () => {
    const logged: Record<string, unknown>[] = [];
    const fakeLogger = {
      info: (fields: Record<string, unknown>) => logged.push(fields),
      warn: (fields: Record<string, unknown>) => logged.push(fields),
    };
    const observer = createLoggingObserver(fakeLogger);
    const req: AuthorizationRequest = { subject: null, action: "x", resource: { type: "t" }, context: { requestId: "v3", timestamp: new Date() } };
    const decision = deny(req, "EXPLICIT_DENY", { policyId: "p1", policyVersion: 9 });
    observer(decision, req);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.policyVersion, 9);
  });

  console.log("\nAll Phase 16 (Policy Versioning) tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
