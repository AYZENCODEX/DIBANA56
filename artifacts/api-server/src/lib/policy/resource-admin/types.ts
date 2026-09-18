/**
 * lib/policy/resource-admin/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23D (Admin Policy
 * Console — Resources section).
 *
 * Same shape ../registry/types.ts and ../rbac-admin/types.ts already
 * established for their own admin surfaces: pure types, no DB, no
 * Express. This is what `ResourceAdminRegistry`
 * (resource-admin-registry.ts), the real `ResourceAdminAuthorizer`
 * (authorizer.ts), and `DrizzleResourceAdminProvider`
 * (drizzle-resource-admin-provider.ts) are all written against, and what
 * `scripts/src/test-resource-admin-registry.ts`'s in-memory
 * `FakeResourceAdminProvider` implements.
 *
 * ── Why a SEPARATE admin surface from ../resource/* rather than widening
 *    it ─────────────────────────────────────────────────────────────────
 * `../resource/types.ts`'s own `ResourceGrantProvider` is explicit: it is
 * read-only ("writing a grant is a future admin-console/sharing-feature
 * concern"), consulted on every authorization request via
 * `explicit-grant-rule.ts`. This module is that future phase, for the
 * "Resources" section the roadmap's own Phase 23 list names. It does not
 * touch `ResourceGrantProvider` (the PDP's own read-only interface) at
 * all — it is a second, write-capable interface over the SAME
 * `resource_grants` table, used only by this admin console. Keeping the
 * two interfaces separate means the PDP's hot read path never has to
 * reason about admin-console concerns (audit-entry shapes, assurance),
 * and this admin surface never has to satisfy `ResourceGrantProvider`'s
 * "never throw for not-found" contract for operations (create/revoke)
 * that ARE genuinely exceptional when their target already exists or
 * doesn't.
 *
 * ── One flat permission, not a manage/assign split ─────────────────────
 * `../rbac-admin/types.ts` splits ROLE-admin into `admin.role.manage`
 * (define what a role can do) vs `admin.role.assign` (decide who holds
 * it) because those are genuinely different capability classes — one is
 * system-wide-reaching (a role can carry the global `"*"` wildcard), the
 * other is not. A resource grant has no such split: creating one and
 * revoking one both act on exactly one already-fully-specified (subject,
 * resource, action) tuple, so there is nothing narrower to carve out.
 * `admin.resource.manage` (authorizer.ts) covers create AND revoke; the
 * allow-vs-deny asymmetry that DOES matter here (see
 * resource-admin-registry.ts's own header) is handled by an assurance
 * check inside `createResourceGrant()` itself, not by a second
 * permission.
 *
 * ── `ResourceAdminActor` mirrors `RbacAdminActor`/`PolicyAdminActor`
 *    structurally, on purpose ─────────────────────────────────────────
 * Same three fields (`userId`, `roleKeys`, `assuranceMethods`), same
 * reason: this module's own `buildResourceAdminActor()` (authorizer.ts)
 * computes it identically to those two siblings' own actor builders
 * (legacy-role-map ∪ real user_roles grants — see either sibling's own
 * header for why the three must never diverge). A deliberate small
 * duplication, not a shared import — same "neither side conceptually
 * owns a shared home for this" reasoning ../rbac-admin/types.ts's own
 * header gives.
 */

/** WHO is performing a resource-grant-admin mutation — see file header. */
export interface ResourceAdminActor {
  userId: number;
  roleKeys: readonly string[];
  assuranceMethods?: readonly string[];
}

/** "allow" | "deny" — see lib/db/src/schema/resource-grants.ts's own
 *  header for why both share one table/shape (only `effect` differs). */
export type ResourceGrantEffect = "allow" | "deny";

/**
 * One `resource_grants` row, the full admin-facing shape (unlike
 * ../resource/types.ts's `ResourceGrantEntry`, which the PDP's read-only
 * explicit-grant-rule.ts intentionally keeps to the two fields a lookup
 * actually needs). This is what an operator browsing the Resources
 * section sees.
 */
export interface ResourceGrantAdminRecord {
  id: number;
  subjectUserId: number;
  resourceType: string;
  resourceId: string;
  action: string;
  effect: ResourceGrantEffect;
  grantedBy: number | null;
  reason: string | null;
  createdAt: Date;
}

/** Input to `ResourceAdminRegistry.createResourceGrant()`. The
 *  (`subjectUserId`, `resourceType`, `resourceId`, `action`) tuple must
 *  not already have ANY row (of either effect) — see
 *  resource-admin-registry.ts's own doc comment for why changing an
 *  existing tuple's effect is a revoke-then-recreate, never an in-place
 *  update. */
export interface NewResourceGrantInput {
  subjectUserId: number;
  resourceType: string;
  resourceId: string;
  action: string;
  effect: ResourceGrantEffect;
  reason?: string | null;
}

export type ResourceAdminAuditAction = "resource_grant_created" | "resource_grant_revoked";

/** One row this phase writes to `resource_admin_audit_log` — see
 *  lib/db/src/schema/resource-grants.ts's `resourceAdminAuditLogTable`
 *  (appended this phase) for the table this mirrors. `subjectKey` is
 *  always `"<subjectUserId>:<resourceType>:<resourceId>:<action>"` — the
 *  full tuple, stringified, so a revoked row's audit trail stays legible
 *  even after the `resource_grants` row itself is gone (same reasoning
 *  `RbacAdminAuditEntry.subjectKey`'s own doc comment gives for
 *  `"<userId>:<roleKey>"`). */
export interface ResourceAdminAuditEntry {
  actorId: number | null;
  action: ResourceAdminAuditAction;
  subjectKey: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Everything `ResourceAdminRegistry` needs from storage.
 * `DrizzleResourceAdminProvider` (drizzle-resource-admin-provider.ts) is
 * the real, `@workspace/db`-backed implementation;
 * `FakeResourceAdminProvider` (scripts/src/test-resource-admin-registry.ts)
 * is an in-memory stand-in.
 *
 * Contract every implementation must honor (same "empty/null, not an
 * exception" discipline every other `*Provider` interface in lib/policy/*
 * already establishes — see e.g. ../rbac-admin/types.ts's own header):
 *   - Every `get*`/`list*` method never throws for "not found" — no
 *     matching row(s) contributes `null`/`[]`, exactly like
 *     `ResourceGrantProvider`'s own contract.
 *   - Every mutation method is a dumb store: it never enforces business
 *     rules (duplicate-tuple detection, the allow/deny assurance
 *     asymmetry) itself — that is entirely `ResourceAdminRegistry`'s job.
 *     A provider method is called only after the registry has already
 *     decided the mutation is legal.
 *   - `recordAudit` never throws in a way that unwinds an already-
 *     committed write — same posture `RbacAdminProvider.recordAudit()`
 *     documents (log, don't silently swallow, but also don't make an
 *     otherwise-successful mutation look like it failed by throwing
 *     AFTER the real write already landed — see
 *     `DrizzleResourceAdminProvider.recordAudit()`'s own doc comment for
 *     exactly how this is honored).
 */
export interface ResourceAdminProvider {
  listResourceGrants(): Promise<ResourceGrantAdminRecord[]>;
  /** Every grant directly held by one subject, across every resource. */
  listGrantsForSubject(subjectUserId: number): Promise<ResourceGrantAdminRecord[]>;
  /** Every grant on file for one concrete resource instance, across every
   *  subject — the "who can/can't touch THIS row" view. */
  listGrantsForResource(resourceType: string, resourceId: string): Promise<ResourceGrantAdminRecord[]>;
  /** The one row (if any) for a fully-specified tuple — used both to
   *  render one entry and to check for a pre-existing tuple before
   *  create. */
  getResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<ResourceGrantAdminRecord | null>;
  createResourceGrant(input: NewResourceGrantInput, grantedBy: number | null): Promise<ResourceGrantAdminRecord>;
  deleteResourceGrant(subjectUserId: number, resourceType: string, resourceId: string, action: string): Promise<void>;

  recordAudit(entry: ResourceAdminAuditEntry): Promise<void>;
}

/**
 * Authorization collaborator `ResourceAdminRegistry` delegates every "is
 * this actor allowed" question to — same injected-interface shape
 * ../registry/types.ts's `PolicyAdminAuthorizer` and
 * ../rbac-admin/types.ts's `RbacAdminAuthorizer` already establish, for
 * the identical testability reason. See authorizer.ts for the real,
 * RBAC-backed implementation.
 */
export interface ResourceAdminAuthorizer {
  /** Throws `ResourceAdminAuthorizationError` if `actor` may not create
   *  or revoke an explicit resource grant/deny entry (checks
   *  `admin.resource.manage`). */
  assertCanManageResourceGrants(actor: ResourceAdminActor): Promise<void>;
}
