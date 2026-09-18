/**
 * lib/policy/resource-admin/errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * Distinct error classes so a caller (`lib/resource-admin-console.ts`)
 * can tell WHY a mutation was rejected without parsing a message string —
 * same posture ../registry/errors.ts and ../rbac-admin/errors.ts already
 * established for their own admin surfaces.
 */

/** Thrown by `ResourceAdminRegistry.createResourceGrant()` when the
 *  (`subjectUserId`, `resourceType`, `resourceId`, `action`) tuple
 *  already has a row — of EITHER effect. `resource_grants`' own unique
 *  index (migration 097) allows at most one row per tuple regardless of
 *  effect (see that table's own header: "a row can only ever mean one or
 *  the other for a given tuple anyway"), so changing an existing tuple's
 *  effect is always revoke-then-recreate, never an in-place update — this
 *  admin console does not offer a separate "update effect" mutation. */
export class ResourceGrantAlreadyExistsError extends Error {
  constructor(subjectUserId: number, resourceType: string, resourceId: string, action: string) {
    super(`Subject ${subjectUserId} already has an explicit grant/deny entry for ${resourceType}:${resourceId} action "${action}".`);
    this.name = "ResourceGrantAlreadyExistsError";
  }
}

/** Thrown by `ResourceAdminRegistry.revokeResourceGrant()` when no row
 *  exists for the given tuple. */
export class ResourceGrantNotFoundError extends Error {
  constructor(subjectUserId: number, resourceType: string, resourceId: string, action: string) {
    super(`Subject ${subjectUserId} has no explicit grant/deny entry for ${resourceType}:${resourceId} action "${action}".`);
    this.name = "ResourceGrantNotFoundError";
  }
}

/** Thrown when `actor` lacks `admin.resource.manage` (see authorizer.ts). */
export class ResourceAdminAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceAdminAuthorizationError";
  }
}

/** Thrown when `actor.assuranceMethods` does not include at least one
 *  strong-assurance method for creating an `effect: "allow"` grant — the
 *  same Rule-13 posture `RbacAdminInsufficientAssuranceError` already
 *  applies to assigning a role to a user. An explicit ALLOW is this
 *  module's one privilege-escalating direction (it is how a subject
 *  acquires access to one specific resource instance they would not
 *  otherwise have); creating a `deny` entry (a restriction) and revoking
 *  ANY entry (of either effect) never require this — see
 *  resource-admin-registry.ts's own header for the full reasoning. */
export class ResourceAdminInsufficientAssuranceError extends Error {
  constructor() {
    super('Creating an explicit "allow" resource grant requires a strong-assurance authentication method on this session.');
    this.name = "ResourceAdminInsufficientAssuranceError";
  }
}
