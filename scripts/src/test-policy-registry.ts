/**
 * scripts/src/test-policy-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-policy-registry.ts
 *
 * Uses an in-memory `FakePolicyRegistryProvider` (implements the same
 * `PolicyRegistryProvider` interface `DrizzlePolicyRegistryProvider` does)
 * and the real, RBAC-backed `RbacPolicyAdminAuthorizer` wired to
 * `test-policy-rbac.ts`'s same `FakeRbacProvider` shape, so this suite
 * exercises the exact same code path (lifecycle.ts, authorizer.ts,
 * policy-registry.ts) a real Postgres-backed run would.
 *
 * Covers:
 *   - create policy (valid DSL) / reject invalid DSL content
 *   - create policy without admin.policy.manage permission → denied
 *   - duplicate policyId → PolicyAlreadyExistsError
 *   - createNewVersion: unknown policyId → PolicyNotFoundError; version
 *     numbering; always starts DRAFT
 *   - full legal lifecycle walk: DRAFT→TESTING→APPROVED→ACTIVE→DISABLED→ACTIVE→ARCHIVED
 *   - illegal transitions rejected (skip a step; leave ARCHIVED)
 *   - approval requires admin.policy.approve, distinct from manage
 *   - no-self-approval (maker-checker)
 *   - activation requires strong assurance
 *   - activating a new version auto-disables a previously ACTIVE version
 *     of the same policyId
 *   - every mutation writes exactly one audit row, with the right
 *     before/after shape
 *   - listActivePolicies filtering by application/resource
 *
 * Run: npx tsx scripts/src/test-policy-registry.ts
 */

import assert from "node:assert/strict";
import {
  PolicyRegistry,
  RbacPolicyAdminAuthorizer,
  PolicyLifecycleError,
  PolicyAuthorizationError,
  PolicyAlreadyExistsError,
  PolicyNotFoundError,
  SelfApprovalNotAllowedError,
  InsufficientAssuranceError,
  InvalidPolicyContentError,
  // Phase 23A (Admin Policy Console — Policies section).
  buildPolicyAdminActor,
  type Subject,
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

// ── FakeRbacProvider — same shape as test-policy-rbac.ts's own ───────────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  // Phase 23A — `buildPolicyAdminActor()`'s own real-world half:
  // `RbacProvider.getUserRoleKeys(userId)`. Every OTHER test in this file
  // constructs a `PolicyAdminActor` directly (via `actor()` below) and
  // never calls this, hence the pre-Phase-23A "unused" comment this map
  // replaces — the buildPolicyAdminActor tests below are the first ones
  // that actually need a per-user grant a Drizzle-backed provider would
  // otherwise supply from `user_roles`.
  private readonly userRoleKeys = new Map<number, string[]>();

  addRole(key: string, parentRoleKey: string | null = null): void {
    this.roles.set(key, { key, parentRoleKey });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }

  grant(roleKey: string, permissionKey: string): void {
    if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }

  /** Phase 23A test fixture only — the real `DrizzleRbacProvider` reads
   *  this from `user_roles`. */
  setUserRoleKeys(userId: number, roleKeys: string[]): void {
    this.userRoleKeys.set(userId, roleKeys);
  }

  async getUserRoleKeys(userId: number): Promise<string[]> {
    return [...(this.userRoleKeys.get(userId) ?? [])];
  }

  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }

  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.roles.get(roleKey) ?? null;
  }
}

function buildRbacFixture(): FakeRbacProvider {
  const rbac = new FakeRbacProvider();
  rbac.addRole("policy-author", null);
  rbac.addRole("policy-approver", null);
  rbac.grant("policy-author", "admin.policy.manage");
  rbac.grant("policy-approver", "admin.policy.approve");
  rbac.grant("policy-approver", "admin.policy.manage");
  return rbac;
}

// ── FakePolicyRegistryProvider — in-memory stand-in for
//    DrizzlePolicyRegistryProvider ──────────────────────────────────────

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

  /** Mirrors `DrizzlePolicyRegistryProvider.listAllPolicies()`'s own
   *  "highest version per policyId, filter after" semantics exactly (see
   *  that method's doc comment) — build the latest-per-policyId map first,
   *  THEN filter, THEN sort by policyId. */
  async listAllPolicies(filter?: { application?: string; resource?: string; status?: PolicyStatus }): Promise<PolicyRecord[]> {
    const latestByPolicyId = new Map<string, PolicyRecord>();
    for (const row of this.rows) {
      const current = latestByPolicyId.get(row.policyId);
      if (!current || row.version > current.version) latestByPolicyId.set(row.policyId, row);
    }
    return [...latestByPolicyId.values()]
      .filter(
        (r) =>
          (filter?.application === undefined || r.application === filter.application) &&
          (filter?.resource === undefined || r.resource === filter.resource) &&
          (filter?.status === undefined || r.status === filter.status),
      )
      .sort((a, b) => a.policyId.localeCompare(b.policyId));
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
    // Replace with a FRESH object, never mutate the existing row in place —
    // mirrors what a real UPDATE ... RETURNING against Postgres actually
    // hands back (a new row object), which is exactly the assumption
    // PolicyRegistry.applyStatusChange() relies on for `updateStatus()`'s
    // return value to be safely comparable to the object it captured
    // BEFORE calling this method (see PolicyRegistryProvider's own
    // contract note in registry/types.ts).
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

function actor(userId: number, roleKeys: string[], assuranceMethods: string[] = []): PolicyAdminActor {
  return { userId, roleKeys, assuranceMethods };
}

const VALID_DSL = 'subject.organizationId == resource.organizationId AND subject.verificationLevel == "email_verified"';

function baseInput(policyId: string): NewPolicyInput {
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
  };
}

async function main() {
  console.log("Phase 07 — Policy Registry (PAP) tests\n");

  await test("create policy succeeds with valid DSL, status DRAFT, version 1", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    const created = await registry.createPolicy(author, baseInput("p1"));
    assert.equal(created.status, "DRAFT");
    assert.equal(created.version, 1);
    assert.equal(created.createdBy, 1);
    assert.equal(provider.auditLog.length, 1);
    assert.equal(provider.auditLog[0].action, "policy_created");
    assert.equal(provider.auditLog[0].before, null);
  });

  await test("create policy rejects invalid DSL content — nothing stored, no audit row", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    await assert.rejects(
      () => registry.createPolicy(author, { ...baseInput("p2"), rules: "subject.role ==" }),
      InvalidPolicyContentError,
    );
    assert.equal(provider.rows.length, 0);
    assert.equal(provider.auditLog.length, 0);
  });

  await test("create policy without admin.policy.manage is denied", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    rbac.addRole("plain-user", null);
    const plain = actor(3, ["plain-user"]);

    await assert.rejects(() => registry.createPolicy(plain, baseInput("p3")), PolicyAuthorizationError);
    assert.equal(provider.rows.length, 0);
  });

  await test("duplicate policyId rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    await registry.createPolicy(author, baseInput("p4"));
    await assert.rejects(() => registry.createPolicy(author, baseInput("p4")), PolicyAlreadyExistsError);
  });

  await test("createNewVersion: unknown policyId rejected; known policyId increments version, resets to DRAFT", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    await assert.rejects(() => registry.createNewVersion(author, "does-not-exist", baseInput("x")), PolicyNotFoundError);

    await registry.createPolicy(author, baseInput("p5"));
    const v2 = await registry.createNewVersion(author, "p5", { ...baseInput("p5"), priority: 20 });
    assert.equal(v2.version, 2);
    assert.equal(v2.status, "DRAFT");
    assert.equal(v2.priority, 20);
    const versions = await registry.listVersions("p5");
    assert.equal(versions.length, 2);
  });

  await test("full legal lifecycle walk succeeds end to end", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);
    const approver = actor(2, ["policy-approver"]);

    const approverWithAssurance = actor(2, ["policy-approver"], ["totp"]);

    await registry.createPolicy(author, baseInput("p6"));
    await registry.transitionStatus(author, "p6", 1, "TESTING");
    await registry.transitionStatus(approver, "p6", 1, "APPROVED");
    const active = await registry.transitionStatus(approverWithAssurance, "p6", 1, "ACTIVE");
    assert.equal(active.status, "ACTIVE");

    await registry.transitionStatus(approverWithAssurance, "p6", 1, "DISABLED");
    await registry.transitionStatus(approverWithAssurance, "p6", 1, "ACTIVE");
    const archived = await registry.transitionStatus(approverWithAssurance, "p6", 1, "ARCHIVED");
    assert.equal(archived.status, "ARCHIVED");
  });

  await test("illegal transitions rejected: skipping a step, and leaving ARCHIVED", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    await registry.createPolicy(author, baseInput("p7"));
    await assert.rejects(() => registry.transitionStatus(author, "p7", 1, "ACTIVE"), PolicyLifecycleError);
    await assert.rejects(() => registry.transitionStatus(author, "p7", 1, "APPROVED"), PolicyLifecycleError);

    await registry.transitionStatus(author, "p7", 1, "ARCHIVED");
    await assert.rejects(() => registry.transitionStatus(author, "p7", 1, "DRAFT"), PolicyLifecycleError);
    await assert.rejects(() => registry.transitionStatus(author, "p7", 1, "TESTING"), PolicyLifecycleError);
  });

  await test("approval requires admin.policy.approve, distinct from admin.policy.manage", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]); // manage only, no approve

    await registry.createPolicy(author, baseInput("p8"));
    await registry.transitionStatus(author, "p8", 1, "TESTING");
    // author has manage but not approve — must be denied for the APPROVED step
    await assert.rejects(() => registry.transitionStatus(author, "p8", 1, "APPROVED"), PolicyAuthorizationError);
  });

  await test("no-self-approval (maker-checker): author cannot approve their own version even with approve grant", async () => {
    const rbac = buildRbacFixture();
    rbac.grant("policy-author", "admin.policy.approve"); // give author BOTH grants for this test
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    await registry.createPolicy(author, baseInput("p9"));
    await registry.transitionStatus(author, "p9", 1, "TESTING");
    await assert.rejects(() => registry.transitionStatus(author, "p9", 1, "APPROVED"), SelfApprovalNotAllowedError);
  });

  await test("activation requires strong assurance", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);
    const approver = actor(2, ["policy-approver"]); // no assuranceMethods

    await registry.createPolicy(author, baseInput("p10"));
    await registry.transitionStatus(author, "p10", 1, "TESTING");
    await registry.transitionStatus(approver, "p10", 1, "APPROVED");
    await assert.rejects(() => registry.transitionStatus(approver, "p10", 1, "ACTIVE"), InsufficientAssuranceError);

    const approverWithAssurance = actor(2, ["policy-approver"], ["totp"]);
    const active = await registry.transitionStatus(approverWithAssurance, "p10", 1, "ACTIVE");
    assert.equal(active.status, "ACTIVE");
  });

  await test("activating a new version auto-disables the previously ACTIVE version", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);
    const approver = actor(2, ["policy-approver"], ["totp"]);

    await registry.createPolicy(author, baseInput("p11"));
    await registry.transitionStatus(author, "p11", 1, "TESTING");
    await registry.transitionStatus(approver, "p11", 1, "APPROVED");
    const v1Active = await registry.transitionStatus(approver, "p11", 1, "ACTIVE");
    assert.equal(v1Active.status, "ACTIVE");

    const v2 = await registry.createNewVersion(author, "p11", baseInput("p11"));
    await registry.transitionStatus(author, "p11", 2, "TESTING");
    await registry.transitionStatus(approver, "p11", 2, "APPROVED");
    const v2Active = await registry.transitionStatus(approver, "p11", 2, "ACTIVE");
    assert.equal(v2Active.status, "ACTIVE");

    const v1AfterSuperseded = await registry.getPolicy("p11", 1);
    assert.equal(v1AfterSuperseded?.status, "DISABLED");
    assert.equal(v2.version, 2);

    const onlyActive = await registry.getActivePolicy("p11");
    assert.equal(onlyActive?.version, 2);
  });

  await test("every mutation writes exactly one audit row with correct action + before/after", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    await registry.createPolicy(author, baseInput("p12"));
    await registry.transitionStatus(author, "p12", 1, "TESTING");

    assert.equal(provider.auditLog.length, 2);
    assert.equal(provider.auditLog[0].action, "policy_created");
    assert.equal(provider.auditLog[1].action, "policy_status_changed");
    assert.equal((provider.auditLog[1].before as any).status, "DRAFT");
    assert.equal((provider.auditLog[1].after as any).status, "TESTING");
    // rule source text itself must not be duplicated into the audit row
    assert.equal((provider.auditLog[0].after as any).rules, undefined);
  });

  await test("listActivePolicies filters by application/resource", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);
    const approver = actor(2, ["policy-approver"], ["totp"]);

    async function activate(policyId: string, application: string, resource: string) {
      await registry.createPolicy(author, { ...baseInput(policyId), application, resource });
      await registry.transitionStatus(author, policyId, 1, "TESTING");
      await registry.transitionStatus(approver, policyId, 1, "APPROVED");
      await registry.transitionStatus(approver, policyId, 1, "ACTIVE");
    }

    await activate("p13", "sylo", "vault");
    await activate("p14", "ryft", "payment");

    const syloOnly = await registry.listActivePolicies({ application: "sylo" });
    assert.equal(syloOnly.length, 1);
    assert.equal(syloOnly[0].policyId, "p13");

    const paymentOnly = await registry.listActivePolicies({ resource: "payment" });
    assert.equal(paymentOnly.length, 1);
    assert.equal(paymentOnly[0].policyId, "p14");

    const all = await registry.listActivePolicies();
    assert.equal(all.length, 2);
  });

  console.log("\nAll Phase 07 policy-registry tests passed.");

  // ── Phase 23A — Admin Policy Console (Policies section) ────────────────
  console.log("\nPhase 23A — Admin Policy Console (Policies section) tests\n");

  await test("listAllPolicies: one row per policyId, latest version, any status", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    // p20 gets two versions — listAllPolicies must surface only v2 (DRAFT),
    // never v1, even though v1 is still on file.
    await registry.createPolicy(author, baseInput("p20"));
    await registry.createNewVersion(author, "p20", baseInput("p20"));

    // p21 stays at v1, never advanced past DRAFT — listAllPolicies must
    // still surface it (unlike listActivePolicies, which would not).
    await registry.createPolicy(author, { ...baseInput("p21"), application: "ryft", resource: "payment" });

    const all = await registry.listAllPolicies();
    assert.equal(all.length, 2);
    const p20 = all.find((r) => r.policyId === "p20");
    const p21 = all.find((r) => r.policyId === "p21");
    assert.ok(p20 && p21);
    assert.equal(p20!.version, 2);
    assert.equal(p21!.version, 1);
    assert.equal(p21!.status, "DRAFT");
  });

  await test("listAllPolicies: filters the LATEST row, not every candidate version", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);
    const approver = actor(2, ["policy-approver"], ["totp"]);

    // v1 is application "sylo"; v2 (the new latest) switches to "ryft".
    // A `{application: "sylo"}` filter must NOT match this policyId
    // anymore, because the LATEST version no longer has that application
    // — same "latest wins, then filter" semantics getPolicy(policyId)
    // (no version arg) already has for a single policyId.
    await registry.createPolicy(author, { ...baseInput("p22"), application: "sylo" });
    await registry.createNewVersion(author, "p22", { ...baseInput("p22"), application: "ryft" });

    const syloFiltered = await registry.listAllPolicies({ application: "sylo" });
    assert.equal(syloFiltered.length, 0);

    const ryftFiltered = await registry.listAllPolicies({ application: "ryft" });
    assert.equal(ryftFiltered.length, 1);
    assert.equal(ryftFiltered[0].version, 2);

    // status filter, same "latest row only" semantics.
    await registry.transitionStatus(author, "p22", 2, "TESTING");
    await registry.transitionStatus(approver, "p22", 2, "APPROVED");
    const activeFiltered = await registry.listAllPolicies({ status: "APPROVED" });
    assert.equal(activeFiltered.length, 1);
    assert.equal(activeFiltered[0].policyId, "p22");
    assert.equal(await registry.listAllPolicies({ status: "DRAFT" }).then((r) => r.length), 0);
  });

  await test("listAllPolicies: sorted by policyId, and empty when nothing on file", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));
    const author = actor(1, ["policy-author"]);

    assert.deepEqual(await registry.listAllPolicies(), []);

    await registry.createPolicy(author, baseInput("p_zzz"));
    await registry.createPolicy(author, baseInput("p_aaa"));
    const all = await registry.listAllPolicies();
    assert.deepEqual(
      all.map((r) => r.policyId),
      ["p_aaa", "p_zzz"],
    );
  });

  await test("buildPolicyAdminActor: unions legacy role + real RBAC user-role grants", async () => {
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(42, ["policy-approver"]);

    const subject: Subject = {
      userId: 42,
      role: "admin", // legacyRoleToRoleKeys("admin") => ["admin"]
      authType: "session",
      assuranceMethods: ["totp"],
    };

    const built = await buildPolicyAdminActor(subject, rbac);
    assert.equal(built.userId, 42);
    assert.deepEqual([...built.roleKeys].sort(), ["admin", "policy-approver"]);
    assert.deepEqual(built.assuranceMethods, ["totp"]);
  });

  await test("buildPolicyAdminActor: unrecognized legacy role contributes nothing extra", async () => {
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(7, ["policy-author"]);

    const subject: Subject = { userId: 7, role: "some-future-string", authType: "session" };
    const built = await buildPolicyAdminActor(subject, rbac);
    assert.deepEqual(built.roleKeys, ["policy-author"]);
  });

  await test("buildPolicyAdminActor: assuranceMethods is an honest passthrough (undefined stays undefined)", async () => {
    const rbac = buildRbacFixture();
    const subject: Subject = { userId: 9, role: "user", authType: "session" }; // no assuranceMethods
    const built = await buildPolicyAdminActor(subject, rbac);
    assert.equal(built.assuranceMethods, undefined);
  });

  await test("buildPolicyAdminActor: an actor it builds is USABLE end-to-end against PolicyRegistry", async () => {
    // Not just a shape check — proves the projection actually carries
    // enough real permission to pass PolicyRegistry's own authorization,
    // exactly as lib/policy-admin-console.ts relies on it doing.
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(99, ["policy-author"]);
    const provider = new FakePolicyRegistryProvider();
    const registry = new PolicyRegistry(provider, new RbacPolicyAdminAuthorizer(rbac));

    const subject: Subject = { userId: 99, role: "user", authType: "session" };
    const builtActor = await buildPolicyAdminActor(subject, rbac);

    const created = await registry.createPolicy(builtActor, baseInput("p23"));
    assert.equal(created.createdBy, 99);
  });

  console.log("\nAll Phase 23A policy-registry tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
