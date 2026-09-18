/**
 * lib/policy/registry/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * Pure types. No DB, no Express — same discipline every other lib/policy/*
 * types.ts already follows (see e.g. ../rbac/types.ts's header). This file
 * is what `PolicyRegistry` (policy-registry.ts), `RbacPolicyAdminAuthorizer`
 * (authorizer.ts), and `DrizzlePolicyRegistryProvider`
 * (drizzle-policy-registry-provider.ts) are all written against, and what
 * `scripts/src/test-policy-registry.ts`'s in-memory `FakePolicyRegistryProvider`
 * implements — the same "one shared interface, real provider + fake
 * provider both honor it" shape ../rbac/types.ts's header documents.
 */

/** Roadmap's own lifecycle: `DRAFT → TESTING → APPROVED → ACTIVE →
 *  DISABLED → ARCHIVED`. See lifecycle.ts for which transitions between
 *  these are actually legal — this union alone does not encode that. */
export type PolicyStatus = "DRAFT" | "TESTING" | "APPROVED" | "ACTIVE" | "DISABLED" | "ARCHIVED";

/** Only one rule kind exists today — see policy-registry.ts's header for
 *  why a second is deliberately not invented yet (Rule 16). */
export type PolicyRuleKind = "abac_dsl";

export type PolicyEffect = "allow" | "deny";

/**
 * One immutable (policy_id, version) row. "Immutable" after creation means:
 * every field here is fixed at insert time EXCEPT `status`, `approvedBy`,
 * `approvedAt`, and `updatedAt` — those four are the only ones
 * `transitionStatus()` (policy-registry.ts) ever changes. Editing a
 * policy's actual rule content always means `createNewVersion()`, i.e. a
 * brand-new row, never an update to this one (see schema/policy-registry.ts's
 * header, Rule 11: "Policy changes must be versioned").
 */
export interface PolicyRecord {
  id: number;
  policyId: string;
  version: number;
  name: string;
  description: string | null;
  application: string;
  resource: string;
  action: string;
  ruleKind: PolicyRuleKind;
  /** DSL source text when ruleKind === "abac_dsl". Deliberately stored as
   *  text, compiled via `compileAbacPolicy()` (../abac/dsl) once at
   *  authoring time (create/new-version) to validate it, and re-compiled
   *  once again whenever something actually activates/loads this policy —
   *  never stored pre-compiled. This mirrors Phase 06's own compile-policy.ts
   *  header: "parsing authoring-time, evaluation request-time — kept
   *  separate deliberately". */
  rules: string;
  effect: PolicyEffect;
  priority: number;
  status: PolicyStatus;
  createdBy: number;
  approvedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
}

/** Input to `PolicyRegistry.createPolicy()` — always produces version 1,
 *  status DRAFT. `policyId` must not already exist (see policy-registry.ts). */
export interface NewPolicyInput {
  policyId: string;
  name: string;
  description?: string | null;
  application: string;
  resource: string;
  action: string;
  ruleKind: PolicyRuleKind;
  rules: string;
  effect: PolicyEffect;
  priority?: number;
}

/** Input to `PolicyRegistry.createNewVersion()` — everything except
 *  `policyId`/version/status/audit fields, since those are either supplied
 *  separately or computed. */
export type NewPolicyVersionInput = Omit<NewPolicyInput, "policyId">;

/** WHO is performing a registry mutation, for audit + authorization
 *  purposes. Deliberately narrower than the PDP's own `Subject`
 *  (../types.ts) — the registry does not need a caller's full session
 *  shape, only enough to authorize + attribute the action. A real route
 *  handler already has a `Subject` and can trivially project it into this
 *  shape (see authorizer.ts). */
export interface PolicyAdminActor {
  userId: number;
  roleKeys: readonly string[];
  /** Same vocabulary as `Subject.assuranceMethods` (../types.ts) — carried
   *  here, not re-derived, because the registry has no session to inspect
   *  itself (see authorizer.ts's assurance check). */
  assuranceMethods?: readonly string[];
}

export type PolicyAdminAuditAction = "policy_created" | "policy_version_created" | "policy_status_changed";

/** One row this phase writes to `policy_admin_audit_log` — see
 *  schema/policy-registry.ts's header for the table this mirrors. */
export interface PolicyAdminAuditEntry {
  actorId: number | null;
  policyId: string;
  version: number;
  policyRowId: number;
  action: PolicyAdminAuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Everything `PolicyRegistry` needs from storage. `DrizzlePolicyRegistryProvider`
 * (drizzle-policy-registry-provider.ts) is the real, `@workspace/db`-backed
 * implementation; `FakePolicyRegistryProvider`
 * (scripts/src/test-policy-registry.ts) is an in-memory stand-in.
 *
 * Contract every implementation must honor:
 *   - `getPolicy`/`getActivePolicy`/`listVersions` never throw for "not
 *     found" — same "empty/null, not an exception" contract every other
 *     `*Provider` interface in lib/policy/* already establishes (see e.g.
 *     ../rbac/types.ts's own header).
 *   - `insertVersion` never enforces lifecycle legality itself — that is
 *     entirely `PolicyRegistry`'s (and lifecycle.ts's) job; the provider is
 *     a dumb store.
 *   - `recordAudit` never throws in a way that unwinds a caller's own
 *     already-committed write — see policy-registry.ts's header for why
 *     audit-write failure is logged, not silently swallowed, but also never
 *     allowed to make an otherwise-successful registry mutation look like
 *     it failed.
 */
export interface PolicyRegistryProvider {
  /** `undefined` version = highest existing version for that policyId. */
  getPolicy(policyId: string, version?: number): Promise<PolicyRecord | null>;
  getActivePolicy(policyId: string): Promise<PolicyRecord | null>;
  listActivePolicies(filter?: { application?: string; resource?: string }): Promise<PolicyRecord[]>;
  /**
   * Phase 23A (Admin Policy Console). One row per DISTINCT `policyId` — its
   * latest version by `version` number, regardless of status — then
   * narrowed by `application`/`resource`/`status` on THAT resulting row
   * (never on an underlying candidate row before "latest" is picked; a
   * DRAFT v3 is still policyId's latest even if an older v2 happened to
   * match a `status` filter more narrowly). Same "latest wins, then
   * filter" semantics `getPolicy(policyId)` with no `version` argument
   * already has for a single policyId, applied here across every policyId
   * at once. Sorted by `policyId`. Returns `[]` when nothing is on file —
   * never throws. See `DrizzlePolicyRegistryProvider.listAllPolicies()`'s
   * own doc comment for the real, `DISTINCT ON`-backed implementation, and
   * `scripts/src/test-policy-registry.ts`'s `FakePolicyRegistryProvider`
   * for the in-memory mirror both providers must agree with exactly.
   */
  listAllPolicies(filter?: { application?: string; resource?: string; status?: PolicyStatus }): Promise<PolicyRecord[]>;
  listVersions(policyId: string): Promise<PolicyRecord[]>;
  /** Highest existing version number for policyId, or 0 if none exists yet. */
  getLatestVersionNumber(policyId: string): Promise<number>;
  /** Inserts a brand-new (policyId, version) row, status DRAFT. Never
   *  mutates an existing row (see file header's "immutable after
   *  creation"). */
  insertVersion(input: NewPolicyInput & { version: number; createdBy: number }): Promise<PolicyRecord>;
  /** Updates ONLY `status`/`approvedBy`/`approvedAt`/`updatedAt` on an
   *  existing (policyId, version) row. Never touches any other column. */
  updateStatus(
    policyId: string,
    version: number,
    next: PolicyStatus,
    approvedBy: number | null,
  ): Promise<PolicyRecord>;
  recordAudit(entry: PolicyAdminAuditEntry): Promise<void>;
}

/**
 * Authorization collaborator `PolicyRegistry` delegates every
 * "is this actor allowed" question to — kept as an injected interface
 * (not hard-coded RBAC calls inline in policy-registry.ts) for the exact
 * same testability reason ../rbac/rbac-rule.ts is written against
 * `RbacProvider` rather than importing a Drizzle client directly. See
 * authorizer.ts for the real, RBAC-backed implementation.
 */
export interface PolicyAdminAuthorizer {
  /** Throws `PolicyAuthorizationError` if `actor` may not create/edit
   *  policies at all (checks `admin.policy.manage`). Async because the
   *  real implementation resolves RBAC role-inheritance/permission grants
   *  from storage (see authorizer.ts) — same async shape
   *  `resolveEffectivePermissions()` itself already has. */
  assertCanManagePolicies(actor: PolicyAdminActor): Promise<void>;
  /** Throws `PolicyAuthorizationError` if `actor` may not approve a
   *  DRAFT/TESTING policy version (checks `admin.policy.approve` — a
   *  distinct, narrower permission than manage, since approval is the
   *  maker-checker gate before a policy can ever go ACTIVE). */
  assertCanApprovePolicies(actor: PolicyAdminActor): Promise<void>;
}
