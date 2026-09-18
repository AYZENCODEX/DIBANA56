/**
 * scripts/src/test-policy-rbac.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC) tests.
 *
 * Same shape as scripts/src/test-policy-engine.ts / test-policy-pip.ts /
 * test-policy-decision-observer.ts: DB-free, runnable anywhere with
 * nothing but
 *   npx tsx scripts/src/test-policy-rbac.ts
 *
 * Uses an in-memory `FakeRbacProvider` (implements the same `RbacProvider`
 * interface `DrizzleRbacProvider` does — see rbac/types.ts) instead of a
 * real database, so this suite exercises the exact same code path
 * (permission-matcher.ts, role-resolver.ts, rbac-rule.ts) that a real
 * Postgres-backed run would, without needing one.
 *
 * Covers the roadmap's Phase 02 test list:
 *   - role grants permission
 *   - missing permission denied
 *   - inherited role
 *   - revoked role
 *   - invalid wildcard
 *   - privilege escalation
 * plus direct unit coverage of permission-matcher.ts's wildcard grammar
 * and role-resolver.ts's cycle/depth guards, since those are the two
 * places a subtle bug would be easiest to introduce and hardest to notice
 * from the rule-level tests alone.
 *
 * Run: npx tsx scripts/src/test-policy-rbac.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createRbacRule,
  createAnyPermissionRule,
  isValidPermissionKey,
  isValidGrantPattern,
  permissionMatches,
  resolveEffectivePermissions,
  legacyRoleToRoleKeys,
  RBAC_POLICY_ID,
  ANY_PERMISSION_POLICY_ID,
  type RbacProvider,
  type RoleRecord,
  type Subject,
  type BuildAuthorizationRequestInput,
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

// ── FakeRbacProvider — in-memory stand-in for DrizzleRbacProvider ─────────

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

function buildInput(
  subject: Subject | null,
  action: string,
  overrides: Partial<BuildAuthorizationRequestInput> = {},
): BuildAuthorizationRequestInput {
  return {
    subject,
    action,
    resource: { type: "sylo.vault_item", id: 1 },
    ...overrides,
  };
}

function seededProvider(): FakeRbacProvider {
  // Mirrors migration 096's seed shape, minus the "admin gets '*'" grant —
  // several tests below build their own narrower provider so each test's
  // assumptions are visible locally rather than depending on this shared
  // fixture's exact contents.
  const provider = new FakeRbacProvider();
  provider.addRole("user", null);
  provider.addRole("dev", "user");
  provider.addRole("admin", "dev");
  provider.grant("user", "sylo.vault.read");
  provider.grant("user", "sylo.vault.update");
  provider.grant("dev", "ryft.payment.approve");
  return provider;
}

async function main() {
  console.log("Policy Engine — Phase 02 (RBAC) tests");

  // ── permission-matcher.ts — grammar ────────────────────────────────────

  await test("isValidPermissionKey: concrete 3-segment key is valid", () => {
    assert.equal(isValidPermissionKey("sylo.vault.read"), true);
  });

  await test("isValidPermissionKey: rejects wrong segment count / bad chars", () => {
    assert.equal(isValidPermissionKey("sylo.vault"), false);
    assert.equal(isValidPermissionKey("sylo.vault.read.extra"), false);
    assert.equal(isValidPermissionKey("Sylo.Vault.Read"), false);
    assert.equal(isValidPermissionKey("sylo.vault.*"), false); // a key, not a pattern
    assert.equal(isValidPermissionKey(""), false);
  });

  await test("isValidGrantPattern: concrete key, trailing wildcards, and global '*' are valid", () => {
    assert.equal(isValidGrantPattern("sylo.vault.read"), true);
    assert.equal(isValidGrantPattern("sylo.vault.*"), true);
    assert.equal(isValidGrantPattern("sylo.*"), true);
    assert.equal(isValidGrantPattern("*"), true);
  });

  await test("isValidGrantPattern: rejects non-trailing wildcards ('invalid wildcard' case)", () => {
    assert.equal(isValidGrantPattern("*.vault.read"), false);
    assert.equal(isValidGrantPattern("sylo.*.read"), false);
    assert.equal(isValidGrantPattern("*.vault.*"), false);
  });

  await test("isValidGrantPattern: rejects an incomplete key masquerading as a pattern", () => {
    // "sylo.vault" has no trailing "*" and is not a complete 3-segment key —
    // must NOT be silently treated as "sylo.vault.*".
    assert.equal(isValidGrantPattern("sylo.vault"), false);
    assert.equal(isValidGrantPattern(""), false);
    assert.equal(isValidGrantPattern("sylo.vault.read.extra"), false);
  });

  await test("permissionMatches: concrete pattern matches only the exact key", () => {
    assert.equal(permissionMatches("sylo.vault.read", "sylo.vault.read"), true);
    assert.equal(permissionMatches("sylo.vault.read", "sylo.vault.update"), false);
  });

  await test("permissionMatches: trailing wildcard widens as documented", () => {
    assert.equal(permissionMatches("sylo.vault.*", "sylo.vault.read"), true);
    assert.equal(permissionMatches("sylo.vault.*", "sylo.vault.update"), true);
    assert.equal(permissionMatches("sylo.vault.*", "ryft.payment.create"), false);
    assert.equal(permissionMatches("sylo.*", "sylo.vault.read"), true);
    assert.equal(permissionMatches("sylo.*", "ryft.payment.create"), false);
    assert.equal(permissionMatches("*", "ryft.payment.approve"), true);
  });

  await test("permissionMatches: an invalid/malformed pattern never matches anything (fails closed)", () => {
    assert.equal(permissionMatches("*.vault.read", "sylo.vault.read"), false);
    assert.equal(permissionMatches("sylo.*.read", "sylo.vault.read"), false);
    assert.equal(permissionMatches("", "sylo.vault.read"), false);
  });

  await test("permissionMatches: a non-concrete `required` never matches (defensive)", () => {
    assert.equal(permissionMatches("sylo.vault.*", "sylo.vault.*"), false);
    assert.equal(permissionMatches("*", "not-a-permission"), false);
  });

  // ── role-resolver.ts — inheritance, cycles, depth ──────────────────────

  await test("resolveEffectivePermissions: single role with no parent", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("user", null);
    provider.grant("user", "sylo.vault.read");
    const perms = await resolveEffectivePermissions(provider, ["user"]);
    assert.deepEqual([...perms].sort(), ["sylo.vault.read"]);
  });

  await test("resolveEffectivePermissions: inherited role — child's permissions include parent's", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("user", null);
    provider.addRole("dev", "user");
    provider.grant("user", "sylo.vault.read");
    provider.grant("dev", "ryft.payment.approve");
    const perms = await resolveEffectivePermissions(provider, ["dev"]);
    assert.deepEqual([...perms].sort(), ["ryft.payment.approve", "sylo.vault.read"]);
  });

  await test("resolveEffectivePermissions: multi-level chain (admin -> dev -> user)", async () => {
    const provider = seededProvider();
    provider.grant("admin", "admin.user.manage");
    const perms = await resolveEffectivePermissions(provider, ["admin"]);
    assert.deepEqual(
      [...perms].sort(),
      ["admin.user.manage", "ryft.payment.approve", "sylo.vault.read", "sylo.vault.update"].sort(),
    );
  });

  await test("resolveEffectivePermissions: unknown role key contributes nothing, does not throw", async () => {
    const provider = new FakeRbacProvider();
    const perms = await resolveEffectivePermissions(provider, ["does-not-exist"]);
    assert.deepEqual([...perms], []);
  });

  await test("resolveEffectivePermissions: cyclic parent chain terminates instead of hanging", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("a", "b");
    provider.addRole("b", "a"); // a -> b -> a -> ...
    provider.grant("a", "sylo.vault.read");
    provider.grant("b", "ryft.payment.approve");
    const perms = await resolveEffectivePermissions(provider, ["a"]);
    // Must terminate (the test itself would hang/timeout otherwise) and
    // must still collect both roles' grants, since each is visited exactly
    // once before the cycle guard stops re-queuing it.
    assert.deepEqual([...perms].sort(), ["ryft.payment.approve", "sylo.vault.read"]);
  });

  await test("resolveEffectivePermissions: maxDepth stops descent beyond the configured bound", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("l0", "l1");
    provider.addRole("l1", "l2");
    provider.addRole("l2", "l3");
    provider.grant("l0", "sylo.vault.read");
    provider.grant("l3", "ryft.payment.approve"); // only reachable at depth 3
    const shallow = await resolveEffectivePermissions(provider, ["l0"], { maxDepth: 1 });
    assert.deepEqual([...shallow].sort(), ["sylo.vault.read"]); // l1 reached (depth 1), l2/l3 not
    const deep = await resolveEffectivePermissions(provider, ["l0"], { maxDepth: 8 });
    assert.deepEqual([...deep].sort(), ["ryft.payment.approve", "sylo.vault.read"]);
  });

  // ── legacy-role-map.ts ──────────────────────────────────────────────────

  await test("legacyRoleToRoleKeys: maps known legacy strings 1:1, unknown strings to nothing", () => {
    assert.deepEqual(legacyRoleToRoleKeys("user"), ["user"]);
    assert.deepEqual(legacyRoleToRoleKeys("dev"), ["dev"]);
    assert.deepEqual(legacyRoleToRoleKeys("admin"), ["admin"]);
    assert.deepEqual(legacyRoleToRoleKeys("superadmin"), []);
    assert.deepEqual(legacyRoleToRoleKeys(""), []);
  });

  // ── rbac-rule.ts wired into a real PolicyEngine ─────────────────────────

  await test("role grants permission → ALLOW via legacy role mapping", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(buildInput(alice, "sylo.vault.read"));
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, RBAC_POLICY_ID);
  });

  await test("missing permission → default DENY (rule abstains, engine falls through)", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    // "user" role has no admin.user.manage grant in the seed fixture.
    const decision = await engine.evaluate(buildInput(alice, "admin.user.manage"));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("inherited role → dev inherits user's grants, plus its own", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const bob: Subject = { userId: 2, role: "dev", authType: "session" };
    const inherited = await engine.evaluate(buildInput(bob, "sylo.vault.read")); // from parent "user"
    assert.equal(inherited.effect, "ALLOW");
    const own = await engine.evaluate(buildInput(bob, "ryft.payment.approve")); // dev's own grant
    assert.equal(own.effect, "ALLOW");
  });

  await test("explicit user_roles grant works even with an unrecognized legacy role string", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    // subject.role is some future/custom string legacyRoleToRoleKeys does not
    // recognize — permission must still come through purely via the
    // explicit user_roles assignment, proving the two paths are independent.
    provider.assignUserRole(3, "dev");
    const carol: Subject = { userId: 3, role: "custom-future-role", authType: "session" };
    const decision = await engine.evaluate(buildInput(carol, "ryft.payment.approve"));
    assert.equal(decision.effect, "ALLOW");
  });

  await test("revoked role → previously-allowed action now default-denies", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    provider.assignUserRole(4, "dev");
    const dana: Subject = { userId: 4, role: "user", authType: "session" }; // legacy "user" only
    const before = await engine.evaluate(buildInput(dana, "ryft.payment.approve"));
    assert.equal(before.effect, "ALLOW");

    provider.unassignUserRole(4, "dev"); // simulates an admin revoking the extra role
    const after = await engine.evaluate(buildInput(dana, "ryft.payment.approve"));
    assert.equal(after.effect, "DENY");
    assert.equal(after.reason, "NO_MATCHING_POLICY");
  });

  await test("revoking a specific grant (not the whole role) also takes effect immediately", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    assert.equal((await engine.evaluate(buildInput(alice, "sylo.vault.update"))).effect, "ALLOW");
    provider.revoke("user", "sylo.vault.update");
    assert.equal((await engine.evaluate(buildInput(alice, "sylo.vault.update"))).effect, "DENY");
  });

  await test("invalid wildcard stored in role_permissions never grants access", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("user", null);
    provider.grant("user", "*.vault.read"); // malformed — non-trailing wildcard
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(buildInput(alice, "sylo.vault.read"));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("privilege escalation: a client-forged subject.role string grants nothing extra", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    // Nothing upstream of the engine lets a caller set subject.role to an
    // arbitrary string and have it mean anything here — legacyRoleToRoleKeys
    // is a closed whitelist, and there is no user_roles row for this user,
    // so "admin" typed into a field the client doesn't control in practice
    // (Subject is built server-side from a DB-verified token — see
    // pip/subject-adapter.ts) still resolves to zero permissions if the
    // provider has no record of it.
    const forged: Subject = { userId: 999, role: "admin", authType: "session" };
    // Simulate the provider having NO knowledge of user 999 at all (e.g. a
    // stale/forged userId) — legacyRoleToRoleKeys("admin") still resolves
    // via the *role seed data*, so this specifically tests that an
    // unassigned, unknown user gets exactly the seeded "admin" role's real
    // grants — not something larger than what the provider actually has on
    // file for the "admin" role.
    provider.grant("admin", "admin.user.manage");
    const decision = await engine.evaluate(buildInput(forged, "admin.user.manage"));
    assert.equal(decision.effect, "ALLOW"); // legitimate: role seed data really does grant this
    // But a permission NEVER granted to any role in the closure must still
    // deny, no matter what the client-influenced userId/role look like.
    // NOTE: "ryft.payment.approve" is NOT a valid negative case here — in
    // seededProvider()'s hierarchy admin's parent is "dev", and "dev" is
    // granted ryft.payment.approve directly, so it IS in admin's effective
    // closure via legitimate role inheritance (role-resolver.ts) — using it
    // as the "must deny" example was a bug in this test, not in the rule.
    // "ryft.payment.create" is genuinely ungranted to user/dev/admin in this
    // fixture (only migration 096's REAL seed grants it, to "user"; this
    // test's seededProvider() deliberately omits it — see that helper's own
    // comment), so it is the correct negative case.
    const notGranted = await engine.evaluate(buildInput(forged, "ryft.payment.create"));
    assert.equal(notGranted.effect, "DENY");
  });

  await test("privilege escalation: forging request.resource fields does not unlock RBAC grants", async () => {
    // RBAC in Phase 02 only ever looks at request.action + subject — it does
    // not read request.resource at all (resource-level checks are Phase 03).
    // Confirms stuffing arbitrary resource fields can't influence this rule.
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(
      buildInput(alice, "admin.user.manage", {
        resource: { type: "admin.user", id: 1, ownerId: 1, classification: "top-secret" },
      }),
    );
    assert.equal(decision.effect, "DENY");
  });

  await test("unauthenticated subject never reaches the RBAC rule at all", async () => {
    const provider = seededProvider();
    provider.grant("admin", "admin.user.manage");
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const decision = await engine.evaluate(buildInput(null, "admin.user.manage"));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  await test("non-RBAC-shaped action (opaque legacy string) → rule abstains cleanly", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(buildInput(alice, "read")); // not product.resource.action
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("deny-overrides still wins over an RBAC ALLOW (combining algorithm unchanged)", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(RBAC_POLICY_ID, createRbacRule(provider));
    engine.registerRule("later-explicit-deny", (req) => {
      if (req.action === "sylo.vault.read") {
        return { effect: "DENY", reason: "EXPLICIT_DENY", requestId: req.context.requestId, evaluatedAt: new Date(), policyId: "later-explicit-deny" };
      }
      return null;
    });
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(buildInput(alice, "sylo.vault.read"));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.policyId, "later-explicit-deny");
  });

  // ── any-permission-rule.ts — Route Integration Roadmap, Season B,
  //    Phase B3's "manage OR approve" escape hatch ────────────────────────

  await test("createAnyPermissionRule: ALLOWs when the subject holds the first of two listed permissions", async () => {
    const provider = seededProvider();
    provider.grant("admin", "admin.policy.manage");
    const engine = new PolicyEngine();
    engine.registerRule(ANY_PERMISSION_POLICY_ID, createAnyPermissionRule(provider, ["admin.policy.manage", "admin.policy.approve"]));
    const admin: Subject = { userId: 4, role: "admin", authType: "session" };
    // `request.action` here is whatever a caller's PEP check names — it is
    // deliberately NOT one of the two permissionKeys, since this rule never
    // compares against `request.action` at all (see this file's own header).
    const decision = await engine.evaluate(buildInput(admin, "pep.policy_admin.access_check"));
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.reason, "EXPLICIT_ALLOW");
    assert.equal(decision.policyId, ANY_PERMISSION_POLICY_ID);
  });

  await test("createAnyPermissionRule: ALLOWs when the subject holds only the second listed permission", async () => {
    const provider = seededProvider();
    provider.grant("dev", "admin.policy.approve");
    const engine = new PolicyEngine();
    engine.registerRule(ANY_PERMISSION_POLICY_ID, createAnyPermissionRule(provider, ["admin.policy.manage", "admin.policy.approve"]));
    const bob: Subject = { userId: 2, role: "dev", authType: "session" };
    const decision = await engine.evaluate(buildInput(bob, "pep.policy_admin.access_check"));
    assert.equal(decision.effect, "ALLOW");
  });

  await test("createAnyPermissionRule: abstains (default DENY) when neither listed permission is held", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(ANY_PERMISSION_POLICY_ID, createAnyPermissionRule(provider, ["admin.policy.manage", "admin.policy.approve"]));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(buildInput(alice, "pep.policy_admin.access_check"));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY");
  });

  await test("createAnyPermissionRule: a later rule can still ALLOW after this one abstains (never an explicit DENY)", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(ANY_PERMISSION_POLICY_ID, createAnyPermissionRule(provider, ["admin.policy.manage", "admin.policy.approve"]));
    engine.registerRule("later-explicit-allow", (req) => ({
      effect: "ALLOW",
      reason: "EXPLICIT_ALLOW",
      requestId: req.context.requestId,
      evaluatedAt: new Date(),
      policyId: "later-explicit-allow",
    }));
    const alice: Subject = { userId: 1, role: "user", authType: "session" };
    const decision = await engine.evaluate(buildInput(alice, "pep.policy_admin.access_check"));
    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, "later-explicit-allow");
  });

  await test("createAnyPermissionRule: unauthenticated subject never reaches the rule", async () => {
    const provider = seededProvider();
    const engine = new PolicyEngine();
    engine.registerRule(ANY_PERMISSION_POLICY_ID, createAnyPermissionRule(provider, ["admin.policy.manage", "admin.policy.approve"]));
    const decision = await engine.evaluate(buildInput(null, "pep.policy_admin.access_check"));
    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "UNAUTHENTICATED");
  });

  console.log("Policy Engine — Phase 02 (RBAC): all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
