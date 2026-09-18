/**
 * routes/admin-policy-console.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23A (Admin Policy
 * Console — Policies section) + Phase 23B (Admin Policy Console — Policy
 * Versions section).
 *
 * Every handler below is pure composition — resolve an actor, call one
 * `lib/policy-admin-console.ts` function, map its
 * `PolicyAdminConsoleResult` onto an HTTP response — same "route composes,
 * lib validates + persists" split `routes/admin-oidc-clients.ts` already
 * establishes for the OIDC admin surface. No handler here touches
 * `PolicyRegistry`, a registry error class, or zod directly; all of that
 * is `lib/policy-admin-console.ts`'s job (see that file's own header).
 *
 * `GET /admin/policies` (23A) — the Policies section's list view: one row
 * per policyId, latest version, optionally narrowed by
 * `?application=`/`?resource=`/`?status=` query params.
 *
 * `GET /admin/policies/:policyId` (23A) — a single policy's latest-version
 * detail, including its `rules` DSL source (the list view above
 * deliberately omits that — see `lib/policy-admin-console.ts`'s own
 * "Serialization" section for why).
 *
 * `POST /admin/policies` (23A) — create version 1 of a brand-new policy,
 * status DRAFT.
 *
 * `POST /admin/policies/:policyId/versions` (23A) — create the next
 * version (latest + 1) of an EXISTING policy, status DRAFT.
 *
 * `GET /admin/policies/:policyId/versions` (23B) — the Policy Versions
 * section's own list view: every version on file for one policyId,
 * newest first.
 *
 * `GET /admin/policies/:policyId/versions/:version` (23B) — one specific
 * version's full detail.
 *
 * `PATCH /admin/policies/:policyId/versions/:version/status` (23B) —
 * advance (or retreat) one version's status through
 * `registry/lifecycle.ts`'s graph. Body: `{ "status": "<PolicyStatus>" }`.
 * Every legality/authorization/maker-checker/assurance rule is
 * `PolicyRegistry.transitionStatus()`'s own job — this route only forwards
 * the request and reports whichever check rejected it.
 *
 * `POST /admin/policies/:policyId/rollback` (23B) — the Policy Versions
 * section's "rollback" action. Body: `{ "toVersion": <number> }`. See
 * `lib/policy-admin-console.ts`'s own header for why this creates a fresh
 * DRAFT version from `toVersion`'s content rather than reactivating old
 * history, and for the documented gap around this action's audit-log
 * shape — which is exactly why this handler ALSO emits the
 * `policy_admin.policy_rolled_back` structured log line below, naming the
 * source version, so an operator reading application logs (not just the
 * DB audit table) can still tell a rollback apart from an organically
 * authored new version.
 *
 * AUTH: `requireDev` on every route below — same tier
 * `routes/admin-oidc-clients.ts` and `routes/admin-wallet.ts` already use
 * for an internal operator surface never called by an end-user client.
 * `requireDev` alone does not decide WHO may manage/approve policies
 * specifically — that is `admin.policy.manage`/`admin.policy.approve`
 * (RBAC), enforced inside `lib/policy-admin-console.ts`/`PolicyRegistry`
 * itself. `requireDev` here is only the outer "must be a real operator
 * session at all" gate every admin route in this codebase already shares.
 *
 * ROUTE INTEGRATION ROADMAP — SEASON B, PHASE B3 (dogfooding): the
 * paragraph above was accurate the day it was written, but "enforced
 * inside `lib/policy-admin-console.ts`" never meant "enforced by the PDP"
 * — `RbacPolicyAdminAuthorizer` (`lib/policy/registry/authorizer.ts`)
 * reuses `resolveEffectivePermissions()`/`permissionMatches()` directly,
 * never `PolicyEngine.evaluate()`. This console — the one that manages
 * the Policy & Authorization Mega Engine itself — has therefore never
 * generated a `Decision`/`requestId`, never landed a row in
 * `authorization_audit_log`, and never counted in
 * `routes/authorization-telemetry.ts`'s own dashboards, unlike every
 * route Season A/B1 already migrated. `requirePolicyAdminPepAccess` below
 * closes that gap: a SECOND, additive, PDP-routed check — same
 * "hand-written check keeps working, PDP check adds observability"
 * posture Phase B1 established for Finance ownership — asking the PDP the
 * EXACT SAME "manage OR approve" question `assertCanViewPolicies()`
 * already asks of `PolicyRegistry` on every route below (never the
 * dynamic manage-vs-approve-by-target-status split
 * `PolicyRegistry.transitionStatus()` alone still owns — see
 * `createAnyPermissionRule()`'s own header for why a coarser "is this
 * actor even eligible for this console" gate is what the PEP layer
 * asks, not a duplicate of the registry's own finer-grained lifecycle
 * rules). See `CHANGES_ROUTE_INTEGRATION_PHASE_B3.md`.
 *
 * MOUNTING: through `routes/index.ts`, right next to
 * `adminOidcClientsRouter` — see that file's own mounting note for the
 * precedent this follows.
 */
import { Router, type IRouter } from "express";
import { requireDev, getPepRbacProvider, pepDecisionObserver } from "../middlewares/auth";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createAnyPermissionRule } from "../lib/policy/rbac";
import { requirePolicy } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { POLICY_MANAGE_PERMISSION, POLICY_APPROVE_PERMISSION } from "../lib/policy/registry/authorizer";
import {
  buildActorForPolicyAdminRequest,
  listPoliciesForAdmin,
  getPolicyForAdmin,
  createPolicyForAdmin,
  createPolicyVersionForAdmin,
  listPolicyVersionsForAdmin,
  getPolicyVersionForAdmin,
  transitionPolicyStatusForAdmin,
  rollbackPolicyVersionForAdmin,
  type PolicyAdminConsoleFailure,
} from "../lib/policy-admin-console";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Phase B3: PEP-level "is this actor eligible for the Policy Admin
//    Console at all" gate ───────────────────────────────────────────────
// One throwaway `PolicyEngine` (same "cheap, stateless, build it once at
// module load" posture `adminRoleCheck`/`devRoleCheck` in
// `middlewares/auth.ts` already apply), registering
// `createAnyPermissionRule()` against the SAME two permission constants
// `RbacPolicyAdminAuthorizer` already checks — imported, never
// re-typed as a string literal (Rule 4). `resource` names the policy this
// request concerns when a `:policyId` is present, for the audit
// row/explain surface; no route here has an owner to check, so this is
// informational, not an ownership gate.
const policyAdminResource: ResourceRefBuilder = (req) => ({
  type: "admin.policy",
  id: typeof req.params.policyId === "string" ? req.params.policyId : undefined,
});
const policyAdminAccessEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
policyAdminAccessEngine.registerRule(
  "policy-admin-access",
  createAnyPermissionRule(getPepRbacProvider(), [POLICY_MANAGE_PERMISSION, POLICY_APPROVE_PERMISSION]),
);
// `onDeny` reuses the EXACT `{ error: "forbidden", message }`, 403 shape
// `lib/policy-admin-console.ts`'s own `translateFailure()` already returns
// for a `PolicyAuthorizationError` (see that file's own `sendFailure()`
// helper below, which every route already renders through) — not
// `requireDev`'s unrelated `NOT_DEV` body, since this gate is answering a
// different question (permission, not role tier). Per migrations 096/099
// only 'admin' actually holds `admin.policy.manage`/`admin.policy.approve`
// today (via its pre-existing '*' wildcard) — a 'dev'-only caller was
// ALREADY denied this exact same way, one layer further in, by
// `PolicyRegistry` itself; this phase only moves that SAME denial one
// layer earlier (before any DB round-trip a route handler would have
// made) and, for the first time, runs it through the PDP so it gets a
// `requestId`/audit row/telemetry count. No caller who could reach a
// route below yesterday is denied today, and no caller denied yesterday
// is let through today.
const requirePolicyAdminPepAccess = requirePolicy(
  policyAdminAccessEngine,
  "pep.policy_admin.access_check",
  policyAdminResource,
  {
    onDeny: (_req, res) => {
      res.status(403).json({
        error: "forbidden",
        message: 'This action requires the "admin.policy.manage" or "admin.policy.approve" permission.',
      });
    },
  },
);

/** Every `PolicyAdminConsoleResult` failure already carries an HTTP
 *  `status` — this is the one place that turns it into an actual
 *  response, so every handler below stays a two-branch `if (!result.ok)`
 *  instead of repeating this shape at each call site. */
function sendFailure(res: import("express").Response, failure: PolicyAdminConsoleFailure): void {
  res.status(failure.status).json({ error: failure.error, message: failure.message, ...(failure.field ? { field: failure.field } : {}) });
}

/** `:version` route params are always digits in the URL — a non-numeric
 *  value is a caller/routing bug, not a legitimate "not found," so this
 *  is checked once here rather than duplicated in every handler that
 *  reads a `:version` param. */
function parseVersionParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// ── Phase 23A — Policies section ────────────────────────────────────────

// GET /admin/policies — list, optionally filtered by application/resource/status.
router.get("/admin/policies", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await listPoliciesForAdmin(actor, req.query);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ policies: result.policies });
});

// GET /admin/policies/:policyId — latest-version detail.
router.get("/admin/policies/:policyId", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const policyId = String(req.params.policyId ?? "").trim();
  if (!policyId) {
    res.status(400).json({ error: "invalid_request", message: "policyId is required", field: "policyId" });
    return;
  }
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await getPolicyForAdmin(actor, policyId);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ policy: result.policy });
});

// POST /admin/policies — create version 1 of a brand-new policy.
router.post("/admin/policies", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await createPolicyForAdmin(actor, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, policyId: result.policy.policyId }, "policy_admin.policy_created");
  res.status(201).json({ policy: result.policy });
});

// POST /admin/policies/:policyId/versions — create the next version.
router.post("/admin/policies/:policyId/versions", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const policyId = String(req.params.policyId ?? "").trim();
  if (!policyId) {
    res.status(400).json({ error: "invalid_request", message: "policyId is required", field: "policyId" });
    return;
  }
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await createPolicyVersionForAdmin(actor, policyId, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, policyId, version: result.policy.version }, "policy_admin.policy_version_created");
  res.status(201).json({ policy: result.policy });
});

// ── Phase 23B — Policy Versions section ─────────────────────────────────

// GET /admin/policies/:policyId/versions — every version, newest first.
router.get("/admin/policies/:policyId/versions", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const policyId = String(req.params.policyId ?? "").trim();
  if (!policyId) {
    res.status(400).json({ error: "invalid_request", message: "policyId is required", field: "policyId" });
    return;
  }
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await listPolicyVersionsForAdmin(actor, policyId);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ versions: result.versions });
});

// GET /admin/policies/:policyId/versions/:version — one version's detail.
router.get("/admin/policies/:policyId/versions/:version", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const policyId = String(req.params.policyId ?? "").trim();
  const version = parseVersionParam(String(req.params.version ?? ""));
  if (!policyId || version === null) {
    res.status(400).json({ error: "invalid_request", message: "policyId and a numeric version are required", field: version === null ? "version" : "policyId" });
    return;
  }
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await getPolicyVersionForAdmin(actor, policyId, version);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ policy: result.policy });
});

// PATCH /admin/policies/:policyId/versions/:version/status — lifecycle transition.
router.patch("/admin/policies/:policyId/versions/:version/status", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const policyId = String(req.params.policyId ?? "").trim();
  const version = parseVersionParam(String(req.params.version ?? ""));
  if (!policyId || version === null) {
    res.status(400).json({ error: "invalid_request", message: "policyId and a numeric version are required", field: version === null ? "version" : "policyId" });
    return;
  }
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await transitionPolicyStatusForAdmin(actor, policyId, version, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info(
    { actorId: req.user?.userId, policyId, version: result.policy.version, status: result.policy.status },
    "policy_admin.policy_status_changed",
  );
  res.json({ policy: result.policy });
});

// POST /admin/policies/:policyId/rollback — create a fresh DRAFT version
// seeded from an older version's content (see lib/policy-admin-console.ts's
// own header for why this is never a reactivation of old history).
router.post("/admin/policies/:policyId/rollback", requireDev, requirePolicyAdminPepAccess, async (req, res): Promise<void> => {
  const policyId = String(req.params.policyId ?? "").trim();
  if (!policyId) {
    res.status(400).json({ error: "invalid_request", message: "policyId is required", field: "policyId" });
    return;
  }
  const actor = await buildActorForPolicyAdminRequest(req.user);
  const result = await rollbackPolicyVersionForAdmin(actor, policyId, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  // See this file's own header + lib/policy-admin-console.ts's "KNOWN
  // LIMITATION" note: the DB audit row this produced is a plain
  // policy_version_created entry, indistinguishable from a hand-authored
  // version. This structured log line is the one place "this was a
  // rollback, from version N" is recorded at all today.
  logger.info(
    { actorId: req.user?.userId, policyId, rolledBackFrom: result.rolledBackFrom, newVersion: result.policy.version },
    "policy_admin.policy_rolled_back",
  );
  res.status(201).json({ policy: result.policy, rolledBackFrom: result.rolledBackFrom });
});

export default router;
