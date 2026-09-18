/**
 * routes/admin-resource-console.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * Every handler below is pure composition — resolve an actor, call one
 * `lib/resource-admin-console.ts` function, map its
 * `ResourceAdminConsoleResult` onto an HTTP response — same "route
 * composes, lib validates + persists" split `routes/admin-rbac-console.ts`
 * and `routes/admin-policy-console.ts` already establish for their own
 * sections. No handler here touches `ResourceAdminRegistry`, a
 * `resource-admin/errors.ts` class, or zod directly; all of that is
 * `lib/resource-admin-console.ts`'s job (see that file's own header).
 *
 * `GET /admin/resource-grants` — every explicit grant/deny entry on file,
 * across every subject and resource.
 *
 * `GET /admin/users/:userId/resource-grants` — every grant directly held
 * by one subject, across every resource.
 *
 * `GET /admin/resources/:resourceType/:resourceId/grants` — every grant
 * on file for one concrete resource instance, across every subject.
 *
 * `GET /admin/resource-grants/:userId/:resourceType/:resourceId/:action`
 * — the one row (if any) for a fully-specified tuple.
 *
 * `POST /admin/resource-grants` — create a new explicit grant/deny entry.
 * Requires `admin.resource.manage` AND, when the body's `effect` is
 * `"allow"`, strong assurance on the CALLER's own session — see
 * `resource-admin-registry.ts`'s `createResourceGrant()` for the full
 * allow/deny assurance asymmetry this enforces.
 *
 * `DELETE /admin/resource-grants/:userId/:resourceType/:resourceId/:action`
 * — revoke the row for a fully-specified tuple. No assurance gate
 * regardless of the removed row's effect.
 *
 * AUTH: `requireDev` on every route below — same tier
 * `routes/admin-rbac-console.ts` and `routes/admin-policy-console.ts`
 * already use for an internal operator surface never called by an
 * end-user client. `requireDev` alone does not decide WHO may manage
 * resource grants specifically — that is `admin.resource.manage` (RBAC),
 * enforced inside `lib/resource-admin-console.ts`/`ResourceAdminRegistry`
 * itself. `requireDev` here is only the outer "must be a real operator
 * session at all" gate every admin route in this codebase already shares.
 *
 * ROUTE INTEGRATION ROADMAP — SEASON B, PHASE B3 (dogfooding): same gap,
 * same fix, as `routes/admin-policy-console.ts`'s own Phase B3 note —
 * `RbacResourceAdminAuthorizer` (`lib/policy/resource-admin/authorizer.ts`)
 * checks `admin.resource.manage` via `resolveEffectivePermissions()`
 * directly, never through the PDP. Unlike the Policy/RBAC consoles this
 * one has a SINGLE flat permission (no "manage OR X" split — see that
 * authorizer's own header), so `requirePermission()`'s own built-in sugar
 * fits directly; no `createAnyPermissionRule()` needed here. See
 * `CHANGES_ROUTE_INTEGRATION_PHASE_B3.md`.
 *
 * PATH-PARAM CAVEAT: `:resourceType`/`:resourceId`/`:action` are matched
 * as single URL path segments, same convention every other `:id`-style
 * param in this codebase already takes (e.g. `routes/ayzen-mailbox.ts`'s
 * own `:email` params) — a `resourceId` containing a literal `/` is not
 * addressable through these routes. Nothing in this phase's own data
 * (`resource_grants.resource_id` is free-form TEXT — see
 * `lib/db/src/schema/resource-grants.ts`'s own header) requires that
 * today; a future resource type that DOES need slash-bearing ids can
 * percent-encode them, same as any other REST API would ask a caller to.
 *
 * MOUNTING: through `routes/index.ts`, right next to
 * `adminRbacConsoleRouter` — see that file's own mounting note for the
 * precedent this follows.
 */
import { Router, type IRouter } from "express";
import { requireDev, getPepRbacProvider, pepDecisionObserver } from "../middlewares/auth";
import { requirePermission } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { RESOURCE_GRANT_MANAGE_PERMISSION } from "../lib/policy/resource-admin/authorizer";
import {
  buildActorForResourceAdminRequest,
  listResourceGrantsForAdmin,
  listGrantsForSubjectForAdmin,
  listGrantsForResourceForAdmin,
  getResourceGrantForAdmin,
  createResourceGrantForAdmin,
  revokeResourceGrantForAdmin,
  type ResourceAdminConsoleFailure,
} from "../lib/resource-admin-console";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Phase B3: PEP-level "is this actor eligible for the Resource Admin
//    Console at all" gate — single flat permission, so requirePermission()
//    directly (no createAnyPermissionRule() needed — see this file's own
//    header). `resource` names the grant tuple this request concerns when
//    those params are present. ───────────────────────────────────────────
const resourceAdminResource: ResourceRefBuilder = (req) => ({
  type: "admin.resource_grant",
  id: typeof req.params.resourceId === "string" ? req.params.resourceId : undefined,
});
// `onDeny` reuses the exact `{ error: "forbidden", message }`, 403 shape
// `lib/resource-admin-console.ts`'s own failure translation already
// returns for a `ResourceAdminAuthorizationError` — see
// admin-policy-console.ts's own comment for why this, not `requireDev`'s
// `NOT_DEV` body, and why this changes WHO is denied for nobody (only
// 'admin' holds `admin.resource.manage` today, per migration 105's seed —
// a 'dev'-only caller was already denied one layer further in).
const requireResourceAdminPepAccess = requirePermission(getPepRbacProvider(), RESOURCE_GRANT_MANAGE_PERMISSION, resourceAdminResource, {
  onDecision: pepDecisionObserver,
  onDeny: (_req, res) => {
    res.status(403).json({ error: "forbidden", message: 'This action requires the "admin.resource.manage" permission.' });
  },
});

/** Every `ResourceAdminConsoleResult` failure already carries an HTTP
 *  `status` — this is the one place that turns it into an actual
 *  response, so every handler below stays a two-branch `if (!result.ok)`
 *  instead of repeating this shape at each call site. Same helper
 *  `routes/admin-rbac-console.ts`'s own `sendFailure()` establishes. */
function sendFailure(res: import("express").Response, failure: ResourceAdminConsoleFailure): void {
  res.status(failure.status).json({ error: failure.error, message: failure.message, ...(failure.field ? { field: failure.field } : {}) });
}

/** `:userId` route params are always digits in the URL — a non-numeric
 *  value is a caller/routing bug, not a legitimate "not found," so this
 *  is checked once here rather than duplicated in every handler that
 *  reads a `:userId` param — same posture
 *  `routes/admin-rbac-console.ts`'s own `parseUserIdParam()` takes. */
function parseUserIdParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// GET /admin/resource-grants — every explicit grant/deny entry on file.
router.get("/admin/resource-grants", requireDev, requireResourceAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForResourceAdminRequest(req.user);
  const result = await listResourceGrantsForAdmin(actor);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ grants: result.grants });
});

// GET /admin/users/:userId/resource-grants — every grant directly held by
// one subject, across every resource.
router.get("/admin/users/:userId/resource-grants", requireDev, requireResourceAdminPepAccess, async (req, res): Promise<void> => {
  const userId = parseUserIdParam(String(req.params.userId ?? ""));
  if (userId === null) {
    res.status(400).json({ error: "invalid_request", message: "a numeric userId is required", field: "userId" });
    return;
  }
  const actor = await buildActorForResourceAdminRequest(req.user);
  const result = await listGrantsForSubjectForAdmin(actor, userId);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ grants: result.grants });
});

// GET /admin/resources/:resourceType/:resourceId/grants — every grant on
// file for one concrete resource instance, across every subject.
router.get("/admin/resources/:resourceType/:resourceId/grants", requireDev, requireResourceAdminPepAccess, async (req, res): Promise<void> => {
  const resourceType = String(req.params.resourceType ?? "").trim();
  const resourceId = String(req.params.resourceId ?? "").trim();
  if (!resourceType || !resourceId) {
    res.status(400).json({
      error: "invalid_request",
      message: "resourceType and resourceId are required",
      field: !resourceType ? "resourceType" : "resourceId",
    });
    return;
  }
  const actor = await buildActorForResourceAdminRequest(req.user);
  const result = await listGrantsForResourceForAdmin(actor, resourceType, resourceId);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ grants: result.grants });
});

// GET /admin/resource-grants/:userId/:resourceType/:resourceId/:action —
// the one row (if any) for a fully-specified tuple.
router.get("/admin/resource-grants/:userId/:resourceType/:resourceId/:action", requireDev, requireResourceAdminPepAccess, async (req, res): Promise<void> => {
  const userId = parseUserIdParam(String(req.params.userId ?? ""));
  const resourceType = String(req.params.resourceType ?? "").trim();
  const resourceId = String(req.params.resourceId ?? "").trim();
  const action = String(req.params.action ?? "").trim();
  if (userId === null || !resourceType || !resourceId || !action) {
    res.status(400).json({
      error: "invalid_request",
      message: "a numeric userId, resourceType, resourceId and action are required",
      field: userId === null ? "userId" : !resourceType ? "resourceType" : !resourceId ? "resourceId" : "action",
    });
    return;
  }
  const actor = await buildActorForResourceAdminRequest(req.user);
  const result = await getResourceGrantForAdmin(actor, userId, resourceType, resourceId, action);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json({ grant: result.grant });
});

// POST /admin/resource-grants — create a new explicit grant/deny entry.
router.post("/admin/resource-grants", requireDev, requireResourceAdminPepAccess, async (req, res): Promise<void> => {
  const actor = await buildActorForResourceAdminRequest(req.user);
  const result = await createResourceGrantForAdmin(actor, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info(
    {
      actorId: req.user?.userId,
      subjectUserId: result.grant.subjectUserId,
      resourceType: result.grant.resourceType,
      resourceId: result.grant.resourceId,
      action: result.grant.action,
      effect: result.grant.effect,
    },
    "resource_admin.grant_created",
  );
  res.status(201).json({ grant: result.grant });
});

// DELETE /admin/resource-grants/:userId/:resourceType/:resourceId/:action
// — revoke the row for a fully-specified tuple.
router.delete("/admin/resource-grants/:userId/:resourceType/:resourceId/:action", requireDev, requireResourceAdminPepAccess, async (req, res): Promise<void> => {
  const userId = parseUserIdParam(String(req.params.userId ?? ""));
  const resourceType = String(req.params.resourceType ?? "").trim();
  const resourceId = String(req.params.resourceId ?? "").trim();
  const action = String(req.params.action ?? "").trim();
  if (userId === null || !resourceType || !resourceId || !action) {
    res.status(400).json({
      error: "invalid_request",
      message: "a numeric userId, resourceType, resourceId and action are required",
      field: userId === null ? "userId" : !resourceType ? "resourceType" : !resourceId ? "resourceId" : "action",
    });
    return;
  }
  const actor = await buildActorForResourceAdminRequest(req.user);
  const result = await revokeResourceGrantForAdmin(actor, userId, resourceType, resourceId, action);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  logger.info({ actorId: req.user?.userId, subjectUserId: userId, resourceType, resourceId, action }, "resource_admin.grant_revoked");
  res.status(204).end();
});

export default router;
