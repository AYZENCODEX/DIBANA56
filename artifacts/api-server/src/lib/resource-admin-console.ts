/**
 * lib/resource-admin-console.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * The "route composes, this lib validates + persists" service layer
 * `routes/admin-resource-console.ts` calls into — same split
 * `lib/policy-admin-console.ts` establishes for the Policies/Policy
 * Versions sections (23A/23B) and `lib/rbac-admin-console.ts` establishes
 * for the Roles/Permissions/Assignments sections (23C), applied here to
 * the Resources section instead. Request validation and orchestration
 * live in this one file — same reasoning as those two siblings' own
 * headers: the request shape this phase validates (a handful of scalar
 * fields describing one `resource_grants` tuple) is simple enough that a
 * sibling `-request.ts` file would only add an import boundary with
 * nothing on either side of it.
 *
 * ── WHAT THIS FILE OWNS THAT `ResourceAdminRegistry` DELIBERATELY DOES
 *    NOT ────────────────────────────────────────────────────────────────
 * `resource-admin/resource-admin-registry.ts`'s own read methods
 * (`listResourceGrants`/`listGrantsForSubject`/`listGrantsForResource`)
 * are NOT actor-gated — same "the route layer in front of this decides
 * who may reach these methods at all" posture `lib/rbac-admin-console.ts`
 * and `lib/policy-admin-console.ts` both document for their own read
 * methods. THIS file is that route layer's service half: every exported
 * `list*`/`get*` function below first resolves a `ResourceAdminActor` and
 * asserts it holds `admin.resource.manage` (`assertCanViewResourceAdmin()`
 * below) before returning anything. Unlike `lib/rbac-admin-console.ts`'s
 * own read gate (which tries two permissions, "manage OR assign", because
 * RBAC-admin actually splits into two), this module has exactly one
 * permission (see resource-admin/types.ts's own header for why), so the
 * read gate is a single, un-forked check.
 *
 * ── ERROR TRANSLATION, NOT ERROR PROPAGATION ──────────────────────────────
 * Same shape `lib/rbac-admin-console.ts`'s own header documents:
 * `ResourceAdminRegistry` communicates failure by throwing one of the
 * typed error classes in `./policy/resource-admin/errors.ts`; every
 * function below catches those (plus zod validation failures) and returns
 * a plain discriminated `ResourceAdminConsoleResult<T>` instead of letting
 * the route layer `instanceof`-switch on a registry error itself.
 *
 * ── CONSTRUCTION ───────────────────────────────────────────────────────
 * `getResourceAdminRegistry()`/`getRbacProviderForResourceAdmin()` below
 * are the first real call sites that construct
 * `DrizzleResourceAdminProvider` — see that file's own header ("nothing
 * constructs this yet"). Both are lazily-constructed module-level
 * singletons, same lifetime/reuse posture `lib/rbac-admin-console.ts`'s
 * own singletons already take. This file constructs its OWN
 * `DrizzleRbacProvider` singleton rather than importing the one
 * `lib/rbac-admin-console.ts` (or `lib/policy-admin-console.ts`)
 * constructs — both are stateless wrappers around the same underlying
 * `@workspace/db` client, so a third instance costs nothing and keeps
 * this console module independently constructible (it imports neither of
 * its siblings).
 */

import { z } from "zod/v4";
import { DrizzleResourceAdminProvider } from "./policy/resource-admin/drizzle-resource-admin-provider";
import { DrizzleRbacProvider } from "./policy/rbac/drizzle-rbac-provider";
import {
  ResourceAdminRegistry,
  RbacResourceAdminAuthorizer,
  buildResourceAdminActor,
  ResourceGrantAlreadyExistsError,
  ResourceGrantNotFoundError,
  ResourceAdminAuthorizationError,
  ResourceAdminInsufficientAssuranceError,
  type ResourceAdminActor,
  type ResourceAdminAuthorizer,
  type ResourceGrantAdminRecord,
} from "./policy/resource-admin";
import { subjectFromAuthUser, type AuthenticatedUserLike } from "./policy/pip/subject-adapter";
import type { RbacProvider } from "./policy/rbac/types";

// ── Construction (lazy singletons — see file header) ───────────────────────

let rbacProviderSingleton: RbacProvider | null = null;
function getRbacProviderForResourceAdmin(): RbacProvider {
  if (!rbacProviderSingleton) rbacProviderSingleton = new DrizzleRbacProvider();
  return rbacProviderSingleton;
}

let resourceAdminAuthorizerSingleton: ResourceAdminAuthorizer | null = null;
function resourceAdminAuthorizer(): ResourceAdminAuthorizer {
  if (!resourceAdminAuthorizerSingleton) {
    resourceAdminAuthorizerSingleton = new RbacResourceAdminAuthorizer(getRbacProviderForResourceAdmin());
  }
  return resourceAdminAuthorizerSingleton;
}

let resourceAdminRegistrySingleton: ResourceAdminRegistry | null = null;
function getResourceAdminRegistry(): ResourceAdminRegistry {
  if (!resourceAdminRegistrySingleton) {
    resourceAdminRegistrySingleton = new ResourceAdminRegistry(new DrizzleResourceAdminProvider(), resourceAdminAuthorizer());
  }
  return resourceAdminRegistrySingleton;
}

/** Same "no authenticated caller → null actor, never skip the check"
 *  convention `buildActorForRbacAdminRequest()` establishes. */
export async function buildActorForResourceAdminRequest(user: AuthenticatedUserLike | null | undefined): Promise<ResourceAdminActor | null> {
  const subject = subjectFromAuthUser(user);
  if (!subject) return null;
  return buildResourceAdminActor(subject, getRbacProviderForResourceAdmin());
}

/** Read gate for every list/get function below. One permission, so —
 *  unlike `assertCanViewRbacAdmin()`'s two-permission fallthrough in
 *  `lib/rbac-admin-console.ts` — this is a single un-forked check. Thrown
 *  failures are translated by the caller via `translateResourceAdminError()`,
 *  same as every other registry call in this file. */
async function assertCanViewResourceAdmin(actor: ResourceAdminActor): Promise<void> {
  await resourceAdminAuthorizer().assertCanManageResourceGrants(actor);
}

// ── Result shape ─────────────────────────────────────────────────────────

export type ResourceAdminConsoleErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "already_exists"
  | "invalid_request"
  | "insufficient_assurance"
  | "internal_error";

export interface ResourceAdminConsoleFailure {
  ok: false;
  status: number;
  error: ResourceAdminConsoleErrorCode;
  message: string;
  field?: string;
}

export type ResourceAdminConsoleResult<T> = ({ ok: true } & T) | ResourceAdminConsoleFailure;

function unauthenticated(): ResourceAdminConsoleFailure {
  return { ok: false, status: 401, error: "unauthenticated", message: "This action requires an authenticated caller." };
}

/** The one place every thrown `ResourceAdminRegistry` error becomes an
 *  HTTP-ready result — same "error translation, not propagation" posture
 *  `lib/rbac-admin-console.ts`'s own `translateRbacAdminError()`
 *  establishes. A class NOT in this list is a genuine bug, not a
 *  caller-facing condition, so it falls into `internal_error`. */
function translateResourceAdminError(err: unknown): ResourceAdminConsoleFailure {
  if (err instanceof ResourceGrantAlreadyExistsError) {
    return { ok: false, status: 409, error: "already_exists", message: err.message };
  }
  if (err instanceof ResourceGrantNotFoundError) {
    return { ok: false, status: 404, error: "not_found", message: err.message };
  }
  if (err instanceof ResourceAdminInsufficientAssuranceError) {
    return { ok: false, status: 403, error: "insufficient_assurance", message: err.message };
  }
  if (err instanceof ResourceAdminAuthorizationError) {
    return { ok: false, status: 403, error: "forbidden", message: err.message };
  }
  return {
    ok: false,
    status: 500,
    error: "internal_error",
    message: err instanceof Error ? err.message : "Unexpected resource-admin error.",
  };
}

// ── Request validation (zod) ────────────────────────────────────────────
//
// Same field set `lib/db/src/schema/resource-grants.ts`'s own insert
// schema already enforces at the DB-insert layer — duplicated here
// deliberately, not imported from there, same reasoning
// `lib/rbac-admin-console.ts`'s own header gives for its body schemas.

const newResourceGrantBodySchema = z.object({
  subjectUserId: z.number().int().positive(),
  resourceType: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(500),
  action: z.string().min(1).max(200),
  effect: z.enum(["allow", "deny"]),
  reason: z.string().max(2000).optional().nullable(),
});

function invalidRequestFromZod(result: z.ZodSafeParseError<unknown>): ResourceAdminConsoleFailure {
  const first = result.error.issues[0];
  return {
    ok: false,
    status: 400,
    error: "invalid_request",
    message: first?.message ?? "Invalid request.",
    field: first?.path?.length ? first.path.join(".") : undefined,
  };
}

// ── Serialization ────────────────────────────────────────────────────────

export interface ResourceGrantAdminView {
  id: number;
  subjectUserId: number;
  resourceType: string;
  resourceId: string;
  action: string;
  effect: "allow" | "deny";
  grantedBy: number | null;
  reason: string | null;
  createdAt: string;
}

function toResourceGrantAdminView(record: ResourceGrantAdminRecord): ResourceGrantAdminView {
  return {
    id: record.id,
    subjectUserId: record.subjectUserId,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    action: record.action,
    effect: record.effect,
    grantedBy: record.grantedBy,
    reason: record.reason,
    createdAt: record.createdAt.toISOString(),
  };
}

// ── Resources section ────────────────────────────────────────────────────

/** `GET /admin/resource-grants` — every explicit grant/deny entry on
 *  file, across every subject and resource. */
export async function listResourceGrantsForAdmin(actor: ResourceAdminActor | null): Promise<ResourceAdminConsoleResult<{ grants: ResourceGrantAdminView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewResourceAdmin(actor);
  } catch (err) {
    return translateResourceAdminError(err);
  }
  const records = await getResourceAdminRegistry().listResourceGrants();
  return { ok: true, grants: records.map(toResourceGrantAdminView) };
}

/** `GET /admin/users/:userId/resource-grants` — every grant directly held
 *  by one subject, across every resource. */
export async function listGrantsForSubjectForAdmin(
  actor: ResourceAdminActor | null,
  subjectUserId: number,
): Promise<ResourceAdminConsoleResult<{ grants: ResourceGrantAdminView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewResourceAdmin(actor);
  } catch (err) {
    return translateResourceAdminError(err);
  }
  const records = await getResourceAdminRegistry().listGrantsForSubject(subjectUserId);
  return { ok: true, grants: records.map(toResourceGrantAdminView) };
}

/** `GET /admin/resources/:resourceType/:resourceId/grants` — every grant
 *  on file for one concrete resource instance, across every subject —
 *  the "who can/can't touch THIS row" view. */
export async function listGrantsForResourceForAdmin(
  actor: ResourceAdminActor | null,
  resourceType: string,
  resourceId: string,
): Promise<ResourceAdminConsoleResult<{ grants: ResourceGrantAdminView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewResourceAdmin(actor);
  } catch (err) {
    return translateResourceAdminError(err);
  }
  const records = await getResourceAdminRegistry().listGrantsForResource(resourceType, resourceId);
  return { ok: true, grants: records.map(toResourceGrantAdminView) };
}

/** `GET /admin/resource-grants/:userId/:resourceType/:resourceId/:action`
 *  — the one row (if any) for a fully-specified tuple. */
export async function getResourceGrantForAdmin(
  actor: ResourceAdminActor | null,
  subjectUserId: number,
  resourceType: string,
  resourceId: string,
  action: string,
): Promise<ResourceAdminConsoleResult<{ grant: ResourceGrantAdminView }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewResourceAdmin(actor);
  } catch (err) {
    return translateResourceAdminError(err);
  }
  const record = await getResourceAdminRegistry().getResourceGrant(subjectUserId, resourceType, resourceId, action);
  if (!record) {
    return {
      ok: false,
      status: 404,
      error: "not_found",
      message: `Subject ${subjectUserId} has no explicit grant/deny entry for ${resourceType}:${resourceId} action "${action}".`,
    };
  }
  return { ok: true, grant: toResourceGrantAdminView(record) };
}

/** `POST /admin/resource-grants` — create a new explicit grant/deny
 *  entry. Requires `admin.resource.manage` AND, when `effect === "allow"`,
 *  strong assurance on the CALLER's own session — see
 *  `resource-admin-registry.ts`'s `createResourceGrant()` for the full
 *  allow/deny assurance asymmetry this enforces. */
export async function createResourceGrantForAdmin(
  actor: ResourceAdminActor | null,
  rawBody: unknown,
): Promise<ResourceAdminConsoleResult<{ grant: ResourceGrantAdminView }>> {
  if (!actor) return unauthenticated();
  const parsed = newResourceGrantBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const created = await getResourceAdminRegistry().createResourceGrant(actor, {
      subjectUserId: parsed.data.subjectUserId,
      resourceType: parsed.data.resourceType,
      resourceId: parsed.data.resourceId,
      action: parsed.data.action,
      effect: parsed.data.effect,
      reason: parsed.data.reason ?? null,
    });
    return { ok: true, grant: toResourceGrantAdminView(created) };
  } catch (err) {
    return translateResourceAdminError(err);
  }
}

/** `DELETE /admin/resource-grants/:userId/:resourceType/:resourceId/:action`
 *  — revoke the row for a fully-specified tuple. No assurance gate
 *  regardless of the removed row's effect — see
 *  `resource-admin-registry.ts`'s `revokeResourceGrant()` for why
 *  revoking either effect is the safe/non-escalating direction. */
export async function revokeResourceGrantForAdmin(
  actor: ResourceAdminActor | null,
  subjectUserId: number,
  resourceType: string,
  resourceId: string,
  action: string,
): Promise<ResourceAdminConsoleResult<Record<string, never>>> {
  if (!actor) return unauthenticated();
  try {
    await getResourceAdminRegistry().revokeResourceGrant(actor, subjectUserId, resourceType, resourceId, action);
    return { ok: true };
  } catch (err) {
    return translateResourceAdminError(err);
  }
}
