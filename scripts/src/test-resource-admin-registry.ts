/**
 * scripts/src/test-resource-admin-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section) tests.
 *
 * Same shape as `scripts/src/test-rbac-admin-registry.ts`: DB-free,
 * runnable anywhere with nothing but
 *   npx tsx scripts/src/test-resource-admin-registry.ts
 *
 * Uses an in-memory `FakeResourceAdminProvider` (implements the same
 * `ResourceAdminProvider` interface `DrizzleResourceAdminProvider` does)
 * and the real, RBAC-backed `RbacResourceAdminAuthorizer` wired to a
 * `FakeRbacProvider` shape identical to `test-rbac-admin-registry.ts`'s
 * own (an independent copy, not a shared import — same "these fixtures
 * must not depend on each other" reasoning `resource-admin-registry.ts`'s
 * own header gives for `STRONG_ASSURANCE_METHODS`), so this suite
 * exercises the exact same code path (resource-admin-registry.ts,
 * authorizer.ts) a real Postgres-backed run would.
 *
 * Covers:
 *   - createResourceGrant: success (both effects), duplicate tuple
 *     rejected (regardless of the existing row's effect), denied without
 *     admin.resource.manage, "allow" requires strong assurance, "deny"
 *     does NOT require assurance
 *   - revokeResourceGrant: success (both effects, neither requires
 *     assurance), unknown tuple rejected, denied without
 *     admin.resource.manage
 *   - reads (listResourceGrants/listGrantsForSubject/
 *     listGrantsForResource/getResourceGrant) are NOT actor-gated at the
 *     registry level — they return data regardless of the caller's
 *     permissions, matching resource-admin/types.ts's own documented
 *     provider contract
 *   - every mutation writes exactly one audit row, with the right
 *     action/before/after shape and the full tuple as subjectKey
 *   - buildResourceAdminActor: unions legacy role + real RBAC user-role
 *     grants, and the actor it builds is usable end-to-end against
 *     ResourceAdminRegistry
 *
 * Run: npx tsx scripts/src/test-resource-admin-registry.ts
 */

import assert from "node:assert/strict";
import {
  ResourceAdminRegistry,
  RbacResourceAdminAuthorizer,
  buildResourceAdminActor,
  ResourceGrantAlreadyExistsError,
  ResourceGrantNotFoundError,
  ResourceAdminAuthorizationError,
  ResourceAdminInsufficientAssuranceError,
  type Subject,
  type ResourceAdminActor,
  type ResourceAdminAuditEntry,
  type ResourceAdminProvider,
  type ResourceGrantAdminRecord,
  type NewResourceGrantInput,
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

// ── FakeRbacProvider — same shape as test-rbac-admin-registry.ts's own
//    (independent copy, see file header) ────────────────────────────────

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
  rbac.addRole("resource-manager", null);
  rbac.addRole("plain-user", null);
  rbac.grant("resource-manager", "admin.resource.manage");
  return rbac;
}

// ── FakeResourceAdminProvider — in-memory stand-in for
//    DrizzleResourceAdminProvider ──────────────────────────────────────

class FakeResourceAdminProvider implements ResourceAdminProvider {
  private nextId = 1;
  readonly grants: ResourceGrantAdminRecord[] = [];
  readonly auditLog: ResourceAdminAuditEntry[] = [];

  async listResourceGrants(): Promise<ResourceGrantAdminRecord[]> {
    return [...this.grants].sort((a, b) => a.id - b.id);
  }

  async listGrantsForSubject(subjectUserId: number): Promise<ResourceGrantAdminRecord[]> {
    return this.grants.filter((g) => g.subjectUserId === subjectUserId);
  }

  async listGrantsForResource(resourceType: string, resourceId: string): Promise<ResourceGrantAdminRecord[]> {
    return this.grants.filter((g) => g.resourceType === resourceType && g.resourceId === resourceId);
  }

  async getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantAdminRecord | null> {
    return (
      this.grants.find(
        (g) => g.subjectUserId === subjectUserId && g.resourceType === resourceType && g.resourceId === resourceId && g.action === action,
      ) ?? null
    );
  }

  async createResourceGrant(input: NewResourceGrantInput, grantedBy: number | null): Promise<ResourceGrantAdminRecord> {
    const row: ResourceGrantAdminRecord = {
      id: this.nextId++,
      subjectUserId: input.subjectUserId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      action: input.action,
      effect: input.effect,
      grantedBy,
      reason: input.reason ?? null,
      createdAt: new Date(),
    };
    this.grants.push(row);
    return row;
  }

  async deleteResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<void> {
    const index = this.grants.findIndex(
      (g) => g.subjectUserId === subjectUserId && g.resourceType === resourceType && g.resourceId === resourceId && g.action === action,
    );
    if (index !== -1) this.grants.splice(index, 1);
  }

  async recordAudit(entry: ResourceAdminAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }
}

function actor(userId: number, roleKeys: string[], assuranceMethods?: string[]): ResourceAdminActor {
  return { userId, roleKeys, assuranceMethods };
}

function newGrant(overrides: Partial<NewResourceGrantInput> = {}): NewResourceGrantInput {
  return {
    subjectUserId: 7,
    resourceType: "sylo.vault_item",
    resourceId: "vault-item-1",
    action: "sylo.vault.read",
    effect: "deny",
    ...overrides,
  };
}

async function main() {
  console.log("Phase 23D — resource-admin-registry tests\n");

  // ── createResourceGrant ────────────────────────────────────────────

  await test("createResourceGrant: deny succeeds without assurance", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(1, ["resource-manager"]);

    const created = await registry.createResourceGrant(manager, newGrant({ effect: "deny" }));
    assert.equal(created.effect, "deny");
    assert.equal(provider.grants.length, 1);
  });

  await test("createResourceGrant: allow requires strong assurance", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const managerNoAssurance = actor(1, ["resource-manager"]);
    const managerWithAssurance = actor(1, ["resource-manager"], ["totp"]);

    await assert.rejects(
      () => registry.createResourceGrant(managerNoAssurance, newGrant({ effect: "allow" })),
      ResourceAdminInsufficientAssuranceError,
    );
    assert.equal(provider.grants.length, 0);

    const created = await registry.createResourceGrant(managerWithAssurance, newGrant({ effect: "allow" }));
    assert.equal(created.effect, "allow");
  });

  await test("createResourceGrant: duplicate tuple rejected regardless of existing effect", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(1, ["resource-manager"], ["totp"]);

    await registry.createResourceGrant(manager, newGrant({ effect: "deny" }));
    await assert.rejects(() => registry.createResourceGrant(manager, newGrant({ effect: "allow" })), ResourceGrantAlreadyExistsError);
    assert.equal(provider.grants.length, 1);
  });

  await test("createResourceGrant: denied without admin.resource.manage", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const plainUser = actor(2, ["plain-user"], ["totp"]);

    await assert.rejects(() => registry.createResourceGrant(plainUser, newGrant()), ResourceAdminAuthorizationError);
    assert.equal(provider.grants.length, 0);
  });

  await test("createResourceGrant: writes exactly one audit row with the right shape", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(5, ["resource-manager"]);

    const created = await registry.createResourceGrant(manager, newGrant({ subjectUserId: 42, reason: "vendor escalation" }));
    assert.equal(provider.auditLog.length, 1);
    const entry = provider.auditLog[0]!;
    assert.equal(entry.actorId, 5);
    assert.equal(entry.action, "resource_grant_created");
    assert.equal(entry.subjectKey, "42:sylo.vault_item:vault-item-1:sylo.vault.read");
    assert.equal(entry.before, null);
    assert.deepEqual(entry.after, {
      id: created.id,
      subjectUserId: 42,
      resourceType: "sylo.vault_item",
      resourceId: "vault-item-1",
      action: "sylo.vault.read",
      effect: "deny",
      reason: "vendor escalation",
    });
  });

  // ── revokeResourceGrant ────────────────────────────────────────────

  await test("revokeResourceGrant: succeeds for either effect without assurance", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const managerWithAssurance = actor(1, ["resource-manager"], ["totp"]);
    const managerNoAssurance = actor(1, ["resource-manager"]);

    await registry.createResourceGrant(managerWithAssurance, newGrant({ subjectUserId: 8, effect: "allow" }));
    // Revoking an "allow" row must succeed WITHOUT strong assurance —
    // the safe/narrowing direction.
    await registry.revokeResourceGrant(managerNoAssurance, 8, "sylo.vault_item", "vault-item-1", "sylo.vault.read");
    assert.equal(provider.grants.length, 0);
    assert.equal(provider.auditLog.at(-1)?.action, "resource_grant_revoked");
  });

  await test("revokeResourceGrant: unknown tuple rejected", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(1, ["resource-manager"]);

    await assert.rejects(
      () => registry.revokeResourceGrant(manager, 99, "sylo.vault_item", "does-not-exist", "sylo.vault.read"),
      ResourceGrantNotFoundError,
    );
  });

  await test("revokeResourceGrant: denied without admin.resource.manage", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(1, ["resource-manager"], ["totp"]);
    const plainUser = actor(2, ["plain-user"]);

    await registry.createResourceGrant(manager, newGrant({ subjectUserId: 3, effect: "deny" }));
    await assert.rejects(
      () => registry.revokeResourceGrant(plainUser, 3, "sylo.vault_item", "vault-item-1", "sylo.vault.read"),
      ResourceAdminAuthorizationError,
    );
    assert.equal(provider.grants.length, 1);
  });

  await test("revokeResourceGrant: writes exactly one audit row with the right shape", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(1, ["resource-manager"]);

    const created = await registry.createResourceGrant(manager, newGrant({ subjectUserId: 11 }));
    await registry.revokeResourceGrant(manager, 11, "sylo.vault_item", "vault-item-1", "sylo.vault.read");

    assert.equal(provider.auditLog.length, 2);
    const revokeEntry = provider.auditLog[1]!;
    assert.equal(revokeEntry.action, "resource_grant_revoked");
    assert.equal(revokeEntry.subjectKey, "11:sylo.vault_item:vault-item-1:sylo.vault.read");
    assert.deepEqual(revokeEntry.before, {
      id: created.id,
      subjectUserId: 11,
      resourceType: "sylo.vault_item",
      resourceId: "vault-item-1",
      action: "sylo.vault.read",
      effect: "deny",
      reason: null,
    });
    assert.equal(revokeEntry.after, null);
  });

  // ── Reads are NOT actor-gated at the registry level ─────────────────

  await test("reads: listResourceGrants/listGrantsForSubject/listGrantsForResource/getResourceGrant ignore actor permissions", async () => {
    const rbac = buildRbacFixture();
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));
    const manager = actor(1, ["resource-manager"]);

    await registry.createResourceGrant(manager, newGrant({ subjectUserId: 20, resourceId: "vault-item-a" }));
    await registry.createResourceGrant(manager, newGrant({ subjectUserId: 21, resourceId: "vault-item-b" }));

    assert.equal((await registry.listResourceGrants()).length, 2);
    assert.equal((await registry.listGrantsForSubject(20)).length, 1);
    assert.equal((await registry.listGrantsForResource("sylo.vault_item", "vault-item-b")).length, 1);
    const one = await registry.getResourceGrant(20, "sylo.vault_item", "vault-item-a", "sylo.vault.read");
    assert.ok(one);
    assert.equal(one!.subjectUserId, 20);
  });

  // ── buildResourceAdminActor ──────────────────────────────────────────

  await test("buildResourceAdminActor: unions legacy role + real RBAC user-role grants", async () => {
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(42, ["resource-manager"]);

    const subject: Subject = {
      userId: 42,
      role: "admin", // legacyRoleToRoleKeys("admin") => ["admin"]
      authType: "session",
      assuranceMethods: ["totp"],
    };

    const built = await buildResourceAdminActor(subject, rbac);
    assert.equal(built.userId, 42);
    assert.deepEqual([...built.roleKeys].sort(), ["admin", "resource-manager"]);
    assert.deepEqual(built.assuranceMethods, ["totp"]);
  });

  await test("buildResourceAdminActor: an actor it builds is USABLE end-to-end against ResourceAdminRegistry", async () => {
    const rbac = buildRbacFixture();
    rbac.setUserRoleKeys(99, ["resource-manager"]);
    const provider = new FakeResourceAdminProvider();
    const registry = new ResourceAdminRegistry(provider, new RbacResourceAdminAuthorizer(rbac));

    const subject: Subject = { userId: 99, role: "user", authType: "session" };
    const builtActor = await buildResourceAdminActor(subject, rbac);

    const created = await registry.createResourceGrant(builtActor, newGrant({ subjectUserId: 55, effect: "deny" }));
    assert.equal(created.subjectUserId, 55);
  });

  console.log("\nAll Phase 23D resource-admin-registry tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
