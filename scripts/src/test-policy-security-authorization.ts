/**
 * scripts/src/test-policy-security-authorization.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 22A (Security / Abuse
 * Testing — Authorization category).
 *
 * The roadmap's own Phase 22 section, verbatim, for the slice this file
 * covers:
 *
 *   "Authorization:
 *    - IDOR
 *    - privilege escalation
 *    - role tampering
 *    - permission injection
 *    - cross-tenant access
 *    - resource-ID substitution
 *
 *    Authorization failures must fail closed."
 *
 * This is a sub-phase, not all of Phase 22 — see this file's own closing
 * comment for exactly what is deliberately NOT covered here (Rule 16: do
 * not implement future phases prematurely, and do not claim a phase
 * "done" by covering only the parts that were easy to reach).
 *
 * ── Run against the real PEP boundary, not the bare PolicyEngine ─────────
 * Every `test-policy-declarative-*.ts` (Phase 21B) suite calls
 * `engine.evaluate()` directly — the right layer for testing one rule's
 * own logic in isolation. An abuse test's whole point is different: it
 * asks "can a hostile CLIENT influence the decision", which is a question
 * about the boundary a real attacker actually touches — the Express
 * `Request` — not about the engine underneath it. So every case here goes
 * through `authorize()` (`../../artifacts/api-server/src/lib/policy/pep/
 * authorize.ts`, Phase 19), the exact function every real route's PEP
 * middleware is built on, with a minimal fake `Request` (same
 * `as unknown as Request` pattern `test-policy-pep.ts` already
 * establishes) that carries attacker-controlled `body`/`query` fields
 * `authorize()` is verified to never read.
 *
 * ── The engine under test: five real rules, one registration ─────────────
 * RBAC + resource-ownership + ReBAC + organization-access + explicit
 * resource grant, all registered on one `PolicyEngine` — the same
 * "vault-access"-shaped composition `test-policy-test-framework.ts`'s own
 * worked example and several Phase 21B declarative suites already use.
 * A single-rule engine could not exercise "does ANY registered grant path
 * leak" the way a multi-rule one can; an attacker does not care which
 * specific rule they might slip through.
 *
 * ── What "fail closed" is checked against, concretely ─────────────────
 * Every negative case in this file asserts BOTH the resulting
 * `AuthorizationDecision.effect` (`DENY`) AND, for the attack cases that
 * involve `requirePolicy()`-shaped HTTP surfacing, that no policy
 * internals leak into a hostile response by default (Phase 15's own
 * `includeDetail` gate, already covered end-to-end by
 * `test-policy-pep.ts` — not re-tested here to avoid duplicating that
 * suite; this file stays focused on the DECISION, not the HTTP shape
 * around it).
 *
 * Run: npx tsx scripts/src/test-policy-security-authorization.ts
 */

import assert from "node:assert/strict";
import type { Request } from "express";
import {
  PolicyEngine,
  authorize,
  createRbacRule,
  createResourceOwnershipRule,
  createRebacRule,
  createOrganizationAccessRule,
  createExplicitResourceGrantRule,
  type RbacProvider,
  type RoleRecord,
  type RelationshipProvider,
  type ResourceGrantProvider,
  type ResourceGrantEntry,
  type ResourceRef,
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

// ── fakes — same shape every Phase 21B declarative suite already uses ────

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
    return this.roles.get(roleKey) ?? null;
  }
}

class FakeRelationshipProvider implements RelationshipProvider {
  private readonly rows = new Map<string, Set<string>>();
  private key(subjectUserId: number, resourceType: string, resourceId: string): string {
    return `${subjectUserId}::${resourceType}::${resourceId}`;
  }
  grant(subjectUserId: number, resourceType: string, resourceId: string, relation: string): void {
    const k = this.key(subjectUserId, resourceType, resourceId);
    if (!this.rows.has(k)) this.rows.set(k, new Set());
    this.rows.get(k)!.add(relation);
  }
  async getRelations(subjectUserId: number, resourceType: string, resourceId: string): Promise<string[]> {
    return [...(this.rows.get(this.key(subjectUserId, resourceType, resourceId)) ?? [])];
  }
}

class FakeResourceGrantProvider implements ResourceGrantProvider {
  private readonly grants = new Map<string, ResourceGrantEntry>();
  private key(subjectUserId: number, resourceType: string, resourceId: string, action: string): string {
    return `${subjectUserId}::${resourceType}::${resourceId}::${action}`;
  }
  setGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string, entry: ResourceGrantEntry): void {
    this.grants.set(this.key(subjectUserId, resourceType, resourceId, action), entry);
  }
  async getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantEntry | null> {
    return this.grants.get(this.key(subjectUserId, resourceType, resourceId, action)) ?? null;
  }
}

/** Minimal fake Request — the fields `authorize()`/`context-adapter.ts`
 *  actually read (`user`, `headers`, `ip`) PLUS attacker-controlled
 *  `body`/`query`, so every case below can assert those two are inert. */
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
    ip: "203.0.113.5",
  } as unknown as Request;
}

async function main() {
  console.log("Policy Engine — Phase 22A (Security / Abuse Testing — Authorization) tests");

  // ── shared fixtures ──────────────────────────────────────────────────

  const rbacProvider = new FakeRbacProvider();
  rbacProvider.addRole("vault-reader");
  rbacProvider.grant("vault-reader", "sylo.vault.read");
  rbacProvider.assignUserRole(10, "vault-reader"); // subject 10: read-only, nothing else

  const relationshipProvider = new FakeRelationshipProvider();
  const resourceGrantProvider = new FakeResourceGrantProvider();
  resourceGrantProvider.setGrant(20, "sylo.vault_item", "42", "sylo.vault.read", { effect: "allow", reason: "shared by owner" });

  function buildEngine(): PolicyEngine {
    const engine = new PolicyEngine();
    engine.registerRule("rbac", createRbacRule(rbacProvider));
    engine.registerRule("resource-ownership", createResourceOwnershipRule());
    engine.registerRule("rebac", createRebacRule(relationshipProvider));
    engine.registerRule("organization-access", createOrganizationAccessRule());
    engine.registerRule("resource-grant", createExplicitResourceGrantRule(resourceGrantProvider));
    return engine;
  }

  async function attempt(user: unknown, action: string, resource: ResourceRef, extra: { body?: unknown; query?: unknown; headers?: Record<string, string> } = {}) {
    const engine = buildEngine();
    const req = fakeRequest({ user, ...extra });
    return authorize({ req, engine, action, resource });
  }

  // ── IDOR ────────────────────────────────────────────────────────────

  await test("IDOR: a real subject requesting a colleague's private resource by guessing its id is denied — no grant path covers it", async () => {
    const outcome = await attempt(
      { userId: 30, role: "member" },
      "sylo.vault.read",
      { type: "sylo.vault_item", id: "777", ownerId: 999 }, // resource belongs to someone else
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
  });

  // ── privilege escalation ────────────────────────────────────────────

  await test("privilege escalation: a read-only role cannot perform a stronger action nothing grants it", async () => {
    const outcome = await attempt(
      { userId: 10, role: "member" }, // holds only sylo.vault.read via RBAC
      "sylo.vault.delete",
      { type: "sylo.vault_item", id: "1" },
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
  });

  await test("privilege escalation: forging req.body.action alongside a real, narrower action has no effect — authorize() takes the action from the route's own call, never from the request body", async () => {
    const outcome = await attempt(
      { userId: 10, role: "member" },
      "sylo.vault.read", // this is what the ROUTE HANDLER passes — the real, non-negotiable action
      { type: "sylo.vault_item", id: "1" },
      { body: { action: "sylo.vault.delete" } }, // attacker's attempted override
    );
    // Still evaluated as sylo.vault.read, which subject 10 legitimately holds.
    assert.equal(outcome.decision.effect, "ALLOW");
    assert.equal(outcome.decision.policyId, "rbac");
  });

  // ── role tampering ──────────────────────────────────────────────────

  await test("role tampering: req.body.role = \"admin\" has zero effect — authorize() reads the subject's role only from req.user, never from the request body", async () => {
    const outcome = await attempt(
      { userId: 10, role: "member" }, // the AUTHENTIC, server-set role
      "sylo.vault.delete",
      { type: "sylo.vault_item", id: "1" },
      { body: { role: "admin" }, query: { role: "admin" } },
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
    // The Subject authorize() actually built still carries the real role.
    assert.equal(outcome.subject?.role, "member");
  });

  await test("role tampering: an X-Role header does not exist as a recognized input at all — authorize() never reads any header except x-request-id (correlation id), never one purporting to carry identity", async () => {
    const outcome = await attempt(
      { userId: 10, role: "member" },
      "sylo.vault.delete",
      { type: "sylo.vault_item", id: "1" },
      { headers: { "x-role": "admin", "x-user-role": "admin" } },
    );
    assert.equal(outcome.decision.effect, "DENY");
  });

  // ── permission injection ────────────────────────────────────────────

  await test("permission injection: req.user.permissions (a field AuthenticatedUserLike does not define) is never read — an attacker cannot assert their own permission list", async () => {
    const outcome = await attempt(
      { userId: 10, role: "member", permissions: ["sylo.vault.*"] }, // not a real Subject/AuthenticatedUserLike field
      "sylo.vault.delete",
      { type: "sylo.vault_item", id: "1" },
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
  });

  await test("permission injection: req.body.permissions is never consulted by any registered rule", async () => {
    const outcome = await attempt(
      { userId: 10, role: "member" },
      "sylo.vault.delete",
      { type: "sylo.vault_item", id: "1" },
      { body: { permissions: ["sylo.vault.delete"], grants: ["sylo.vault.delete"] } },
    );
    assert.equal(outcome.decision.effect, "DENY");
  });

  // ── cross-tenant access ─────────────────────────────────────────────

  await test("cross-tenant access: a subject in organization 200 is denied organization 100's resource — organization-access abstains on mismatch, nothing else covers it", async () => {
    const outcome = await attempt(
      { userId: 40, role: "member", organizationId: 200 },
      "sylo.vault.read",
      { type: "sylo.vault_item", id: "5", organizationId: 100 },
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
  });

  await test("cross-tenant access: forging req.body.organizationId to match the target org has no effect — organizationId comes only from req.user, never the body", async () => {
    const outcome = await attempt(
      { userId: 40, role: "member", organizationId: 200 },
      "sylo.vault.read",
      { type: "sylo.vault_item", id: "5", organizationId: 100 },
      { body: { organizationId: 100 } },
    );
    assert.equal(outcome.decision.effect, "DENY");
  });

  // ── resource-ID substitution ────────────────────────────────────────

  await test("resource-ID substitution: an explicit grant for resource \"42\" does not cover resource \"43\" — exact match only", async () => {
    const outcome = await attempt(
      { userId: 20, role: "member" }, // holds an explicit allow grant, but only for resource "42"
      "sylo.vault.read",
      { type: "sylo.vault_item", id: "43" },
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
  });

  await test("resource-ID substitution: a lookalike id (\"42x\") is not treated as a prefix/fuzzy match of a real grant on \"42\"", async () => {
    const outcome = await attempt(
      { userId: 20, role: "member" },
      "sylo.vault.read",
      { type: "sylo.vault_item", id: "42x" },
    );
    assert.equal(outcome.decision.effect, "DENY");
  });

  await test("resource-ID substitution: the real grant on \"42\" still legitimately works — confirms the two prior denials were about the substituted id, not a broken fixture", async () => {
    const outcome = await attempt(
      { userId: 20, role: "member" },
      "sylo.vault.read",
      { type: "sylo.vault_item", id: "42" },
    );
    assert.equal(outcome.decision.effect, "ALLOW");
    assert.equal(outcome.decision.policyId, "resource-grant");
  });

  // ── composition: fail-closed even when every rule independently abstains ──

  await test("fail closed: an unauthenticated request (no req.user at all) is denied before any rule even runs, regardless of any body/query content", async () => {
    const outcome = await attempt(
      null,
      "sylo.vault.delete",
      { type: "sylo.vault_item", id: "1" },
      { body: { userId: 10, role: "admin" }, query: { authenticated: "true" } },
    );
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "UNAUTHENTICATED");
    assert.equal(outcome.subject, null);
  });

  console.log("\nAll Phase 22A Authorization abuse-testing checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ── Deliberately NOT done here (later Phase 22 sub-phases) ───────────────
 * - Authentication category (unsigned/malformed/expired token, token
 *   substitution, stale session) — needs the real `lib/jwt.ts`
 *   verification code and `middlewares/auth.ts`, not a fake `req.user`;
 *   this file's entire fixture set assumes `req.user` is already
 *   authentic, which is exactly the assumption that category exists to
 *   stress-test.
 * - Context category (spoofed organization/role/risk/device/assurance) —
 *   overlaps this file's role/org cases at the PEP boundary, but the
 *   roadmap's own framing is about a Phase 18 PIP's enrichment inputs
 *   specifically (session/device/risk providers), not covered here.
 * - Policy category (policy injection, invalid DSL, conflicting rules,
 *   priority abuse, cache poisoning, stale authorization cache) — needs
 *   the Phase 06 DSL compiler and Phase 07 registry/PAP layer exercised
 *   adversarially, a distinct suite from this one.
 * - Reliability category (database/policy/provider/cache failure, partial
 *   context failure) — needs providers that fail on demand (throwing
 *   fakes), not the always-succeeding fakes this file uses.
 */
