/**
 * scripts/src/test-policy-security-workflow.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase F2: Workflow Security (§65 "F: Reliability/
 * security", continuing CHANGES_MEGA_ENGINE_RELIABILITY_PHASE_F1.md).
 *
 * F1 built run inspection/cancel/replay and left five §58 Security rows
 * unaddressed, verbatim from that doc's own "Still open" section:
 *
 *   PEP denial | stale authorization | privilege changes during waiting |
 *   cross-organization access | admin-only operations
 *
 * ("event replay" and "workflow replay" — the other two §58 Security rows —
 * were already built in Part A and this same F1 phase respectively; they
 * are not re-tested here, see this file's own "Not covered here" section
 * at the bottom for why.)
 *
 * This file closes all five, against the REAL, unmodified functions —
 * never a reimplementation:
 *   - `authorizeWorkflowAction()` (lib/workflow/authorization.ts) — the
 *     exact function engine.ts's `runStep()` wires up as
 *     `WorkflowActionContext.authorize` (see that file's own `ctx.authorize`
 *     closure, engine.ts line ~112-121). Testing this function directly
 *     tests the real call site, not an approximation of it.
 *   - `requireRole()` (lib/policy/pep/middleware.ts) — the exact factory
 *     `middlewares/auth.ts`'s `requireDev` composes with `["dev", "admin"]`
 *     to build its own (private, unexported) `devRoleCheck`. See "admin-
 *     only operations" below for exactly what this does and does not
 *     cover.
 *
 * ── Why `authorizeWorkflowAction()`, not `engine.ts`'s full `runStep()`/
 *    `executeRun()` loop ──────────────────────────────────────────────────
 * `runStep()`/`executeRun()` are DB-backed at nearly every line —
 * `run-store.ts`'s `getPendingStepRun()`/`transitionStepRun()`, `context.ts`'s
 * `getAllVariables()`/`setVariable()`, `definition-store.ts`'s
 * `getDefinition()` — all real `@workspace/db`/drizzle calls, same
 * constraint every phase this session has disclosed (no `node_modules`, no
 * reachable Postgres). `authorizeWorkflowAction()` itself is the one
 * exception, BY DESIGN — its own file header says so explicitly ("this
 * file stays DB-free... `resolveSubject` is injected... so this file has
 * zero dependency on the pep/ (Express-shaped) directory"). It is also
 * the ONLY place in the whole engine.ts/authorization.ts pair where §22's
 * actual guarantee lives (fresh `resolveSubject` call, never cached) — so
 * testing it directly is not a weaker substitute for testing the full
 * loop, it is testing the precise mechanism the loop depends on, isolated
 * from DB plumbing that has nothing to do with the guarantee itself.
 *
 * Run: npx tsx scripts/src/test-policy-security-workflow.ts
 */

import assert from "node:assert/strict";
import {
  PolicyEngine,
  createOrganizationAccessRule,
  requireRole,
  type Subject,
  type AuthorizationDecision,
} from "../../artifacts/api-server/src/lib/policy";
import {
  authorizeWorkflowAction,
  WorkflowActionDeniedError,
  type WorkflowRun,
} from "../../artifacts/api-server/src/lib/workflow";
import { invoke, type OwnershipMiddleware } from "./lib/ownership-route-test-kit";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

/** Minimal, otherwise-valid WorkflowRun — every case below overrides only
 *  the `context` field it actually cares about. `id`/`definitionId`/
 *  `createdAt` are never inspected by `authorizeWorkflowAction()` (it only
 *  reads `run.context.userId`/`run.context.correlationId` — see that
 *  file's own source), so fixed placeholder values are fine here. */
function fakeRun(context: WorkflowRun["context"]): WorkflowRun {
  return {
    id: "run-test-0001",
    definitionId: "test.definition",
    definitionVersion: 1,
    status: "RUNNING",
    context,
    createdAt: new Date(),
  };
}

async function main() {
  console.log("AYZEN Mega Engine — Phase F2: Workflow Security tests\n");

  // ═══════════════════════════════════════════════════════════════════════
  // PEP denial
  // ═══════════════════════════════════════════════════════════════════════
  // §58's plain "PEP denial" row: a workflow action that IS denied by the
  // real PDP must come back as a DENY decision from authorizeWorkflowAction()
  // — and (separately) the engine.ts call-site convention of throwing
  // WorkflowActionDeniedError on anything but ALLOW (see engine.ts's
  // `ctx.authorize` closure) must actually fire for a real DENY decision,
  // not just for a hand-built one.

  await test("PEP denial: a real registered rule's DENY reaches the caller unchanged (effect/reason/policyId all pass through)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("deny-everything", (request) => ({
      effect: "DENY" as const,
      reason: "EXPLICIT_DENY" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
      policyId: "deny-everything",
      message: "test rule always denies",
    }));

    const run = fakeRun({ userId: 42 });
    const resolveSubject = async (userId: number): Promise<Subject | null> =>
      userId === 42 ? { userId: 42, role: "member", authType: "session" } : null;

    const decision = await authorizeWorkflowAction({
      engine,
      resolveSubject,
      run,
      action: "sylo.vault.delete",
      resource: { type: "sylo.vault_item", id: "1" },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "EXPLICIT_DENY");
    assert.equal(decision.policyId, "deny-everything");
  });

  await test("PEP denial: engine.ts's own call-site convention — anything but ALLOW becomes a thrown WorkflowActionDeniedError carrying the real decision", async () => {
    // This reproduces engine.ts's `ctx.authorize` closure verbatim (see
    // that file's runStep(), the `if (decision.effect !== "ALLOW") throw
    // new WorkflowActionDeniedError(decision)` line) — not a
    // reimplementation of authorizeWorkflowAction() itself, just the one
    // line of caller logic wrapped around it, so this case proves the
    // ACTUAL integration behavior a denied step-handler call would see,
    // not merely that authorizeWorkflowAction() alone returns DENY.
    const engine = new PolicyEngine(); // no rules registered — default-deny
    const run = fakeRun({ userId: 7 });
    const resolveSubject = async (): Promise<Subject | null> => ({ userId: 7, role: "member", authType: "session" });

    async function authorizeLikeEngineTsDoes(action: string, resource: Parameters<typeof authorizeWorkflowAction>[0]["resource"]): Promise<AuthorizationDecision> {
      const decision = await authorizeWorkflowAction({ engine, resolveSubject, run, action, resource });
      if (decision.effect !== "ALLOW") throw new WorkflowActionDeniedError(decision);
      return decision;
    }

    await assert.rejects(
      () => authorizeLikeEngineTsDoes("sylo.vault.delete", { type: "sylo.vault_item", id: "1" }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowActionDeniedError);
        assert.equal(err.decision.effect, "DENY");
        assert.equal(err.decision.reason, "NO_MATCHING_POLICY"); // default-deny, no rule matched
        return true;
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Stale authorization / privilege changes during waiting
  // ═══════════════════════════════════════════════════════════════════════
  // §22's own named failure case: "User was admin yesterday -> workflow
  // executes today -> still gets admin access." F1's own "Still open" list
  // named this unverified ("would need to be read closely to answer this
  // with certainty, not assumed"). This proves it with an executable
  // scenario instead of a source read: the SAME `run` object (i.e. the
  // same WAITING/resumed workflow run — nothing about the run itself
  // changes across the two calls) is authorized twice through the SAME
  // `resolveSubject` function, but that function's own backing data
  // (a mutable map, standing in for a `users` table row) changes in
  // between — modeling exactly what "privilege changes during waiting"
  // means: the step BEFORE the wait ran under one role, the step AFTER
  // resume runs under whatever role holds now.

  await test("stale authorization / privilege changes during waiting: a role downgrade between two authorize() calls on the SAME run is honored on the second call, not the first", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("admin-only", (request) => {
      if (request.subject?.role === "admin") {
        return { effect: "ALLOW" as const, reason: "EXPLICIT_ALLOW" as const, requestId: request.context.requestId, evaluatedAt: new Date(), policyId: "admin-only" };
      }
      return null; // abstain — let default-deny handle non-admins, same as a real RBAC-shaped rule would
    });

    // Stands in for a `users` table row — mutated between the two
    // authorize() calls the same way a real admin demoting this user
    // mid-workflow would mutate the real row.
    const backingUserRole = { current: "admin" };
    let resolveCalls = 0;
    const resolveSubject = async (userId: number): Promise<Subject | null> => {
      resolveCalls++;
      return { userId, role: backingUserRole.current, authType: "session" };
    };

    const run = fakeRun({ userId: 99 }); // one run, unchanged across both calls — models a WAITING run resuming

    // Step BEFORE the wait: user is still admin.
    const beforeWait = await authorizeWorkflowAction({ engine, resolveSubject, run, action: "admin.settings.write", resource: { type: "admin.settings", id: "global" } });
    assert.equal(beforeWait.effect, "ALLOW");

    // ...time passes, run parks WAITING, an admin revokes this user's role...
    backingUserRole.current = "member";

    // Step AFTER resume: SAME run, SAME action, but the role fact has
    // changed. If authorizeWorkflowAction() ever cached/reused the first
    // call's Subject (the exact bug §22 exists to prevent), this would
    // still ALLOW. It does not.
    const afterResume = await authorizeWorkflowAction({ engine, resolveSubject, run, action: "admin.settings.write", resource: { type: "admin.settings", id: "global" } });
    assert.equal(afterResume.effect, "DENY");
    assert.equal(afterResume.reason, "NO_MATCHING_POLICY");

    // The real proof this isn't a cache: resolveSubject() (the "hit the
    // users table fresh" step) really did run twice, once per call.
    assert.equal(resolveCalls, 2);
  });

  await test("stale authorization: a resolveSubject() returning null (account deleted/suspended between calls) fails closed as UNAUTHENTICATED, not as whatever the LAST resolved subject was", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("member-allow", (request) => {
      if (request.subject?.role === "member") {
        return { effect: "ALLOW" as const, reason: "EXPLICIT_ALLOW" as const, requestId: request.context.requestId, evaluatedAt: new Date(), policyId: "member-allow" };
      }
      return null;
    });

    const accountExists = { current: true };
    const resolveSubject = async (userId: number): Promise<Subject | null> =>
      accountExists.current ? { userId, role: "member", authType: "session" } : null;

    const run = fakeRun({ userId: 5 });

    const first = await authorizeWorkflowAction({ engine, resolveSubject, run, action: "vault.read", resource: { type: "vault_item", id: "1" } });
    assert.equal(first.effect, "ALLOW");

    accountExists.current = false; // account suspended/deleted before the resumed step runs

    const second = await authorizeWorkflowAction({ engine, resolveSubject, run, action: "vault.read", resource: { type: "vault_item", id: "1" } });
    assert.equal(second.effect, "DENY");
    assert.equal(second.reason, "UNAUTHENTICATED"); // engine.evaluate()'s own early-decision gate for subject === null — see policy-engine.ts's resolveRequestOrEarlyDecision()
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cross-organization access
  // ═══════════════════════════════════════════════════════════════════════
  // F1's own "Still open" list flagged this as untested for the new admin
  // routes specifically (a `requireDev` global-admin gate, deliberately no
  // per-org boundary — see "admin-only operations" below for that half).
  // The half that DOES apply generally — a workflow ACTION handler's own
  // `ctx.authorize()` call, when the handler passes an organization-scoped
  // ResourceRef — goes through the exact same `createOrganizationAccessRule()`
  // every HTTP-triggered request already does (§22's diagram: "Workflow
  // Step -> Domain Service -> PEP -> Policy Engine", no separate workflow-
  // specific tenant rule). Proven here the same way
  // test-policy-declarative-organization-access.ts already proves it for
  // the HTTP path — same rule, same engine, different (workflow) caller.

  await test("cross-organization access: a workflow action's resource scoped to organization A denies a subject from organization B", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("organization-access", createOrganizationAccessRule());

    const run = fakeRun({ userId: 2, organizationId: 200 });
    const resolveSubject = async (userId: number): Promise<Subject | null> => ({ userId, role: "member", authType: "session", organizationId: 200 });

    const decision = await authorizeWorkflowAction({
      engine,
      resolveSubject,
      run,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "1", organizationId: 100 }, // a DIFFERENT org than the resolved subject's
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "NO_MATCHING_POLICY"); // organization-access-rule.ts abstains on mismatch (never itself denies) — default-deny is what actually fires, same as the HTTP-path suite already documents
  });

  await test("cross-organization access: same-organization subject and resource is allowed", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("organization-access", createOrganizationAccessRule());

    const run = fakeRun({ userId: 1, organizationId: 100 });
    const resolveSubject = async (userId: number): Promise<Subject | null> => ({ userId, role: "member", authType: "session", organizationId: 100 });

    const decision = await authorizeWorkflowAction({
      engine,
      resolveSubject,
      run,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "1", organizationId: 100 },
    });

    assert.equal(decision.effect, "ALLOW");
    assert.equal(decision.policyId, "organization-access");
  });

  await test("cross-organization access: run.context.organizationId is NOT itself trusted as the subject's org — only whatever resolveSubject() actually resolves is (mirrors authorization.ts's own \"never a cached Subject\" rule — a stale/forged context field cannot substitute for a fresh lookup)", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("organization-access", createOrganizationAccessRule());

    // run.context claims org 100 (e.g. stale from trigger time, or simply
    // never trustworthy input), but the FRESH resolveSubject() lookup says
    // this user is actually in org 200 now.
    const run = fakeRun({ userId: 3, organizationId: 100 });
    const resolveSubject = async (userId: number): Promise<Subject | null> => ({ userId, role: "member", authType: "session", organizationId: 200 });

    const decision = await authorizeWorkflowAction({
      engine,
      resolveSubject,
      run,
      action: "sylo.vault.read",
      resource: { type: "sylo.vault_item", id: "1", organizationId: 100 }, // matches run.context, NOT the resolved subject
    });

    // If this rule (or authorizeWorkflowAction()) ever trusted
    // run.context.organizationId as a stand-in for the subject's real org,
    // this would wrongly ALLOW. It does not — only the resolved Subject's
    // organizationId (200) is ever compared, and it doesn't match the
    // resource's (100).
    assert.equal(decision.effect, "DENY");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Admin-only operations
  // ═══════════════════════════════════════════════════════════════════════
  // `routes/admin-mega-engine.ts` gates every route (including every F1
  // route this phase reviews) with `requireDev` (middlewares/auth.ts) —
  // which is `getTokenFromReq()` + `getUserFromToken()` (a real DB read by
  // token) followed by a private, unexported `devRoleCheck` built as
  // `pepRequireRole(["dev", "admin"], {...})`. The token/DB half is out of
  // scope here (no reachable DB in this sandbox — same constraint as
  // everywhere else in this file/session); what's tested is the actual
  // role-gate mechanism `devRoleCheck` is built FROM — `requireRole()`
  // itself (lib/policy/pep/middleware.ts), the same exported factory,
  // called with the identical role list, exercised via the REAL Express
  // middleware chain (not a reimplementation) using the same
  // fakeReq/fakeRes/invoke harness `ownership-route-test-kit.ts` already
  // established for this exact "mock the one seam that needs a double,
  // run everything else for real" pattern (see that file's own header).
  //
  // This proves the PDP-level guarantee ("only dev/admin roles ever reach
  // next()") that every requireDev-gated route, admin-mega-engine.ts
  // included, depends on. It does NOT re-prove that requireDev's own
  // token-lookup prelude is wired correctly — that is generic auth-layer
  // plumbing shared by every requireDev/requireAdmin route in this
  // codebase, not something specific to the Mega Engine's admin console,
  // and mocking it here would just be a second, narrower copy of
  // whatever a real `middlewares/auth.ts` test suite should already be
  // (out of this phase's scope — §65 gives Phase F no bullet list, and
  // this file scopes itself to what's genuinely new/Mega-Engine-specific,
  // same discipline F1's own header applies to its scope cut).

  await test("admin-only operations: a \"dev\" role reaches next() under the exact role list admin-mega-engine.ts's requireDev uses", async () => {
    const middleware = requireRole(["dev", "admin"]) as unknown as OwnershipMiddleware;
    const { nextCalled, captured } = await invoke(middleware, {}, { userId: 1, role: "dev" });
    assert.equal(nextCalled, true);
    assert.equal(captured.jsonCalled, false);
  });

  await test("admin-only operations: an \"admin\" role also reaches next() (requireDev's own role list is [\"dev\", \"admin\"], not \"dev\" alone)", async () => {
    const middleware = requireRole(["dev", "admin"]) as unknown as OwnershipMiddleware;
    const { nextCalled } = await invoke(middleware, {}, { userId: 2, role: "admin" });
    assert.equal(nextCalled, true);
  });

  await test("admin-only operations: an ordinary \"member\" role is denied (next() never called) — the mega-engine admin console cannot be reached by a non-dev/admin subject", async () => {
    const middleware = requireRole(["dev", "admin"]) as unknown as OwnershipMiddleware;
    const { nextCalled, captured } = await invoke(middleware, {}, { userId: 3, role: "member" });
    assert.equal(nextCalled, false);
    assert.equal(captured.jsonCalled, true);
    assert.equal(captured.statusCode, 403);
  });

  await test("admin-only operations: an unauthenticated request (no user at all) is denied, not treated as an anonymous role", async () => {
    const middleware = requireRole(["dev", "admin"]) as unknown as OwnershipMiddleware;
    const { nextCalled, captured } = await invoke(middleware, {}, null);
    assert.equal(nextCalled, false);
    assert.equal(captured.statusCode, 401);
  });

  console.log("\nAll Phase F2 Workflow Security checks passed.");
  console.log("§58 Security row status after this phase: PEP denial ✓, stale authorization ✓, privilege changes during waiting ✓, cross-organization access ✓, admin-only operations ✓ (PDP-level), event replay ✓ (Part A), workflow replay ✓ (Part F1).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ── Not covered here, and why ─────────────────────────────────────────────
 * - **Not executed live** — same constraint every phase in this session has
 *   disclosed (no installed `node_modules`, no reachable Postgres). Every
 *   case above was traced by hand against the current, real source of
 *   `authorization.ts`, `policy-engine.ts`, `organization-access-rule.ts`,
 *   and `pep/middleware.ts`'s `requireRole()` to confirm the exact code
 *   path each assertion exercises. Please run
 *   `npx tsx scripts/src/test-policy-security-workflow.ts` in a real
 *   environment and report back if any case doesn't match this analysis.
 * - **`runStep()`/`executeRun()`'s full DB-backed loop is not exercised** —
 *   see this file's header for why `authorizeWorkflowAction()` alone is
 *   the correct, non-weaker seam to test instead. A future phase with a
 *   reachable test database could add a true end-to-end run (start a
 *   definition with a step that calls `ctx.authorize()`, let it WAIT, flip
 *   the backing user's role in the DB, resume it, assert the resumed step
 *   sees the new role) — that would additionally prove `engine.ts`'s own
 *   wiring of the closure is correct, not just `authorizeWorkflowAction()`
 *   in isolation. Not attempted here (Rule 16 — do not implement future
 *   phases prematurely; this phase has no DB to run it against regardless).
 * - **`replayRun()`/`cancelRun()` (workflow/event replay) are not
 *   re-tested** — both are real `@workspace/db` (drizzle) functions with
 *   no mockable seam the way `ownership-route-test-kit.ts`'s resource
 *   builders have (a single `db.select(...).limit(1)` call each); replay/
 *   cancel touch `db.select`/`db.update`/`db.insert` across `run-store.ts`
 *   AND `definition-store.ts` in combination. F1's own "Verified by hand"
 *   section already traced `REPLAYABLE_STATUSES`/the cancellable-status
 *   guard against `state-machine.ts`'s real `RUN_TRANSITIONS` line by
 *   line; this phase re-confirms that trace is still accurate (no code in
 *   either file changed since F1) rather than duplicating it, and does not
 *   claim a NEW, executable proof for either — same honest distinction F1
 *   itself already draws between "verified by hand" and "actually run".
 * - **"admin-only operations" stops at the PDP role-gate, not the full
 *   `requireDev` token/DB prelude** — see that section's own header above
 *   for the exact scope line and why extending it further is a generic
 *   `middlewares/auth.ts` concern, not a Mega Engine one.
 */
