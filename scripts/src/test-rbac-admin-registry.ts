/**
 * scripts/src/test-rbac-admin-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections) tests.
 *
 * Same shape as `scripts/src/test-policy-registry.ts`: DB-free, runnable
 * anywhere with nothing but
 *   npx tsx scripts/src/test-rbac-admin-registry.ts
 *
 * Uses an in-memory `FakeRbacAdminProvider` (implements the same
 * `RbacAdminProvider` interface `DrizzleRbacAdminProvider` does) and the
 * real, RBAC-backed `RbacRbacAdminAuthorizer` wired to the same
 * `FakeRbacProvider` shape `test-policy-rbac.ts`/`test-policy-registry.ts`
 * already use, so this suite exercises the exact same code path
 * (rbac-admin-registry.ts, authorizer.ts) a real Postgres-backed run would.
 *
 * Covers:
 *   - createRole: success, duplicate key rejected, unknown parentRoleKey
 *     rejected, denied without admin.role.manage
 *   - updateRole: unknown role rejected, system role immutable, cycle
 *     rejected (direct + indirect), success updates name/description/parent
 *   - deleteRole: unknown role rejected, system role immutable, blocked by
 *     user assignments, blocked by child roles, success deletes the role's
 *     own direct grants too
 *   - permission catalog: create success, invalid key shape rejected,
 *     duplicate rejected
 *   - role -> permission grants: grant success, invalid grant pattern
 *     rejected, duplicate grant rejected, revoke success, revoke unknown
 *     grant rejected
 *   - user <-> role assignments: assign requires admin.role.assign AND
 *     strong assurance, duplicate assignment rejected, unknown role
 *     rejected, revoke requires admin.role.assign but NO assurance,
 *     revoke unknown assignment rejected
 *   - every mutation writes exactly one audit row, with the right
 *     action/before/after shape
 *   - buildRbacAdminActor: unions legacy role + real RBAC user-role grants
 *
 * Run: npx tsx scripts/src/test-rbac-admin-registry.ts
 */

import assert from "node:assert/strict";
import {
  RbacAdminRegistry,
  RbacRbacAdminAuthorizer,
  buildRbacAdminActor,
  RoleNotFoundError,
  RoleAlreadyExistsError,
  SystemRoleImmutableError,
  RoleInUseError,
  RoleHierarchyCycleError,
  PermissionAlreadyExistsError,
  InvalidPermissionKeyError,
  InvalidGrantPatternError,
  GrantAlreadyExistsError,
  GrantNotFoundError,
  UserRoleAlreadyAssignedError,
  UserRoleAssignmentNotFoundError,
  RbacAdminAuthorizationError,
  RbacAdminInsufficientAssuranceError,
  type Subject,
  type RbacAdminActor,
  type RbacAdminAuditEntry,
  type RbacAdminProvider,
  type RoleAdminRecord,
  type NewRoleInput,
  type PermissionCatalogRecord,
  type RolePermissionGrantRecord,
  type UserRoleAssignmentRecord,
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

// ── FakeRbacProvider — same shape as test-policy-registry.ts's own ──────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoleKeys = new Map<number, string[]>();

  addRole(key: string, parentRoleKey: string | null = null): void {
    this.roles.set(key, { key, parentRoleKey });
    if (!this.rolePermissions.has(key)) this.rolePermissions.set(key, new Set());
  }

  grant(roleKey: string, permissionKey: string): void {
    if (!this.rolePermissions.has(roleKey)) this.rolePermissions.set(roleKey, new Set());
    this.rolePermissions.get(roleKey)!.add(permissionKey);
  }

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
  rbac.addRole("rbac-manager", null);
  rbac.addRole("rbac-assigner", null);
  rbac.addRole("plain-user", null);
  rbac.grant("rbac-manager", "admin.role.manage");
  rbac.grant("rbac-assigner", "admin.role.assign");
  return rbac;
}

// ── FakeRbacAdminProvider — in-memory stand-in for
//    DrizzleRbacAdminProvider ─────────────────────────────────────────────

class FakeRbacAdminProvider implements RbacAdminProvider {
  private nextRoleId = 1;
  private nextPermissionId = 1;
  private nextGrantId = 1;
  private nextAssignmentId = 1;
  readonly roles: RoleAdminRecord[] = [];
  readonly permissions: PermissionCatalogRecord[] = [];
  readonly grants: RolePermissionGrantRecord[] = [];
  readonly assignments: UserRoleAssignmentRecord[] = [];
  readonly auditLog: RbacAdminAuditEntry[] = [];

  seedSystemRole(key: string, parentRoleKey: string | null = null): RoleAdminRecord {
    const now = new Date();
    const row: RoleAdminRecord = {
      id: this.nextRoleId++,
      key,
      name: key,
      description: null,
      parentRoleKey,
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    };
    this.roles.push(row);
    return row;
  }

  async listRoles(): Promise<RoleAdminRecord[]> {
    return [...this.roles].sort((a, b) => a.key.localeCompare(b.key));
  }

  async getRoleByKey(key: string): Promise<RoleAdminRecord | null> {
    return this.roles.find((r) => r.key === key) ?? null;
  }

  async createRole(input: NewRoleInput): Promise<RoleAdminRecord> {
    const now = new Date();
    const row: RoleAdminRecord = {
      id: this.nextRoleId++,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      parentRoleKey: input.parentRoleKey ?? null,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
    };
    this.roles.push(row);
    return row;
  }

  async updateRole(key: string, patch: { name?: string; description?: string | null; parentRoleKey?: string | null }): Promise<RoleAdminRecord> {
    const index = this.roles.findIndex((r) => r.key === key);
    if (index === -1) throw new RoleNotFoundError(key);
    // Replace with a FRESH object, never mutate in place — mirrors what a
    // real UPDATE ... RETURNING hands back, matching
    // FakePolicyRegistryProvider.updateStatus()'s own precedent.
    const updated: RoleAdminRecord = {
      ...this.roles[index],
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.parentRoleKey !== undefined ? { parentRoleKey: patch.parentRoleKey } : {}),
      updatedAt: new Date(),
    };
    this.roles[index] = updated;
    return updated;
  }

  async deleteRole(key: string): Promise<void> {
    const role = this.roles.find((r) => r.key === key);
    if (role) {
      for (let i = this.grants.length - 1; i >= 0; i--) {
        if (this.grants[i].roleId === role.id) this.grants.splice(i, 1);
      }
    }
    const index = this.roles.findIndex((r) => r.key === key);
    if (index !== -1) this.roles.splice(index, 1);
  }

  async hasChildRoles(key: string): Promise<boolean> {
    return this.roles.some((r) => r.parentRoleKey === key);
  }

  async hasUserAssignments(roleId: number): Promise<boolean> {
    return this.assignments.some((a) => a.roleId === roleId);
  }

  async listPermissionCatalog(): Promise<PermissionCatalogRecord[]> {
    return [...this.permissions].sort((a, b) => a.key.localeCompare(b.key));
  }

  async getPermissionByKey(key: string): Promise<PermissionCatalogRecord | null> {
    return this.permissions.find((p) => p.key === key) ?? null;
  }

  async createPermissionCatalogEntry(input: { key: string; description?: string | null }): Promise<PermissionCatalogRecord> {
    const row: PermissionCatalogRecord = {
      id: this.nextPermissionId++,
      key: input.key,
      description: input.description ?? null,
      createdAt: new Date(),
    };
    this.permissions.push(row);
    return row;
  }

  async listRolePermissionGrants(roleId: number): Promise<RolePermissionGrantRecord[]> {
    return this.grants.filter((g) => g.roleId === roleId);
  }

  async getRolePermissionGrant(roleId: number, permissionKey: string): Promise<RolePermissionGrantRecord | null> {
    return this.grants.find((g) => g.roleId === roleId && g.permissionKey === permissionKey) ?? null;
  }

  async grantPermissionToRole(roleId: number, permissionKey: string): Promise<RolePermissionGrantRecord> {
    const row: RolePermissionGrantRecord = { id: this.nextGrantId++, roleId, permissionKey, createdAt: new Date() };
    this.grants.push(row);
    return row;
  }

  async revokePermissionFromRole(roleId: number, permissionKey: string): Promise<void> {
    const index = this.grants.findIndex((g) => g.roleId === roleId && g.permissionKey === permissionKey);
    if (index !== -1) this.grants.splice(index, 1);
  }

  async listUserRoleAssignments(userId: number): Promise<UserRoleAssignmentRecord[]> {
    return this.assignments.filter((a) => a.userId === userId);
  }

  async getUserRoleAssignment(userId: number, roleId: number): Promise<UserRoleAssignmentRecord | null> {
    return this.assignments.find((a) => a.userId === userId && a.roleId === roleId) ?? null;
  }

  async assignRoleToUser(userId: number, roleId: number, grantedBy: number | null, reason: string | null): Promise<UserRoleAssignmentRecord> {
    const role = this.roles.find((r) => r.id === roleId);
    const row: UserRoleAssignmentRecord = {
      id: this.nextAssignmentId++,
      userId,
      roleId,
      roleKey: role?.key ?? "",
      grantedBy,
      reason,
      createdAt: new Date(),
    };
    this.assignments.push(row);
    return row;
  }

  async revokeRoleFromUser(userId: number, roleId: number): Promise<void> {
    const index = this.assignments.findIndex((a) => a.userId === userId && a.roleId === roleId);
    if (index !== -1) this.assignments.splice(index, 1);
  }

  async recordAudit(entry: RbacAdminAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }
}

function actor(userId: number, roleKeys: string[], assuranceMethods: string[] = []): RbacAdminActor {
  return { userId, roleKeys, assuranceMethods };
}

function newRole(key: string, parentRoleKey: string | null = null): NewRoleInput {
  return { key, name: key, description: `test role ${key}`, parentRoleKey };
}

async function main() {
  console.log("Phase 23C — Admin Policy Console (Roles, Permissions & Assignments sections) tests\n");

  // ── Roles section ────────────────────────────────────────────────────

  await test("createRole succeeds, always non-system, writes one audit row", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    const created = await registry.createRole(manager, newRole("editor"));
    assert.equal(created.key, "editor");
    assert.equal(created.isSystem, false);
    assert.equal(provider.auditLog.length, 1);
    assert.equal(provider.auditLog[0].action, "role_created");
    assert.equal(provider.auditLog[0].before, null);
  });

  await test("createRole without admin.role.manage is denied", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const plain = actor(3, ["plain-user"]);

    await assert.rejects(() => registry.createRole(plain, newRole("editor2")), RbacAdminAuthorizationError);
    assert.equal(provider.roles.length, 0);
  });

  await test("createRole rejects duplicate key", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("dup"));
    await assert.rejects(() => registry.createRole(manager, newRole("dup")), RoleAlreadyExistsError);
  });

  await test("createRole rejects unknown parentRoleKey", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await assert.rejects(() => registry.createRole(manager, newRole("orphan", "does-not-exist")), RoleNotFoundError);
  });

  await test("updateRole: unknown role rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await assert.rejects(() => registry.updateRole(manager, "does-not-exist", { name: "x" }), RoleNotFoundError);
  });

  await test("updateRole: system role is immutable", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    provider.seedSystemRole("admin");
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await assert.rejects(() => registry.updateRole(manager, "admin", { name: "renamed" }), SystemRoleImmutableError);
  });

  await test("updateRole: direct cycle rejected (role cannot be its own parent)", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("self-cycle"));
    await assert.rejects(() => registry.updateRole(manager, "self-cycle", { parentRoleKey: "self-cycle" }), RoleHierarchyCycleError);
  });

  await test("updateRole: indirect cycle rejected (A -> B -> C, then C's parent set to A)", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("role-a"));
    await registry.createRole(manager, newRole("role-b", "role-a"));
    await registry.createRole(manager, newRole("role-c", "role-b"));
    await assert.rejects(() => registry.updateRole(manager, "role-a", { parentRoleKey: "role-c" }), RoleHierarchyCycleError);
  });

  await test("updateRole: success updates name/description/parentRoleKey", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("base-role"));
    await registry.createRole(manager, newRole("target"));
    const updated = await registry.updateRole(manager, "target", { name: "Target Renamed", parentRoleKey: "base-role" });
    assert.equal(updated.name, "Target Renamed");
    assert.equal(updated.parentRoleKey, "base-role");
    assert.equal(provider.auditLog.at(-1)?.action, "role_updated");
  });

  await test("deleteRole: unknown role rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await assert.rejects(() => registry.deleteRole(manager, "does-not-exist"), RoleNotFoundError);
  });

  await test("deleteRole: system role is immutable", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    provider.seedSystemRole("dev");
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await assert.rejects(() => registry.deleteRole(manager, "dev"), SystemRoleImmutableError);
  });

  await test("deleteRole: blocked while a user still holds it", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);
    const assigner = actor(2, ["rbac-assigner"], ["totp"]);

    const role = await registry.createRole(manager, newRole("in-use-role"));
    await registry.assignRoleToUser(assigner, 42, "in-use-role", null);
    await assert.rejects(() => registry.deleteRole(manager, "in-use-role"), RoleInUseError);
    void role;
  });

  await test("deleteRole: blocked while it is still a parent of another role", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("parent-role"));
    await registry.createRole(manager, newRole("child-role", "parent-role"));
    await assert.rejects(() => registry.deleteRole(manager, "parent-role"), RoleInUseError);
  });

  await test("deleteRole: success also deletes the role's own direct grants", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("throwaway-role"));
    await registry.grantPermissionToRole(manager, "throwaway-role", "sylo.vault.read");
    await registry.deleteRole(manager, "throwaway-role");

    assert.equal(await registry.getRole("throwaway-role"), null);
    assert.equal(provider.grants.length, 0);
    assert.equal(provider.auditLog.at(-1)?.action, "role_deleted");
  });

  // ── Permission catalog ───────────────────────────────────────────────

  await test("createPermissionCatalogEntry: success", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    const created = await registry.createPermissionCatalogEntry(manager, { key: "sylo.vault.export", description: "Export vault entries." });
    assert.equal(created.key, "sylo.vault.export");
    assert.equal(provider.auditLog.at(-1)?.action, "permission_created");
  });

  await test("createPermissionCatalogEntry: rejects non-concrete/wildcard key", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await assert.rejects(() => registry.createPermissionCatalogEntry(manager, { key: "sylo.vault.*" }), InvalidPermissionKeyError);
  });

  await test("createPermissionCatalogEntry: rejects duplicate key", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createPermissionCatalogEntry(manager, { key: "sylo.vault.share" });
    await assert.rejects(() => registry.createPermissionCatalogEntry(manager, { key: "sylo.vault.share" }), PermissionAlreadyExistsError);
  });

  // ── Role -> permission grants ────────────────────────────────────────

  await test("grantPermissionToRole: success, does not require a catalog entry to already exist", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("grantee-role"));
    const grant = await registry.grantPermissionToRole(manager, "grantee-role", "sylo.*");
    assert.equal(grant.permissionKey, "sylo.*");
    assert.equal(provider.auditLog.at(-1)?.action, "permission_granted");
  });

  await test("grantPermissionToRole: rejects an invalid grant pattern (wildcard not trailing)", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("bad-pattern-role"));
    await assert.rejects(() => registry.grantPermissionToRole(manager, "bad-pattern-role", "*.vault.read"), InvalidGrantPatternError);
  });

  await test("grantPermissionToRole: rejects a duplicate grant", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("dup-grant-role"));
    await registry.grantPermissionToRole(manager, "dup-grant-role", "sylo.vault.read");
    await assert.rejects(() => registry.grantPermissionToRole(manager, "dup-grant-role", "sylo.vault.read"), GrantAlreadyExistsError);
  });

  await test("revokePermissionFromRole: success, and rejects an unknown grant", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);

    await registry.createRole(manager, newRole("revoke-role"));
    await registry.grantPermissionToRole(manager, "revoke-role", "sylo.vault.read");
    await registry.revokePermissionFromRole(manager, "revoke-role", "sylo.vault.read");
    assert.equal((await registry.listRolePermissionGrants("revoke-role")).length, 0);
    assert.equal(provider.auditLog.at(-1)?.action, "permission_revoked");

    await assert.rejects(() => registry.revokePermissionFromRole(manager, "revoke-role", "sylo.vault.read"), GrantNotFoundError);
  });

  // ── User <-> role assignments ────────────────────────────────────────

  await test("assignRoleToUser: requires admin.role.assign", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]); // manage only, no assign
    await registry.createRole(manager, newRole("assignable-role"));

    await assert.rejects(() => registry.assignRoleToUser(manager, 7, "assignable-role", null), RbacAdminAuthorizationError);
  });

  await test("assignRoleToUser: requires strong assurance even with admin.role.assign", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);
    await registry.createRole(manager, newRole("assurance-role"));

    const assignerNoAssurance = actor(2, ["rbac-assigner"]); // no assuranceMethods
    await assert.rejects(
      () => registry.assignRoleToUser(assignerNoAssurance, 7, "assurance-role", null),
      RbacAdminInsufficientAssuranceError,
    );

    const assignerWithAssurance = actor(2, ["rbac-assigner"], ["totp"]);
    const created = await registry.assignRoleToUser(assignerWithAssurance, 7, "assurance-role", "onboarding");
    assert.equal(created.roleKey, "assurance-role");
    assert.equal(created.reason, "onboarding");
    assert.equal(provider.auditLog.at(-1)?.action, "user_role_assigned");
  });

  await test("assignRoleToUser: unknown role rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const assigner = actor(2, ["rbac-assigner"], ["totp"]);

    await assert.rejects(() => registry.assignRoleToUser(assigner, 7, "does-not-exist", null), RoleNotFoundError);
  });

  await test("assignRoleToUser: duplicate assignment rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);
    const assigner = actor(2, ["rbac-assigner"], ["totp"]);

    await registry.createRole(manager, newRole("double-assign-role"));
    await registry.assignRoleToUser(assigner, 8, "double-assign-role", null);
    await assert.rejects(() => registry.assignRoleToUser(assigner, 8, "double-assign-role", null), UserRoleAlreadyAssignedError);
  });

  await test("revokeRoleFromUser: requires admin.role.assign but NO assurance", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);
    const assignerWithAssurance = actor(2, ["rbac-assigner"], ["totp"]);
    const assignerNoAssurance = actor(2, ["rbac-assigner"]); // no assuranceMethods

    await registry.createRole(manager, newRole("revoke-assign-role"));
    await registry.assignRoleToUser(assignerWithAssurance, 9, "revoke-assign-role", null);
    // Revoking must succeed WITHOUT strong assurance — the safe direction.
    await registry.revokeRoleFromUser(assignerNoAssurance, 9, "revoke-assign-role");
    assert.equal((await registry.listUserRoleAssignments(9)).length, 0);
    assert.equal(provider.auditLog.at(-1)?.action, "user_role_revoked");
  });

  await test("revokeRoleFromUser: unknown assignment rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));
    const manager = actor(1, ["rbac-manager"]);
    const assigner = actor(2, ["rbac-assigner"]);

    await registry.createRole(manager, newRole("never-assigned-role"));
    await assert.rejects(() => registry.revokeRoleFromUser(assigner, 10, "never-assigned-role"), UserRoleAssignmentNotFoundError);
  });

  // ── buildRbacAdminActor ──────────────────────────────────────────────

  await test("buildRbacAdminActor: unions legacy role + real RBAC user-role grants", async () => {
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(42, ["rbac-assigner"]);

    const subject: Subject = {
      userId: 42,
      role: "admin", // legacyRoleToRoleKeys("admin") => ["admin"]
      authType: "session",
      assuranceMethods: ["totp"],
    };

    const built = await buildRbacAdminActor(subject, rbac);
    assert.equal(built.userId, 42);
    assert.deepEqual([...built.roleKeys].sort(), ["admin", "rbac-assigner"]);
    assert.deepEqual(built.assuranceMethods, ["totp"]);
  });

  await test("buildRbacAdminActor: an actor it builds is USABLE end-to-end against RbacAdminRegistry", async () => {
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(99, ["rbac-manager"]);
    const provider = new FakeRbacAdminProvider();
    const registry = new RbacAdminRegistry(provider, new RbacRbacAdminAuthorizer(rbac));

    const subject: Subject = { userId: 99, role: "user", authType: "session" };
    const builtActor = await buildRbacAdminActor(subject, rbac);

    const created = await registry.createRole(builtActor, newRole("built-actor-role"));
    assert.equal(created.key, "built-actor-role");
  });

  console.log("\nAll Phase 23C rbac-admin-registry tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
