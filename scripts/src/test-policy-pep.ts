/**
 * scripts/src/test-policy-pep.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK)
 * tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, no real
 * Express server needed, runnable anywhere with
 *   npx tsx scripts/src/test-policy-pep.ts
 *
 * Uses minimal fake Request/Response objects (same `as unknown as Request`
 * pattern test-policy-pip.ts already establishes) and in-memory
 * FakeRbacProvider / FakeApprovalRequestProvider (same shape
 * test-policy-rbac.ts / test-policy-approval.ts already use).
 *
 * Covers:
 *   - authorize(): builds Subject/PolicyContext from req.user, evaluates
 *     against a caller-supplied engine, never touches res
 *   - requirePolicy(): ALLOW -> next(); DENY -> 403 body; UNAUTHENTICATED
 *     -> 401; req.authorization always stamped
 *   - requirePermission(): grants/denies via real RBAC rule; throws at
 *     construction on a malformed permission key
 *   - requireOwnership(): owner allowed, non-owner denied, missing
 *     ownerId on the built resource -> next(err), never a silent deny
 *   - requireRole(): membership allowed, mismatch denied with
 *     EXPLICIT_DENY (not NO_MATCHING_POLICY)
 *   - requireStepUp(): satisfied assurance -> ALLOW via the companion
 *     pass-through rule; unmet -> 401 STEP_UP with requiredAssurance
 *   - requireApproval(): live APPROVED request -> ALLOW; none -> 403
 *     APPROVAL_REQUIRED
 *   - onDeny/onStepUp/onApprovalRequired overrides fully replace the
 *     default response
 *   - includeDetail (boolean and predicate form) gates Phase 15 admin
 *     detail on a DENY body
 *
 * Run: npx tsx scripts/src/test-policy-pep.ts
 */

import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import {
  PolicyEngine,
  allow,
  authorize,
  requirePolicy,
  requirePermission,
  requireOwnership,
  requireRole,
  requireStepUp,
  requireApproval,
  createRbacRule,
  createApprovalGateRule,
  type RbacProvider,
  type RoleRecord,
  type ResourceRef,
  type ApprovalRequestProvider,
  type ApprovalRequestRecord,
  type ApprovalAuditEntry,
  type CreateApprovalRequestInput,
  type ApprovalState,
  type AuthorizingEngine,
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

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeRbacProvider implements RbacProvider {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly userRoles = new Map<number, Set<string>>();

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
    return [...(this.userRoles.get(userId) ?? [])];
  }
  async getRolePermissionKeys(roleKey: string): Promise<string[]> {
    return [...(this.rolePermissions.get(roleKey) ?? [])];
  }
  async getRole(roleKey: string): Promise<RoleRecord | null> {
    return this.roles.get(roleKey) ?? null;
  }
}

class FakeApprovalRequestProvider implements ApprovalRequestProvider {
  readonly rows: ApprovalRequestRecord[] = [];
  private nextId = 1;

  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRecord> {
    const row: ApprovalRequestRecord = {
      id: this.nextId++,
      initiatorUserId: input.initiatorUserId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      action: input.action,
      organizationId: input.organizationId ?? null,
      reason: input.reason,
      state: "APPROVED",
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      decidedBy: 999,
      decidedAt: new Date(),
      decisionReason: "test fixture — pre-approved",
    };
    this.rows.push(row);
    return { ...row };
  }
  async getById(id: number | string): Promise<ApprovalRequestRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async findApprovedRequest(
    initiatorUserId: number,
    resourceType: string,
    resourceId: string | null,
    action: string,
  ): Promise<ApprovalRequestRecord | null> {
    return (
      this.rows.find(
        (r) =>
          r.state === "APPROVED" &&
          r.initiatorUserId === initiatorUserId &&
          r.resourceType === resourceType &&
          r.resourceId === resourceId &&
          r.action === action,
      ) ?? null
    );
  }
  async updateState(
    id: number | string,
    next: ApprovalState,
    decision?: { decidedBy: number | null; decisionReason?: string | null },
  ): Promise<ApprovalRequestRecord> {
    const row = this.rows.find((r) => r.id === id)!;
    row.state = next;
    if (decision) {
      row.decidedBy = decision.decidedBy;
      row.decisionReason = decision.decisionReason ?? null;
    }
    return { ...row };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async recordAudit(_entry: ApprovalAuditEntry): Promise<void> {
    /* no-op — not exercised by this suite */
  }
}

/** Minimal fake Request — only the fields authorize.ts / context-adapter.ts
 *  actually read. */
function fakeRequest(overrides: { user?: unknown; headers?: Record<string, string> } = {}): Request {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    ip: "203.0.113.5",
  } as unknown as Request;
}

interface FakeResponseCapture {
  statusCode?: number;
  body?: unknown;
}

function fakeResponse(): { res: Response; capture: FakeResponseCapture } {
  const capture: FakeResponseCapture = {};
  const res = {
    status(code: number) {
      capture.statusCode = code;
      return this;
    },
    json(body: unknown) {
      capture.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, capture };
}

function fakeNext(): { next: NextFunction; calls: unknown[] } {
  const calls: unknown[] = [];
  const next: NextFunction = ((err?: unknown) => {
    calls.push(err);
  }) as NextFunction;
  return { next, calls };
}

async function main() {
  console.log("Policy PEP / Express SDK — Phase 19 tests");

  // ── authorize() — the low-level primitive ───────────────────────────────

  await test("authorize(): unauthenticated req.user -> UNAUTHENTICATED deny, never throws", async () => {
    const engine = new PolicyEngine();
    const req = fakeRequest();
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item" } });
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "UNAUTHENTICATED");
    assert.equal(outcome.subject, null);
  });

  await test("authorize(): authenticated + zero rules -> NO_MATCHING_POLICY deny (default-deny, Rule 7)", async () => {
    const engine = new PolicyEngine();
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item" } });
    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "NO_MATCHING_POLICY");
    assert.equal(outcome.subject?.userId, 1);
  });

  await test("authorize(): allow rule -> ALLOW, request recovered for explain()", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => allow(request, "EXPLICIT_ALLOW"));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const outcome = await authorize({ req, engine, action: "sylo.vault.read", resource: { type: "sylo.vault_item" } });
    assert.equal(outcome.decision.effect, "ALLOW");
    assert.equal(outcome.request?.action, "sylo.vault.read");
  });

  // ── requirePolicy() — the generic middleware ────────────────────────────

  await test("requirePolicy(): ALLOW calls next() with no error, stamps req.authorization", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => allow(request, "EXPLICIT_ALLOW"));
    const mw = requirePolicy(engine, "sylo.vault.read", () => ({ type: "sylo.vault_item", id: "1" }));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.deepEqual(calls, [undefined]);
    assert.equal(req.authorization?.decision.effect, "ALLOW");
  });

  await test("requirePolicy(): unauthenticated -> 401, next() never called", async () => {
    const engine = new PolicyEngine();
    const mw = requirePolicy(engine, "sylo.vault.read", () => ({ type: "sylo.vault_item" }));
    const req = fakeRequest();
    const { res, capture } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.equal(calls.length, 0);
    assert.equal(capture.statusCode, 401);
    assert.equal((capture.body as { code: string }).code, "UNAUTHENTICATED");
  });

  await test("requirePolicy(): DENY -> 403 with generic userMessage, no policy internals by default", async () => {
    const engine = new PolicyEngine(); // zero rules -> NO_MATCHING_POLICY
    const mw = requirePolicy(engine, "sylo.vault.read", () => ({ type: "sylo.vault_item" }));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.equal(calls.length, 0);
    assert.equal(capture.statusCode, 403);
    const body = capture.body as { error: string; code: string; solution: string; detail?: unknown };
    assert.equal(body.error, "Forbidden");
    assert.equal(body.code, "NO_MATCHING_POLICY");
    assert.equal(body.solution, "You don't have permission to perform this action.");
    assert.equal(body.detail, undefined);
  });

  await test("requirePolicy(): includeDetail true attaches Phase 15 admin detail", async () => {
    const engine = new PolicyEngine();
    const mw = requirePolicy(engine, "sylo.vault.read", () => ({ type: "sylo.vault_item" }), { includeDetail: true });
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next } = fakeNext();
    await mw(req, res, next);
    const body = capture.body as { detail?: { reasonCode: string } };
    assert.equal(body.detail?.reasonCode, "NO_MATCHING_POLICY");
  });

  await test("requirePolicy(): includeDetail predicate is called per-request", async () => {
    let calledWith: Request | undefined;
    const engine = new PolicyEngine();
    const mw = requirePolicy(engine, "sylo.vault.read", () => ({ type: "sylo.vault_item" }), {
      includeDetail: (req) => {
        calledWith = req;
        return false;
      },
    });
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next } = fakeNext();
    await mw(req, res, next);
    assert.equal(calledWith, req);
    assert.equal((capture.body as { detail?: unknown }).detail, undefined);
  });

  await test("requirePolicy(): onDeny override fully replaces the default response", async () => {
    const engine = new PolicyEngine();
    const mw = requirePolicy(engine, "sylo.vault.read", () => ({ type: "sylo.vault_item" }), {
      onDeny: (req, res) => {
        res.status(451).json({ custom: true });
      },
    });
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next } = fakeNext();
    await mw(req, res, next);
    assert.equal(capture.statusCode, 451);
    assert.deepEqual(capture.body, { custom: true });
  });

  // ── requirePermission() ──────────────────────────────────────────────────

  await test("requirePermission(): throws at construction on a malformed permission key", () => {
    const provider = new FakeRbacProvider();
    assert.throws(() => requirePermission(provider, "not-a-permission-key"));
  });

  await test("requirePermission(): grants via a real role permission, denies otherwise", async () => {
    const provider = new FakeRbacProvider();
    provider.addRole("user");
    provider.grant("user", "sylo.vault.read");
    provider.assignUserRole(1, "user");
    provider.assignUserRole(2, "user"); // no additional grant

    const mw = requirePermission(provider, "sylo.vault.approve", () => ({ type: "sylo.vault_item" }));
    // user 1 has read, not approve -> denied
    const req1 = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res: res1, capture: capture1 } = fakeResponse();
    const { next: next1 } = fakeNext();
    await mw(req1, res1, next1);
    assert.equal(capture1.statusCode, 403);

    provider.grant("user", "sylo.vault.approve");
    const req2 = fakeRequest({ user: { userId: 2, role: "user", authType: "session" } });
    const { res: res2 } = fakeResponse();
    const { next: next2, calls: calls2 } = fakeNext();
    await mw(req2, res2, next2);
    assert.deepEqual(calls2, [undefined]);
    assert.equal(req2.authorization?.decision.effect, "ALLOW");
  });

  // ── requireOwnership() ───────────────────────────────────────────────────

  await test("requireOwnership(): owner allowed, non-owner denied", async () => {
    const resource: ResourceRef = { type: "sylo.vault_item", id: "9", ownerId: 1 };
    const mw = requireOwnership("sylo.vault.read", () => resource);

    const owner = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res: res1 } = fakeResponse();
    const { next: next1, calls: calls1 } = fakeNext();
    await mw(owner, res1, next1);
    assert.deepEqual(calls1, [undefined]);

    const stranger = fakeRequest({ user: { userId: 2, role: "user", authType: "session" } });
    const { res: res2, capture: capture2 } = fakeResponse();
    const { next: next2 } = fakeNext();
    await mw(stranger, res2, next2);
    assert.equal(capture2.statusCode, 403);
  });

  await test("requireOwnership(): resource builder omitting ownerId -> next(err), never a silent deny", async () => {
    const mw = requireOwnership("sylo.vault.read", () => ({ type: "sylo.vault_item", id: "9" }));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof Error);
    assert.match((calls[0] as Error).message, /did not populate resource\.ownerId/);
  });

  // ── requireRole() ────────────────────────────────────────────────────────

  await test("requireRole(): membership allowed, mismatch denied with EXPLICIT_DENY", async () => {
    const mw = requireRole(["admin", "dev"]);

    const admin = fakeRequest({ user: { userId: 1, role: "admin", authType: "session" } });
    const { res: res1 } = fakeResponse();
    const { next: next1, calls: calls1 } = fakeNext();
    await mw(admin, res1, next1);
    assert.deepEqual(calls1, [undefined]);
    assert.equal(admin.authorization?.decision.policyId, "subject-role");

    const user = fakeRequest({ user: { userId: 2, role: "user", authType: "session" } });
    const { res: res2, capture: capture2 } = fakeResponse();
    const { next: next2 } = fakeNext();
    await mw(user, res2, next2);
    assert.equal(capture2.statusCode, 403);
    assert.equal(user.authorization?.decision.reason, "EXPLICIT_DENY");
  });

  // ── requireStepUp() ───────────────────────────────────────────────────────

  await test("requireStepUp(): assurance already met -> ALLOW via the companion pass-through rule", async () => {
    const mw = requireStepUp("L1"); // base authenticated session already satisfies L1
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.deepEqual(calls, [undefined]);
    assert.equal(req.authorization?.decision.policyId, "assurance-gate-pass");
  });

  await test("requireStepUp(): assurance unmet -> 401 STEP_UP with requiredAssurance", async () => {
    const mw = requireStepUp("L4"); // passkey — a plain session subject never has this
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.equal(calls.length, 0);
    assert.equal(capture.statusCode, 401);
    const body = capture.body as { code: string; requiredAssurance?: string };
    assert.equal(body.code, "STEP_UP_REQUIRED");
    assert.equal(body.requiredAssurance, "L4");
  });

  await test("requireStepUp(): onStepUp override fully replaces the default response", async () => {
    const mw = requireStepUp("L4", {
      onStepUp: (req, res) => {
        res.status(428).json({ retryAfterStepUp: true });
      },
    });
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next } = fakeNext();
    await mw(req, res, next);
    assert.equal(capture.statusCode, 428);
  });

  // ── requireApproval() ────────────────────────────────────────────────────

  await test("requireApproval(): a live APPROVED request -> ALLOW", async () => {
    const provider = new FakeApprovalRequestProvider();
    await provider.create({
      initiatorUserId: 1,
      resourceType: "ryft.payout",
      resourceId: "77",
      action: "ryft.payout.release",
      reason: "quarterly payout",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const mw = requireApproval(provider, "ryft.payout.release", () => ({ type: "ryft.payout", id: "77" }));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.deepEqual(calls, [undefined]);
  });

  await test("requireApproval(): no approved request on file -> 403 APPROVAL_REQUIRED", async () => {
    const provider = new FakeApprovalRequestProvider();
    const mw = requireApproval(provider, "ryft.payout.release", () => ({ type: "ryft.payout", id: "1" }));
    const req = fakeRequest({ user: { userId: 5, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.equal(calls.length, 0);
    assert.equal(capture.statusCode, 403);
    assert.equal((capture.body as { code: string }).code, "APPROVAL_REQUIRED");
  });

  await test("requireApproval(): an approval on file for a DIFFERENT resource id never grants (no cross-resource leak)", async () => {
    const provider = new FakeApprovalRequestProvider();
    await provider.create({
      initiatorUserId: 1,
      resourceType: "ryft.payout",
      resourceId: "77",
      action: "ryft.payout.release",
      reason: "quarterly payout",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const mw = requireApproval(provider, "ryft.payout.release", () => ({ type: "ryft.payout", id: "78" }));
    const req = fakeRequest({ user: { userId: 1, role: "user", authType: "session" } });
    const { res, capture } = fakeResponse();
    const { next, calls } = fakeNext();
    await mw(req, res, next);
    assert.equal(calls.length, 0);
    assert.equal(capture.statusCode, 403);
  });

  console.log("\nAll Phase 19 PEP tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
