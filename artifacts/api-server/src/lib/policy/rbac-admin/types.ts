/**
 * lib/policy/rbac-admin/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23C (Admin Policy
 * Console — Roles, Permissions & Assignments sections).
 *
 * Same shape ../registry/types.ts already established for the Policies /
 * Policy Versions sections (23A/23B): pure types, no DB, no Express. This
 * is what `RbacAdminRegistry` (rbac-admin-registry.ts), the real
 * `RbacAdminAuthorizer` (authorizer.ts), and `DrizzleRbacAdminProvider`
 * (drizzle-rbac-admin-provider.ts) are all written against, and what
 * `scripts/src/test-rbac-admin-registry.ts`'s in-memory
 * `FakeRbacAdminProvider` implements.
 *
 * ── Why a SEPARATE admin surface from ../rbac/* rather than widening it ──
 * `../rbac/types.ts`'s own header is explicit: "No `write` methods exist
 * here (granting a role/permission is a future admin-console concern —
 * Phase 23 — not something the PDP's read path needs)." This module is
 * that future phase. It does not touch `RbacProvider` (the PDP's own
 * read-only interface, consulted on every authorization request) at all —
 * it is a second, write-capable interface over the SAME four tables
 * (`roles`/`permissions`/`role_permissions`/`user_roles`), used only by
 * this admin console. Keeping the two interfaces separate means the PDP's
 * hot read path never has to reason about admin-console concerns
 * (audit-entry shapes, maker-checker, assurance), and this admin surface
 * never has to satisfy `RbacProvider`'s "never throw for not-found"
 * contract for operations (create/update/delete) that ARE genuinely
 * exceptional when their target doesn't exist.
 *
 * ── `RbacAdminActor` mirors `PolicyAdminActor` structurally, on purpose ──
 * Same three fields (`userId`, `roleKeys`, `assuranceMethods`), same
 * reason: this module's own `buildRbacAdminActor()` (authorizer.ts)
 * computes it identically to `../registry/authorizer.ts`'s
 * `buildPolicyAdminActor()` (legacy-role-map ∪ real user_roles grants —
 * see that file's own header for why the two must never diverge). This is
 * a deliberate small duplication, not a shared import: `../registry/*`
 * must not depend on `../rbac-admin/*` (nothing about approving a POLICY
 * needs the ROLE-admin surface), and the reverse dependency would be
 * equally wrong, so each module keeps its own copy of the identical
 * three-line projection rather than inventing a shared home for it neither
 * side conceptually owns.
 */

/** WHO is performing an RBAC-admin mutation — see file header. */
export interface RbacAdminActor {
  userId: number;
  roleKeys: readonly string[];
  assuranceMethods?: readonly string[];
}

/**
 * One `roles` row, the full admin-facing shape (unlike ../rbac/types.ts's
 * `RoleRecord`, which the PDP's read-only rbac-rule.ts intentionally keeps
 * to the two fields role-inheritance resolution actually needs). This is
 * what an operator browsing the Roles section sees.
 */
export interface RoleAdminRecord {
  id: number;
  key: string;
  name: string;
  description: string | null;
  parentRoleKey: string | null;
  /** System rows (seeded by migration 096 — "user"/"dev"/"admin") are
   *  immutable through this admin console: not renamable, not
   *  re-parentable, not deletable here (see rbac-admin-registry.ts's
   *  `assertRoleIsMutable()`). Custom roles this console itself creates
   *  always have `isSystem === false`. */
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Input to `RbacAdminRegistry.createRole()`. `key` must not already
 *  exist; `parentRoleKey`, if given, must reference an existing role and
 *  must not introduce a cycle (see rbac-admin-registry.ts). Always creates
 *  a non-system role. */
export interface NewRoleInput {
  key: string;
  name: string;
  description?: string | null;
  parentRoleKey?: string | null;
}

/** Input to `RbacAdminRegistry.updateRole()`. Only these three fields are
 *  ever mutable — `key`/`isSystem`/`id` never change after creation (same
 *  "identity is immutable, everything else can move" posture
 *  ../registry/types.ts's `PolicyRecord` takes with `policyId`/`version`). */
export interface RoleUpdateInput {
  name?: string;
  description?: string | null;
  parentRoleKey?: string | null;
}

/** One `permissions` catalog row — purely documentation/informational
 *  (see lib/db/src/schema/rbac.ts's own header: a grant is allowed to
 *  reference a wildcard pattern the catalog never lists). Concrete
 *  `product.resource.action` keys only — no wildcards in the catalog
 *  itself, matching `insertPermissionSchema`'s own DB-level check. */
export interface PermissionCatalogRecord {
  id: number;
  key: string;
  description: string | null;
  createdAt: Date;
}

export interface NewPermissionCatalogInput {
  key: string;
  description?: string | null;
}

/** One `role_permissions` row — a grant PATTERN attached directly to a
 *  role (never a role's INHERITED grants; see ../rbac/role-resolver.ts for
 *  where inheritance is actually resolved, which this admin surface does
 *  not duplicate). */
export interface RolePermissionGrantRecord {
  id: number;
  roleId: number;
  permissionKey: string;
  createdAt: Date;
}

/** One `user_roles` row, joined with its role's `key` for legibility (an
 *  operator browsing a user's Assignments should never have to separately
 *  resolve `roleId` back to a role — see
 *  `DrizzleRbacAdminProvider.listUserRoleAssignments()`'s own doc comment
 *  for how the real implementation produces this join). */
export interface UserRoleAssignmentRecord {
  id: number;
  userId: number;
  roleId: number;
  roleKey: string;
  grantedBy: number | null;
  reason: string | null;
  createdAt: Date;
}

export type RbacAdminAuditAction =
  | "role_created"
  | "role_updated"
  | "role_deleted"
  | "permission_created"
  | "permission_granted"
  | "permission_revoked"
  | "user_role_assigned"
  | "user_role_revoked";

/** One row this phase writes to `rbac_admin_audit_log` — see
 *  lib/db/src/schema/rbac.ts's `rbacAdminAuditLogTable` (appended this
 *  phase) for the table this mirrors. Deliberately a single audit stream
 *  for every RBAC-admin mutation kind (roles, permissions, grants,
 *  assignments) rather than one table per kind — an operator reviewing
 *  "who changed access, and when" almost always wants all four
 *  interleaved by time, not scattered across four tables they'd have to
 *  UNION themselves. `subjectKey`/`subjectId` together identify WHAT was
 *  mutated regardless of kind (a role's `key`, a permission's `key`, or a
 *  `"userId:roleKey"` pair for an assignment) — see
 *  `rbac-admin-registry.ts`'s own audit-entry construction for exactly
 *  what each action kind puts there. */
export interface RbacAdminAuditEntry {
  actorId: number | null;
  action: RbacAdminAuditAction;
  /** Human-legible identifier for the row this entry describes — a role
   *  key, a permission key, or `"<userId>:<roleKey>"` for an assignment. */
  subjectKey: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Everything `RbacAdminRegistry` needs from storage. `DrizzleRbacAdminProvider`
 * (drizzle-rbac-admin-provider.ts) is the real, `@workspace/db`-backed
 * implementation; `FakeRbacAdminProvider`
 * (scripts/src/test-rbac-admin-registry.ts) is an in-memory stand-in.
 *
 * Contract every implementation must honor (same "empty/null, not an
 * exception" discipline every other `*Provider` interface in lib/policy/*
 * already establishes — see e.g. ../rbac/types.ts's own header):
 *   - Every `get*`/`list*` method never throws for "not found" — an
 *     unknown key/id/pair contributes `null`/`[]`, exactly like
 *     `RbacProvider`'s own contract.
 *   - Every mutation method is a dumb store: it never enforces business
 *     rules (system-role immutability, cycle detection, duplicate
 *     detection) itself — that is entirely `RbacAdminRegistry`'s job. A
 *     provider method is called only after the registry has already
 *     decided the mutation is legal.
 *   - `recordAudit` never throws in a way that unwinds an already-
 *     committed write — same posture `PolicyRegistryProvider.recordAudit()`
 *     documents (log, don't silently swallow, but also don't make an
 *     otherwise-successful mutation look like it failed by throwing
 *     AFTER the real write already landed — see
 *     `DrizzleRbacAdminProvider.recordAudit()`'s own doc comment for
 *     exactly how this is honored).
 */
export interface RbacAdminProvider {
  listRoles(): Promise<RoleAdminRecord[]>;
  getRoleByKey(key: string): Promise<RoleAdminRecord | null>;
  createRole(input: NewRoleInput): Promise<RoleAdminRecord>;
  updateRole(key: string, patch: RoleUpdateInput): Promise<RoleAdminRecord>;
  deleteRole(key: string): Promise<void>;
  /** True if any `roles` row (other than `key` itself) has
   *  `parentRoleKey === key` — deleting `key` would silently orphan that
   *  child's inheritance chain. */
  hasChildRoles(key: string): Promise<boolean>;
  /** True if any `user_roles` row references this role — deleting it
   *  would silently revoke a real user's access with no audit trail
   *  describing why. */
  hasUserAssignments(roleId: number): Promise<boolean>;

  listPermissionCatalog(): Promise<PermissionCatalogRecord[]>;
  getPermissionByKey(key: string): Promise<PermissionCatalogRecord | null>;
  createPermissionCatalogEntry(input: NewPermissionCatalogInput): Promise<PermissionCatalogRecord>;

  listRolePermissionGrants(roleId: number): Promise<RolePermissionGrantRecord[]>;
  getRolePermissionGrant(roleId: number, permissionKey: string): Promise<RolePermissionGrantRecord | null>;
  grantPermissionToRole(roleId: number, permissionKey: string): Promise<RolePermissionGrantRecord>;
  revokePermissionFromRole(roleId: number, permissionKey: string): Promise<void>;

  listUserRoleAssignments(userId: number): Promise<UserRoleAssignmentRecord[]>;
  getUserRoleAssignment(userId: number, roleId: number): Promise<UserRoleAssignmentRecord | null>;
  assignRoleToUser(userId: number, roleId: number, grantedBy: number | null, reason: string | null): Promise<UserRoleAssignmentRecord>;
  revokeRoleFromUser(userId: number, roleId: number): Promise<void>;

  recordAudit(entry: RbacAdminAuditEntry): Promise<void>;
}

/**
 * Authorization collaborator `RbacAdminRegistry` delegates every "is this
 * actor allowed" question to — same injected-interface shape
 * ../registry/types.ts's `PolicyAdminAuthorizer` already establishes, for
 * the identical testability reason. See authorizer.ts for the real,
 * RBAC-backed implementation.
 */
export interface RbacAdminAuthorizer {
  /** Throws `RbacAdminAuthorizationError` if `actor` may not create/edit/
   *  delete roles, manage the permission catalog, or grant/revoke a
   *  role's own permission patterns (checks `admin.role.manage`). */
  assertCanManageRoles(actor: RbacAdminActor): Promise<void>;
  /** Throws `RbacAdminAuthorizationError` if `actor` may not assign or
   *  revoke a role ON A USER (checks `admin.role.assign` — a distinct,
   *  narrower permission than manage: defining what a role CAN do is a
   *  different capability from deciding WHO holds it). */
  assertCanAssignRoles(actor: RbacAdminActor): Promise<void>;
}
