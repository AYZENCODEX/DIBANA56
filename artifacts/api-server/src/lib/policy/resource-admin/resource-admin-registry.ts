/**
 * lib/policy/resource-admin/resource-admin-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * `ResourceAdminRegistry` is this phase's own admin-engine for the
 * `resource_grants` table — the "Resources" counterpart to
 * `../registry/policy-registry.ts`'s `PolicyRegistry` (Policies/Policy
 * Versions) and `../rbac-admin/rbac-admin-registry.ts`'s
 * `RbacAdminRegistry` (Roles/Permissions/Assignments). It is the ONE
 * place that:
 *   - enforces WHO may call it (an injected `ResourceAdminAuthorizer`);
 *   - enforces the one business rule storage alone cannot (a tuple may
 *     have at most one row, of either effect — duplicate detection before
 *     create);
 *   - enforces assurance (Rule 13) on the one genuinely sensitive
 *     mutation this module has — creating an explicit `"allow"` grant;
 *   - writes an audit entry for every mutation (Rule 10).
 *
 * ── The allow/deny assurance asymmetry ─────────────────────────────────
 * Unlike RBAC-admin (where the sensitive direction is a whole separate
 * mutation — `assignRoleToUser()` — gated by its own permission AND
 * assurance), this module has exactly one mutation that CREATES anything
 * (`createResourceGrant()`), and the same `effect` field that describes
 * WHAT the row means also decides whether IT is the sensitive direction:
 *   - `effect: "allow"` is how a subject acquires access to one specific
 *     resource instance they would not otherwise have — an explicit,
 *     administrator-granted privilege escalation. Requires strong
 *     assurance on the acting admin's own session, same Rule-13 posture
 *     `assignRoleToUser()` applies to role grants.
 *   - `effect: "deny"` is a restriction — it can only ever narrow what a
 *     subject may do (deny-overrides beats every other rule in
 *     policy-engine.ts, per explicit-grant-rule.ts's own header), never
 *     widen it. Creating one is the safe direction, so it requires no
 *     assurance, same posture locked-resource-rule.ts's own restrictions
 *     take.
 *   - Revoking ANY row (of either effect) also requires no assurance.
 *     Removing an `"allow"` row is the safe/narrowing direction (same
 *     "revoking a role never requires assurance" posture
 *     `revokeRoleFromUser()` documents). Removing a `"deny"` row does NOT
 *     by itself grant anything — it only stops THIS row from overriding
 *     whatever every other rule in the policy engine already
 *     independently decides; a subject who gains access after their deny
 *     row is revoked was already going to be allowed by some other rule
 *     (RBAC, ownership, ReBAC, ...), this mutation just stops vetoing it.
 *
 * Deliberately NOT part of this file/phase:
 *   - No "update effect" mutation — see `createResourceGrant()`'s own doc
 *     comment for why changing an existing tuple's effect is always
 *     revoke-then-recreate.
 *   - No maker-checker / approval gate. Nothing in the roadmap's Phase 23
 *     spec calls for a second approver on a resource-grant mutation, and
 *     Phase 13 (Separation of Duties) remains the roadmap's own named
 *     home for that kind of constraint if a future pass wants one here —
 *     not invented in this file, per Rule 16.
 *   - Nothing here feeds a changed `resource_grants` row into any
 *     request-scoped cache — same "introduce caching only after
 *     correctness" reasoning `rbac-admin-registry.ts`'s own header gives.
 */

import type { NewResourceGrantInput, ResourceAdminActor, ResourceAdminAuthorizer, ResourceAdminProvider, ResourceGrantAdminRecord } from "./types";
import { ResourceAdminInsufficientAssuranceError, ResourceGrantAlreadyExistsError, ResourceGrantNotFoundError } from "./errors";

/** Same assurance vocabulary/list `../rbac-admin/rbac-admin-registry.ts`'s
 *  own `hasStrongAssurance()` uses (kept as an independent copy, not a
 *  shared import — same "these modules must not depend on each other"
 *  reason ../types.ts's header documents for `ResourceAdminActor`
 *  itself). */
const STRONG_ASSURANCE_METHODS = new Set(["otp", "totp", "passkey", "backup_code"]);

function hasStrongAssurance(actor: ResourceAdminActor): boolean {
  return (actor.assuranceMethods ?? []).some((m) => STRONG_ASSURANCE_METHODS.has(m));
}

export class ResourceAdminRegistry {
  constructor(
    private readonly provider: ResourceAdminProvider,
    private readonly authorizer: ResourceAdminAuthorizer,
  ) {}

  // ── Reads — NOT actor-gated here, same posture RbacAdminRegistry's own
  //    listRoles()/listPermissionCatalog() take: the route/console layer
  //    in front of this decides who may reach these methods at all. ─────

  async listResourceGrants(): Promise<ResourceGrantAdminRecord[]> {
    return this.provider.listResourceGrants();
  }

  async listGrantsForSubject(subjectUserId: number): Promise<ResourceGrantAdminRecord[]> {
    return this.provider.listGrantsForSubject(subjectUserId);
  }

  async listGrantsForResource(resourceType: string, resourceId: string): Promise<ResourceGrantAdminRecord[]> {
    return this.provider.listGrantsForResource(resourceType, resourceId);
  }

  /** The one row (if any) for a fully-specified tuple — same "not
   *  actor-gated here" posture the three `list*` reads above take (see
   *  this class's own header). Exposed as its own public method,
   *  distinct from the internal duplicate-detection call
   *  `createResourceGrant()` makes below, so a console/detail view can
   *  fetch one entry without going through `listResourceGrants()` and
   *  filtering client-side. */
  async getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantAdminRecord | null> {
    return this.provider.getResourceGrant(subjectUserId, resourceType, resourceId, action);
  }

  /** Creates a new explicit grant/deny entry. Throws
   *  `ResourceGrantAlreadyExistsError` if the tuple already has a row (of
   *  either effect — see file header), or
   *  `ResourceAdminInsufficientAssuranceError` if `input.effect ===
   *  "allow"` and `actor` lacks strong assurance (see file header for the
   *  full allow/deny asymmetry this enforces). Changing an existing
   *  tuple's effect is always `revokeResourceGrant()` followed by a fresh
   *  `createResourceGrant()` — this registry has no in-place "update
   *  effect" mutation, matching `role_permissions`'s own grant/revoke-only
   *  shape (no update either) in ../rbac-admin/rbac-admin-registry.ts. */
  async createResourceGrant(actor: ResourceAdminActor, input: NewResourceGrantInput): Promise<ResourceGrantAdminRecord> {
    await this.authorizer.assertCanManageResourceGrants(actor);
    if (input.effect === "allow" && !hasStrongAssurance(actor)) {
      throw new ResourceAdminInsufficientAssuranceError();
    }

    const existing = await this.provider.getResourceGrant(input.subjectUserId, input.resourceType, input.resourceId, input.action);
    if (existing) {
      throw new ResourceGrantAlreadyExistsError(input.subjectUserId, input.resourceType, input.resourceId, input.action);
    }

    const created = await this.provider.createResourceGrant(input, actor.userId);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "resource_grant_created",
      subjectKey: toSubjectKey(created),
      before: null,
      after: toResourceGrantAuditSnapshot(created),
    });
    return created;
  }

  /** Revokes the row for a fully-specified tuple. Throws
   *  `ResourceGrantNotFoundError` if no row exists. Never requires
   *  assurance regardless of the removed row's effect — see file header
   *  for why removing either effect is the safe/non-escalating
   *  direction. */
  async revokeResourceGrant(actor: ResourceAdminActor, subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<void> {
    await this.authorizer.assertCanManageResourceGrants(actor);

    const existing = await this.provider.getResourceGrant(subjectUserId, resourceType, resourceId, action);
    if (!existing) {
      throw new ResourceGrantNotFoundError(subjectUserId, resourceType, resourceId, action);
    }

    await this.provider.deleteResourceGrant(subjectUserId, resourceType, resourceId, action);
    await this.provider.recordAudit({
      actorId: actor.userId,
      action: "resource_grant_revoked",
      subjectKey: toSubjectKey(existing),
      before: toResourceGrantAuditSnapshot(existing),
      after: null,
    });
  }
}

/** `"<subjectUserId>:<resourceType>:<resourceId>:<action>"` — see
 *  ../types.ts's own `ResourceAdminAuditEntry.subjectKey` doc comment. */
function toSubjectKey(grant: ResourceGrantAdminRecord): string {
  return `${grant.subjectUserId}:${grant.resourceType}:${grant.resourceId}:${grant.action}`;
}

/** Snapshot used for both halves (`before`/`after`) of a resource-grant
 *  mutation audit row — captured from a plain returned/read object, never
 *  mutated in place by any provider (same "capture BEFORE a subsequent
 *  provider call" discipline `../rbac-admin/rbac-admin-registry.ts`'s own
 *  `toRoleAuditSnapshot()` documents, for the identical aliasing reason). */
function toResourceGrantAuditSnapshot(grant: ResourceGrantAdminRecord): Record<string, unknown> {
  return {
    id: grant.id,
    subjectUserId: grant.subjectUserId,
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
    action: grant.action,
    effect: grant.effect,
    reason: grant.reason,
  };
}
