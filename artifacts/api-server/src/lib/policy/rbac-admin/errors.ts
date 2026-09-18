/**
 * lib/policy/rbac-admin/errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * Distinct error classes so a caller (`lib/rbac-admin-console.ts`) can
 * tell WHY a mutation was rejected without parsing a message string —
 * same posture ../registry/errors.ts already established for the
 * Policies/Policy Versions sections.
 */

export class RoleNotFoundError extends Error {
  constructor(roleKey: string) {
    super(`No role registered with key "${roleKey}".`);
    this.name = "RoleNotFoundError";
  }
}

export class RoleAlreadyExistsError extends Error {
  constructor(roleKey: string) {
    super(`A role with key "${roleKey}" already exists.`);
    this.name = "RoleAlreadyExistsError";
  }
}

/** Thrown by `RbacAdminRegistry.updateRole()`/`deleteRole()` for any of
 *  the three SYSTEM roles seeded by migration 096 ("user"/"dev"/"admin").
 *  These are AYZEN's own legacy-role hierarchy made machine-readable
 *  (see lib/db/src/schema/rbac.ts's header) — renaming, re-parenting, or
 *  deleting one here would silently change `middlewares/auth.ts`'s
 *  existing `requireDev`/`requireAdmin` semantics for every user in the
 *  system, which this admin console must never do. */
export class SystemRoleImmutableError extends Error {
  constructor(roleKey: string, action: "update" | "delete") {
    super(`Role "${roleKey}" is a system role and cannot be ${action === "update" ? "modified" : "deleted"} through this console.`);
    this.name = "SystemRoleImmutableError";
  }
}

/** Thrown by `deleteRole()` when the role still has real dependents —
 *  either a `user_roles` grant (deleting would silently revoke a real
 *  user's access with no audit trail describing why) or a child role
 *  whose `parentRoleKey` still points at it (deleting would silently
 *  orphan that child's inheritance chain — role-resolver.ts's own bounded
 *  BFS treats an orphaned reference as "stops here", not an error, but
 *  that is a fail-SAFE fallback for data already gone stale, not something
 *  this console should ever deliberately create). The caller's correct
 *  response is to first revoke every dependent assignment / re-parent
 *  every child role, never to force through. */
export class RoleInUseError extends Error {
  constructor(
    roleKey: string,
    readonly reason: "has_user_assignments" | "has_child_roles",
  ) {
    super(
      reason === "has_user_assignments"
        ? `Role "${roleKey}" is still assigned to one or more users — revoke every assignment before deleting it.`
        : `Role "${roleKey}" is still the parent of one or more other roles — re-parent them before deleting it.`,
    );
    this.name = "RoleInUseError";
  }
}

/** Thrown by `updateRole()` when a requested `parentRoleKey` change would
 *  make `roleKey` its own (possibly indirect) ancestor — role-resolver.ts's
 *  inheritance walk is cycle-SAFE (it stops rather than looping forever),
 *  but a cycle would still silently make that role's effective-permission
 *  resolution stop early / behave unpredictably for every holder of it.
 *  This admin console refuses to ever write one, rather than relying on
 *  the resolver's defensive fallback to paper over it at evaluation time. */
export class RoleHierarchyCycleError extends Error {
  constructor(roleKey: string, parentRoleKey: string) {
    super(`Setting "${roleKey}"'s parent to "${parentRoleKey}" would create a role-inheritance cycle.`);
    this.name = "RoleHierarchyCycleError";
  }
}

export class PermissionAlreadyExistsError extends Error {
  constructor(key: string) {
    super(`A permission catalog entry with key "${key}" already exists.`);
    this.name = "PermissionAlreadyExistsError";
  }
}

/** Thrown when a supplied permission KEY (for a new catalog entry — a
 *  concrete `product.resource.action` string) fails
 *  `../rbac/permission-matcher.ts`'s `isValidPermissionKey()` check. The
 *  catalog never stores wildcards (see lib/db/src/schema/rbac.ts's own
 *  header) — use `InvalidGrantPatternError` below for a role GRANT, which
 *  may legitimately be a wildcard. */
export class InvalidPermissionKeyError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a valid concrete permission key (expected "product.resource.action", no wildcards).`);
    this.name = "InvalidPermissionKeyError";
  }
}

/** Thrown when a supplied GRANT pattern (attaching a permission to a
 *  role) fails `../rbac/permission-matcher.ts`'s `isValidGrantPattern()`
 *  check — e.g. a wildcard in a non-trailing segment. See that function's
 *  own header for the exact grammar this enforces; this admin console
 *  refuses to ever write a pattern the PDP's own RBAC rule would already
 *  treat as matching nothing (Rule 8: fail closed applies at write time
 *  too, not just at evaluation time). */
export class InvalidGrantPatternError extends Error {
  constructor(pattern: string) {
    super(`"${pattern}" is not a valid grant pattern (a wildcard may only appear as the trailing segment).`);
    this.name = "InvalidGrantPatternError";
  }
}

export class GrantAlreadyExistsError extends Error {
  constructor(roleKey: string, permissionKey: string) {
    super(`Role "${roleKey}" already has a direct grant for "${permissionKey}".`);
    this.name = "GrantAlreadyExistsError";
  }
}

export class GrantNotFoundError extends Error {
  constructor(roleKey: string, permissionKey: string) {
    super(`Role "${roleKey}" has no direct grant for "${permissionKey}".`);
    this.name = "GrantNotFoundError";
  }
}

export class UserRoleAlreadyAssignedError extends Error {
  constructor(userId: number, roleKey: string) {
    super(`User ${userId} already holds role "${roleKey}".`);
    this.name = "UserRoleAlreadyAssignedError";
  }
}

export class UserRoleAssignmentNotFoundError extends Error {
  constructor(userId: number, roleKey: string) {
    super(`User ${userId} does not hold role "${roleKey}".`);
    this.name = "UserRoleAssignmentNotFoundError";
  }
}

/** Thrown when `actor` lacks the required RBAC permission for the
 *  attempted RBAC-admin mutation/read (see authorizer.ts). */
export class RbacAdminAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RbacAdminAuthorizationError";
  }
}

/** Thrown when `actor.assuranceMethods` does not include at least one
 *  strong-assurance method for assigning a role to a user — the same
 *  Rule-13 posture `../registry/errors.ts`'s `InsufficientAssuranceError`
 *  already applies to activating a policy. Granting access is the
 *  sensitive direction; REVOKING a role never requires this (reducing
 *  someone's access is never the dangerous half of this operation — see
 *  `rbac-admin-registry.ts`'s `revokeRoleFromUser()` for why no assurance
 *  check gates it). */
export class RbacAdminInsufficientAssuranceError extends Error {
  constructor() {
    super("Assigning a role to a user requires a strong-assurance authentication method on this session.");
    this.name = "RbacAdminInsufficientAssuranceError";
  }
}
