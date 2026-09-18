/**
 * lib/rbac-admin-console.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * The "route composes, this lib validates + persists" service layer
 * `routes/admin-rbac-console.ts` calls into — same split
 * `lib/policy-admin-console.ts` already establishes for the Policies/
 * Policy Versions sections (23A/23B), applied here to the Roles/
 * Permissions/Assignments sections instead. Request validation and
 * orchestration live in this one file, same reasoning as that sibling
 * file's own header: the request shapes this phase validates (a handful
 * of scalar fields) are simple enough that a sibling `-request.ts` file
 * would only add an import boundary with nothing on either side of it.
 *
 * ── WHAT THIS FILE OWNS THAT `RbacAdminRegistry` DELIBERATELY DOES NOT ────
 * `rbac-admin/rbac-admin-registry.ts`'s own read methods (`listRoles`/
 * `getRole`/`listPermissionCatalog`/`listRolePermissionGrants`/
 * `listUserRoleAssignments`) are NOT actor-gated — same "the route layer
 * in front of this is what decides who may reach these methods at all"
 * posture `lib/policy-admin-console.ts`'s own header documents for
 * `PolicyRegistry`'s reads. THIS file is that route layer's service half:
 * every exported function below that reads through `RbacAdminRegistry`
 * first resolves an `RbacAdminActor` and asserts it holds AT LEAST ONE of
 * `admin.role.manage`/`admin.role.assign` (`assertCanViewRbacAdmin()`
 * below) before returning anything. Writes defer entirely to
 * `RbacAdminRegistry`'s own authorization — this file does not duplicate
 * that check, only the read gate the registry explicitly declined to
 * enforce itself.
 *
 * ── ERROR TRANSLATION, NOT ERROR PROPAGATION ──────────────────────────────
 * Same shape `lib/policy-admin-console.ts`'s own header documents:
 * `RbacAdminRegistry` communicates failure by throwing one of the typed
 * error classes in `./policy/rbac-admin/errors.ts`; every function below
 * catches those (plus zod validation failures) and returns a plain
 * discriminated `RbacAdminConsoleResult<T>` instead of letting the route
 * layer `instanceof`-switch on a registry error itself.
 *
 * ── CONSTRUCTION ───────────────────────────────────────────────────────
 * `getRbacAdminRegistry()`/`getRbacProviderForRbacAdmin()` below are the
 * first real call sites that construct `DrizzleRbacAdminProvider` — see
 * that file's own header ("nothing constructs this yet"). Both are
 * lazily-constructed module-level singletons, same lifetime/reuse posture
 * `lib/policy-admin-console.ts`'s own singletons already take. Note this
 * file constructs its OWN `DrizzleRbacProvider` singleton rather than
 * importing the one `lib/policy-admin-console.ts` constructs — both are
 * stateless wrappers around the same underlying `@workspace/db` client, so
 * two instances cost nothing and keep these two console modules
 * independently constructible (neither imports the other).
 */

import { z } from "zod/v4";
import { DrizzleRbacAdminProvider } from "./policy/rbac-admin/drizzle-rbac-admin-provider";
import { DrizzleRbacProvider } from "./policy/rbac/drizzle-rbac-provider";
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
  type RbacAdminActor,
  type RbacAdminAuthorizer,
  type RoleAdminRecord,
  type PermissionCatalogRecord,
  type RolePermissionGrantRecord,
  type UserRoleAssignmentRecord,
} from "./policy/rbac-admin";
import { subjectFromAuthUser, type AuthenticatedUserLike } from "./policy/pip/subject-adapter";
import type { RbacProvider } from "./policy/rbac/types";

// ── Construction (lazy singletons — see file header) ───────────────────────

let rbacProviderSingleton: RbacProvider | null = null;
function getRbacProviderForRbacAdmin(): RbacProvider {
  if (!rbacProviderSingleton) rbacProviderSingleton = new DrizzleRbacProvider();
  return rbacProviderSingleton;
}

let rbacAdminRegistrySingleton: RbacAdminRegistry | null = null;
function getRbacAdminRegistry(): RbacAdminRegistry {
  if (!rbacAdminRegistrySingleton) {
    const authorizer: RbacAdminAuthorizer = new RbacRbacAdminAuthorizer(getRbacProviderForRbacAdmin());
    rbacAdminRegistrySingleton = new RbacAdminRegistry(new DrizzleRbacAdminProvider(), authorizer);
  }
  return rbacAdminRegistrySingleton;
}

/** Same "no authenticated caller → null actor, never skip the check"
 *  convention `buildActorForPolicyAdminRequest()` establishes. */
export async function buildActorForRbacAdminRequest(user: AuthenticatedUserLike | null | undefined): Promise<RbacAdminActor | null> {
  const subject = subjectFromAuthUser(user);
  if (!subject) return null;
  return buildRbacAdminActor(subject, getRbacProviderForRbacAdmin());
}

/** Read gate for every list/get function below — "manage OR assign", same
 *  try-then-fall-through shape `assertCanViewPolicies()` uses in
 *  lib/policy-admin-console.ts. */
async function assertCanViewRbacAdmin(actor: RbacAdminActor, authorizer: RbacAdminAuthorizer): Promise<void> {
  try {
    await authorizer.assertCanManageRoles(actor);
    return;
  } catch {
    // Fall through — a manage-denial alone must not deny a viewer who
    // only holds the narrower assign permission.
  }
  await authorizer.assertCanAssignRoles(actor);
}

let viewAuthorizerSingleton: RbacAdminAuthorizer | null = null;
function viewAuthorizer(): RbacAdminAuthorizer {
  if (!viewAuthorizerSingleton) viewAuthorizerSingleton = new RbacRbacAdminAuthorizer(getRbacProviderForRbacAdmin());
  return viewAuthorizerSingleton;
}

// ── Result shape ─────────────────────────────────────────────────────────

export type RbacAdminConsoleErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "already_exists"
  | "invalid_request"
  | "invalid_permission_key"
  | "invalid_grant_pattern"
  | "system_role_immutable"
  | "role_in_use"
  | "role_hierarchy_cycle"
  | "insufficient_assurance"
  | "internal_error";

export interface RbacAdminConsoleFailure {
  ok: false;
  status: number;
  error: RbacAdminConsoleErrorCode;
  message: string;
  field?: string;
}

export type RbacAdminConsoleResult<T> = ({ ok: true } & T) | RbacAdminConsoleFailure;

function unauthenticated(): RbacAdminConsoleFailure {
  return { ok: false, status: 401, error: "unauthenticated", message: "This action requires an authenticated caller." };
}

/** The one place every thrown `RbacAdminRegistry` error becomes an
 *  HTTP-ready result — same "error translation, not propagation" posture
 *  `lib/policy-admin-console.ts`'s own `translateRegistryError()`
 *  establishes. A class NOT in this list is a genuine bug, not a
 *  caller-facing condition, so it falls into `internal_error`. */
function translateRbacAdminError(err: unknown): RbacAdminConsoleFailure {
  if (err instanceof RoleNotFoundError) {
    return { ok: false, status: 404, error: "not_found", message: err.message };
  }
  if (err instanceof RoleAlreadyExistsError) {
    return { ok: false, status: 409, error: "already_exists", message: err.message };
  }
  if (err instanceof SystemRoleImmutableError) {
    return { ok: false, status: 403, error: "system_role_immutable", message: err.message };
  }
  if (err instanceof RoleInUseError) {
    return { ok: false, status: 409, error: "role_in_use", message: err.message };
  }
  if (err instanceof RoleHierarchyCycleError) {
    return { ok: false, status: 409, error: "role_hierarchy_cycle", message: err.message };
  }
  if (err instanceof PermissionAlreadyExistsError) {
    return { ok: false, status: 409, error: "already_exists", message: err.message };
  }
  if (err instanceof InvalidPermissionKeyError) {
    return { ok: false, status: 400, error: "invalid_permission_key", message: err.message };
  }
  if (err instanceof InvalidGrantPatternError) {
    return { ok: false, status: 400, error: "invalid_grant_pattern", message: err.message };
  }
  if (err instanceof GrantAlreadyExistsError) {
    return { ok: false, status: 409, error: "already_exists", message: err.message };
  }
  if (err instanceof GrantNotFoundError) {
    return { ok: false, status: 404, error: "not_found", message: err.message };
  }
  if (err instanceof UserRoleAlreadyAssignedError) {
    return { ok: false, status: 409, error: "already_exists", message: err.message };
  }
  if (err instanceof UserRoleAssignmentNotFoundError) {
    return { ok: false, status: 404, error: "not_found", message: err.message };
  }
  if (err instanceof RbacAdminInsufficientAssuranceError) {
    return { ok: false, status: 403, error: "insufficient_assurance", message: err.message };
  }
  if (err instanceof RbacAdminAuthorizationError) {
    return { ok: false, status: 403, error: "forbidden", message: err.message };
  }
  return {
    ok: false,
    status: 500,
    error: "internal_error",
    message: err instanceof Error ? err.message : "Unexpected RBAC-admin error.",
  };
}

// ── Request validation (zod) ────────────────────────────────────────────
//
// Same field set/limits lib/db/src/schema/rbac.ts's own insert schemas
// already enforce at the DB-insert layer — duplicated here deliberately,
// not imported from there, same reasoning lib/policy-admin-console.ts's
// own header gives for its policy body schemas.

const ROLE_KEY_PATTERN = /^[a-z0-9_-]{1,64}$/;
const PERMISSION_KEY_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+){2}$/;

const newRoleBodySchema = z.object({
  key: z.string().min(1).max(64).regex(ROLE_KEY_PATTERN, "role key must be lowercase alphanumeric/-/_ (max 64 chars)"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  parentRoleKey: z.string().min(1).max(64).regex(ROLE_KEY_PATTERN).optional().nullable(),
});

const roleUpdateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  parentRoleKey: z.string().min(1).max(64).regex(ROLE_KEY_PATTERN).optional().nullable(),
});

const newPermissionBodySchema = z.object({
  key: z.string().min(1).max(128).regex(PERMISSION_KEY_PATTERN, "permission key must be a concrete product.resource.action string"),
  description: z.string().max(2000).optional().nullable(),
});

const grantPermissionBodySchema = z.object({
  permissionKey: z.string().min(1).max(128),
});

const assignRoleBodySchema = z.object({
  roleKey: z.string().min(1).max(64).regex(ROLE_KEY_PATTERN),
  reason: z.string().max(2000).optional().nullable(),
});

function invalidRequestFromZod(result: z.ZodSafeParseError<unknown>): RbacAdminConsoleFailure {
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

export interface RoleAdminView {
  key: string;
  name: string;
  description: string | null;
  parentRoleKey: string | null;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

function toRoleAdminView(record: RoleAdminRecord): RoleAdminView {
  return {
    key: record.key,
    name: record.name,
    description: record.description,
    parentRoleKey: record.parentRoleKey,
    isSystem: record.isSystem,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface PermissionCatalogView {
  key: string;
  description: string | null;
  createdAt: string;
}

function toPermissionCatalogView(record: PermissionCatalogRecord): PermissionCatalogView {
  return { key: record.key, description: record.description, createdAt: record.createdAt.toISOString() };
}

export interface RolePermissionGrantView {
  permissionKey: string;
  createdAt: string;
}

function toRolePermissionGrantView(record: RolePermissionGrantRecord): RolePermissionGrantView {
  return { permissionKey: record.permissionKey, createdAt: record.createdAt.toISOString() };
}

export interface UserRoleAssignmentView {
  userId: number;
  roleKey: string;
  grantedBy: number | null;
  reason: string | null;
  createdAt: string;
}

function toUserRoleAssignmentView(record: UserRoleAssignmentRecord): UserRoleAssignmentView {
  return {
    userId: record.userId,
    roleKey: record.roleKey,
    grantedBy: record.grantedBy,
    reason: record.reason,
    createdAt: record.createdAt.toISOString(),
  };
}

// ── Roles section ────────────────────────────────────────────────────────

/** `GET /admin/roles` — every role on file. */
export async function listRolesForAdmin(actor: RbacAdminActor | null): Promise<RbacAdminConsoleResult<{ roles: RoleAdminView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewRbacAdmin(actor, viewAuthorizer());
  } catch (err) {
    return translateRbacAdminError(err);
  }
  const records = await getRbacAdminRegistry().listRoles();
  return { ok: true, roles: records.map(toRoleAdminView) };
}

/** `GET /admin/roles/:roleKey` — one role's detail, including its own
 *  DIRECT permission grants (never its inherited ones — see
 *  ../rbac/role-resolver.ts for where inheritance is resolved, which this
 *  admin view deliberately does not duplicate). */
export async function getRoleForAdmin(
  actor: RbacAdminActor | null,
  roleKey: string,
): Promise<RbacAdminConsoleResult<{ role: RoleAdminView; grants: RolePermissionGrantView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewRbacAdmin(actor, viewAuthorizer());
  } catch (err) {
    return translateRbacAdminError(err);
  }
  const registry = getRbacAdminRegistry();
  const record = await registry.getRole(roleKey);
  if (!record) {
    return { ok: false, status: 404, error: "not_found", message: `No role registered with key "${roleKey}".` };
  }
  const grants = await registry.listRolePermissionGrants(roleKey);
  return { ok: true, role: toRoleAdminView(record), grants: grants.map(toRolePermissionGrantView) };
}

/** `POST /admin/roles` — create a new, always non-system role. */
export async function createRoleForAdmin(actor: RbacAdminActor | null, rawBody: unknown): Promise<RbacAdminConsoleResult<{ role: RoleAdminView }>> {
  if (!actor) return unauthenticated();
  const parsed = newRoleBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const created = await getRbacAdminRegistry().createRole(actor, parsed.data);
    return { ok: true, role: toRoleAdminView(created) };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

/** `PATCH /admin/roles/:roleKey` — update name/description/parentRoleKey
 *  on an existing, non-system role. */
export async function updateRoleForAdmin(
  actor: RbacAdminActor | null,
  roleKey: string,
  rawBody: unknown,
): Promise<RbacAdminConsoleResult<{ role: RoleAdminView }>> {
  if (!actor) return unauthenticated();
  const parsed = roleUpdateBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const updated = await getRbacAdminRegistry().updateRole(actor, roleKey, parsed.data);
    return { ok: true, role: toRoleAdminView(updated) };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

/** `DELETE /admin/roles/:roleKey` — delete a non-system role with no
 *  remaining dependents. */
export async function deleteRoleForAdmin(actor: RbacAdminActor | null, roleKey: string): Promise<RbacAdminConsoleResult<Record<string, never>>> {
  if (!actor) return unauthenticated();
  try {
    await getRbacAdminRegistry().deleteRole(actor, roleKey);
    return { ok: true };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

// ── Permissions section ─────────────────────────────────────────────────

/** `GET /admin/permissions` — the full documentation-only catalog. */
export async function listPermissionsForAdmin(actor: RbacAdminActor | null): Promise<RbacAdminConsoleResult<{ permissions: PermissionCatalogView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewRbacAdmin(actor, viewAuthorizer());
  } catch (err) {
    return translateRbacAdminError(err);
  }
  const records = await getRbacAdminRegistry().listPermissionCatalog();
  return { ok: true, permissions: records.map(toPermissionCatalogView) };
}

/** `POST /admin/permissions` — add a new catalog entry (documentation
 *  only — see rbac-admin/types.ts's own header; grants nothing by
 *  itself). */
export async function createPermissionForAdmin(
  actor: RbacAdminActor | null,
  rawBody: unknown,
): Promise<RbacAdminConsoleResult<{ permission: PermissionCatalogView }>> {
  if (!actor) return unauthenticated();
  const parsed = newPermissionBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const created = await getRbacAdminRegistry().createPermissionCatalogEntry(actor, parsed.data);
    return { ok: true, permission: toPermissionCatalogView(created) };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

/** `POST /admin/roles/:roleKey/permissions` — attach a grant pattern
 *  (concrete key or trailing-wildcard) to a role. */
export async function grantPermissionForAdmin(
  actor: RbacAdminActor | null,
  roleKey: string,
  rawBody: unknown,
): Promise<RbacAdminConsoleResult<{ grant: RolePermissionGrantView }>> {
  if (!actor) return unauthenticated();
  const parsed = grantPermissionBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const created = await getRbacAdminRegistry().grantPermissionToRole(actor, roleKey, parsed.data.permissionKey);
    return { ok: true, grant: toRolePermissionGrantView(created) };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

/** `DELETE /admin/roles/:roleKey/permissions/:permissionKey` — detach a
 *  direct grant from a role. */
export async function revokePermissionForAdmin(
  actor: RbacAdminActor | null,
  roleKey: string,
  permissionKey: string,
): Promise<RbacAdminConsoleResult<Record<string, never>>> {
  if (!actor) return unauthenticated();
  try {
    await getRbacAdminRegistry().revokePermissionFromRole(actor, roleKey, permissionKey);
    return { ok: true };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

// ── Assignments section ─────────────────────────────────────────────────

/** `GET /admin/users/:userId/roles` — every role directly assigned to a
 *  user (never their IMPLICIT legacy-role membership — see
 *  ../rbac/legacy-role-map.ts — which has no `user_roles` row to list). */
export async function listUserRoleAssignmentsForAdmin(
  actor: RbacAdminActor | null,
  userId: number,
): Promise<RbacAdminConsoleResult<{ assignments: UserRoleAssignmentView[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewRbacAdmin(actor, viewAuthorizer());
  } catch (err) {
    return translateRbacAdminError(err);
  }
  const records = await getRbacAdminRegistry().listUserRoleAssignments(userId);
  return { ok: true, assignments: records.map(toUserRoleAssignmentView) };
}

/** `POST /admin/users/:userId/roles` — grant a role to a user. Requires
 *  `admin.role.assign` AND strong assurance on the CALLER's own session
 *  (see rbac-admin-registry.ts's `assignRoleToUser()` for why). */
export async function assignRoleForAdmin(
  actor: RbacAdminActor | null,
  userId: number,
  rawBody: unknown,
): Promise<RbacAdminConsoleResult<{ assignment: UserRoleAssignmentView }>> {
  if (!actor) return unauthenticated();
  const parsed = assignRoleBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const created = await getRbacAdminRegistry().assignRoleToUser(actor, userId, parsed.data.roleKey, parsed.data.reason ?? null);
    return { ok: true, assignment: toUserRoleAssignmentView(created) };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}

/** `DELETE /admin/users/:userId/roles/:roleKey` — revoke a role from a
 *  user. No assurance gate — see rbac-admin-registry.ts's
 *  `revokeRoleFromUser()` for why revoking is deliberately not gated the
 *  same way granting is. */
export async function revokeRoleForAdmin(
  actor: RbacAdminActor | null,
  userId: number,
  roleKey: string,
): Promise<RbacAdminConsoleResult<Record<string, never>>> {
  if (!actor) return unauthenticated();
  try {
    await getRbacAdminRegistry().revokeRoleFromUser(actor, userId, roleKey);
    return { ok: true };
  } catch (err) {
    return translateRbacAdminError(err);
  }
}
