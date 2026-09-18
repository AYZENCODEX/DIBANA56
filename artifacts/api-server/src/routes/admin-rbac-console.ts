/**
 * routes/admin-rbac-console.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * Every handler below is pure composition — resolve an actor, call one
 * `lib/rbac-admin-console.ts` function, map its `RbacAdminConsoleResult`
 * onto an HTTP response — same "route composes, lib validates + persists"
 * split `routes/admin-policy-console.ts` already establishes for the
 * Policies/Policy Versions sections. No handler here touches
 * `RbacAdminRegistry`, an `rbac-admin/errors.ts` class, or zod directly;
 * all of that is `lib/rbac-admin-console.ts`'s job (see that file's own
 * header).
 *
 * `GET /admin/roles` — the Roles section's list view: every role on file.
 *
 * `GET /admin/roles/:roleKey` — one role's detail, including its own
 * DIRECT permission grants (never its inherited ones).
 *
 * `POST /admin/roles` — create a new, always non-system role.
 *
 * `PATCH /admin/roles/:roleKey` — update name/description/parentRoleKey
 * on an existing, non-system role.
 *
 * `DELETE /admin/roles/:roleKey` — delete a non-system role with no
 * remaining dependents.
 *
 * `GET /admin/permissions` — the Permissions section's list view: the
 * full documentation-only catalog.
 *
 * `POST /admin/permissions` — add a new catalog entry.
 *
 * `POST /admin/roles/:roleKey/permissions` — attach a grant pattern
 * (concrete key or trailing-wildcard) to a role.
 *
 * `DELETE /admin/roles/:roleKey/permissions/:permissionKey` — detach a
 * direct grant from a role.
 *
 * `GET /admin/users/:userId/roles` — the Assignments section's list view:
 * every role directly assigned to a user.
 *
 * `POST /admin/users/:userId/roles` — grant a role to a user. Requires
 * `admin.role.assign` AND strong assurance on the CALLER's own session —
 * see `rbac-admin-registry.ts`'s `assignRoleToUser()` for why.
 *
 * `DELETE /admin/users/:userId/roles/:roleKey` — revoke a role from a
 * user. No assurance gate — see `rbac-admin-registry.ts`'s
 * `revokeRoleFromUser()` for why revoking is deliberately not gated the
 * same way granting is.
 *
 * AUTH: `requireDev` on every route below — same tier
 * `routes/admin-policy-console.ts` and `routes/admin-oidc-clients.ts`
 * already use for an internal operator surface never called by an
 * end-user client. `requireDev` alone does not decide WHO may manage
 * roles/permissions/assignments specifically — that is
 * `admin.role.manage`/`admin.role.assign` (RBAC), enforced inside
 * `lib/rbac-admin-console.ts`/`RbacAdminRegistry` itself. `requireDev`
 * here is only the outer "must be a real operator session at all" gate
 * every admin route in this codebase already shares.
 *
 * ROUTE INTEGRATION ROADMAP — SEASON B, PHASE B3 (dogfooding): same gap,
 * same fix, as `routes/admin-policy-console.ts`'s own Phase B3 note —
 * `RbacRbacAdminAuthorizer` (`lib/policy/rbac-admin/authorizer.ts`) checks
 * `admin.role.manage`/`admin.role.assign` via `resolveEffectivePermissions()`
 * directly, never through the PDP. `requireRbacAdminPepAccess` below adds
 * the same SECOND, additive, PDP-routed "manage OR assign" gate — see
 * `CHANGES_ROUTE_INTEGRATION_PHASE_B3.md`.
 *
 * MOUNTING: through `routes/index.ts`, right next to
 * `adminPolicyConsoleRouter` — see that file's own mounting note for the
 * precedent this follows.
 */
import { Router, type IRouter } from "express";
import { requireDev, getPepRbacProvider, pepDecisionObserver } from "../middlewares/auth";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createAnyPermissionRule } from "../lib/policy/rbac";
import { requirePolicy } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { ROLE_MANAGE_PERMISSION, ROLE_ASSIGN_PERMISSION } from "../lib/policy/rbac-admin/authorizer";
import {
  buildActorForRbacAdminRequest,
  listRolesForAdmin,
  getRoleForAdmin,
  createRoleForAdmin,
  updateRoleForAdmin,
  deleteRoleForAdmin,
  listPermissionsForAdmin,
  createPermissionForAdmin,
  grantPermissionForAdmin,
  revokePermissionForAdmin,
  listUserRoleAssignmentsForAdmin,
  assignRoleForAdmin,
  revokeRoleForAdmin,
  type RbacAdminConsoleFailure,
} from "../lib/rbac-admin-console";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Phase B3: PEP-level "is this actor eligible for the RBAC Admin
//    Console at all" gate — same shape as admin-policy-console.ts's own,
//    see that file's comment for the full rationale. `resource` names the
//    role this request concerns when a `:roleKey` is present. ──────────
const rbacAdminResource: ResourceRefBuilder = (req) => ({
  type: "admin.role",
  id: typeof req.params.roleKey === "string" ? req.params.roleKey : undefined,
});
const rbacAdminAccessEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
rbacAdminAccessEngine.registerRule(
  "rbac-admin-access",
  createAnyPermissionRule(getPepRbacProvider(), [ROLE_MANAGE_PERMISSION, ROLE_ASSIGN_PERMISSION]),
);
// `onDeny` reuses the exact `{ error: "forbidden", message }`, 403 shape
// `lib/rbac-admin-console.ts`'s own failure translation already returns
// for an `RbacAdminAuthorizationError` — see admin-policy-console.ts's
// own comment for why this, not `requireDev`'s `NOT_DEV` body, and why
// this changes WHO is denied for nobody (only 'admin' holds either
// permission today, per migration 104's seed — a 'dev'-only caller was
// already denied one layer further in).
const requireRbacAdminPepAccess = requirePolicy(rbacAdminAccessEngine, "pep.rbac_admin.access_check", rbacAdminResource, {
  onDeny: (_req, res) => {
    res.status(403).json({
      error: "forbidden",
      message: 'This action requires the "admin.role.manage" or "admin.role.assign" permission.',
    });
  },
});

/** Every `RbacAdminConsoleResult` failure already carries an HTTP
 *  `status` — this is the one place that turns it into an actual
 *  response, so every handler below stays a two-branch `if (!result.ok)`
 *  instead of repeating this shape at each call site. Same helper
 *  `routes/admin-policy-console.ts`'s own `sendFailure()` establishes. */
function sendFailure(res: import("express").Response, failure: RbacAdminConsoleFailure): void {
  res.status(failure.status).json({ error: failure.error, message: failure.message, ...(failure.field ? { field: failure.field } : {}) });
}

/** `:userId` route params are always digits in the URL — a non-numeric
 *  value is a caller/routing bug, not a legitimate "not found," so this
 *  is checked once here rather than duplicated in every handler that
 *  reads a `:userId` param — same posture
 *  `routes/admin-policy-console.ts`'s own `parseVersionParam()` takes for
 *  `:version`. */
function parseUserIdParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// ── Roles section ────────────────────────────────────────────────────────

// GET /admin/roles — every role on file.
router.get("/admin/roles", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await listRolesForAdmin(actor);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ roles: result.roles });
});

// GET /admin/roles/:roleKey — one role's detail + its own direct grants.
router.get("/admin/roles/:roleKey", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const roleKey = String(req.params.roleKey ?? "").trim();
  if (!roleKey) {
    res.status(400).json({ error: "invalid_request", message: "roleKey is required", field: "roleKey" });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await getRoleForAdmin(actor, roleKey);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ role: result.role, grants: result.grants });
});

// POST /admin/roles — create a new, always non-system role.
router.post("/admin/roles", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await createRoleForAdmin(actor, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, roleKey: result.role.key }, "rbac_admin.role_created");
  res.status(201).json({ role: result.role });
});

// PATCH /admin/roles/:roleKey — update name/description/parentRoleKey.
router.patch("/admin/roles/:roleKey", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const roleKey = String(req.params.roleKey ?? "").trim();
  if (!roleKey) {
    res.status(400).json({ error: "invalid_request", message: "roleKey is required", field: "roleKey" });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await updateRoleForAdmin(actor, roleKey, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, roleKey }, "rbac_admin.role_updated");
  res.json({ role: result.role });
});

// DELETE /admin/roles/:roleKey — delete a non-system role with no
// remaining dependents.
router.delete("/admin/roles/:roleKey", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const roleKey = String(req.params.roleKey ?? "").trim();
  if (!roleKey) {
    res.status(400).json({ error: "invalid_request", message: "roleKey is required", field: "roleKey" });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await deleteRoleForAdmin(actor, roleKey);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, roleKey }, "rbac_admin.role_deleted");
  res.status(204).end();
});

// ── Permissions section ─────────────────────────────────────────────────

// GET /admin/permissions — the full documentation-only catalog.
router.get("/admin/permissions", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await listPermissionsForAdmin(actor);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ permissions: result.permissions });
});

// POST /admin/permissions — add a new catalog entry.
router.post("/admin/permissions", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await createPermissionForAdmin(actor, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, permissionKey: result.permission.key }, "rbac_admin.permission_created");
  res.status(201).json({ permission: result.permission });
});

// POST /admin/roles/:roleKey/permissions — attach a grant pattern to a role.
router.post("/admin/roles/:roleKey/permissions", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const roleKey = String(req.params.roleKey ?? "").trim();
  if (!roleKey) {
    res.status(400).json({ error: "invalid_request", message: "roleKey is required", field: "roleKey" });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await grantPermissionForAdmin(actor, roleKey, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, roleKey, permissionKey: result.grant.permissionKey }, "rbac_admin.permission_granted");
  res.status(201).json({ grant: result.grant });
});

// DELETE /admin/roles/:roleKey/permissions/:permissionKey — detach a
// direct grant from a role.
router.delete("/admin/roles/:roleKey/permissions/:permissionKey", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const roleKey = String(req.params.roleKey ?? "").trim();
  const permissionKey = String(req.params.permissionKey ?? "").trim();
  if (!roleKey || !permissionKey) {
    res.status(400).json({
      error: "invalid_request",
      message: "roleKey and permissionKey are required",
      field: !roleKey ? "roleKey" : "permissionKey",
    });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await revokePermissionForAdmin(actor, roleKey, permissionKey);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, roleKey, permissionKey }, "rbac_admin.permission_revoked");
  res.status(204).end();
});

// ── Assignments section ─────────────────────────────────────────────────

// GET /admin/users/:userId/roles — every role directly assigned to a user.
router.get("/admin/users/:userId/roles", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const userId = parseUserIdParam(String(req.params.userId ?? ""));
  if (userId === null) {
    res.status(400).json({ error: "invalid_request", message: "a numeric userId is required", field: "userId" });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await listUserRoleAssignmentsForAdmin(actor, userId);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ assignments: result.assignments });
});

// POST /admin/users/:userId/roles — grant a role to a user. Requires
// admin.role.assign AND strong assurance on the caller's own session.
router.post("/admin/users/:userId/roles", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const userId = parseUserIdParam(String(req.params.userId ?? ""));
  if (userId === null) {
    res.status(400).json({ error: "invalid_request", message: "a numeric userId is required", field: "userId" });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await assignRoleForAdmin(actor, userId, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, userId, roleKey: result.assignment.roleKey }, "rbac_admin.user_role_assigned");
  res.status(201).json({ assignment: result.assignment });
});

// DELETE /admin/users/:userId/roles/:roleKey — revoke a role from a user.
// No assurance gate — see rbac-admin-registry.ts's revokeRoleFromUser()
// for why revoking is deliberately not gated the same way granting is.
router.delete("/admin/users/:userId/roles/:roleKey", requireDev, requireRbacAdminPepAccess, async (req, res): Promise<void> => {
  const userId = parseUserIdParam(String(req.params.userId ?? ""));
  const roleKey = String(req.params.roleKey ?? "").trim();
  if (userId === null || !roleKey) {
    res.status(400).json({
      error: "invalid_request",
      message: "a numeric userId and roleKey are required",
      field: userId === null ? "userId" : "roleKey",
    });
    return;
  }
  const actor = await buildActorForRbacAdminRequest(req.user);
  const result = await revokeRoleForAdmin(actor, userId, roleKey);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, userId, roleKey }, "rbac_admin.user_role_revoked");
  res.status(204).end();
});

export default router;
