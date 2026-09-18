/**
 * lib/policy/registry/policy-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * `PolicyRegistry` is the Policy Administration Point the roadmap's target
 * architecture names: `PAP → Policy Registry → Policy Versions → PDP`. It
 * is the ONE place that:
 *   - validates a policy's rule content at authoring time (compiles Phase
 *     06 DSL text via `compileAbacPolicy()` — an invalid policy is never
 *     stored, Rule 8: fail closed);
 *   - enforces the lifecycle graph (lifecycle.ts) — no route/caller may
 *     skip a step or leave ARCHIVED;
 *   - enforces WHO may call it (an injected `PolicyAdminAuthorizer` —
 *     "Only authorized administrators may modify policies");
 *   - enforces maker-checker (the actor who authored a version may not
 *     also approve it) and assurance (Rule 13) on sensitive transitions;
 *   - writes an audit entry for every mutation (Rule 10).
 *
 * Phase 16 (Policy Versioning) added `assertVersionSlotFree()` (below) —
 * a last-check-before-write immutability guard against a concurrent-writer
 * race on the (policyId, version) slot `createPolicy()`/`createNewVersion()`
 * are about to insert into. See that function's own doc comment.
 *
 * Deliberately NOT part of this file/phase:
 *   - Nothing here is wired into any Express route yet. Same posture every
 *     prior phase shipped with (see e.g. CHANGES_..._PHASE6.md's "not done"
 *     section) — a future phase adds an actual `/admin/policies/*` route
 *     that constructs a `PolicyRegistry` and calls it, then that route
 *     itself goes through the PDP (Phase 01-06) for its OWN authorization,
 *     same as any other AYZEN admin route. This file provides the engine,
 *     not the endpoint.
 *   - Nothing here feeds an ACTIVE policy's compiled rule into the PDP's
 *     `PolicyEngine` (../policy-engine.ts) at evaluation time. That "load
 *     every ACTIVE registry row for this application/resource, compile
 *     once, register as rules" loader is a natural next step but is a
 *     distinct piece of wiring this phase's own scope (registry + PAP) does
 *     not require to be complete and correct on its own (Rule 16).
 *   - No transactional (single round-trip) guarantee across the
 *     `insertVersion`/`updateStatus` write and the `recordAudit` write —
 *     this codebase's existing Drizzle call sites are not wrapped in
 *     `db.transaction()` elsewhere either (see e.g. `DrizzleRbacProvider`),
 *     so this phase does not introduce a new pattern unilaterally. Audit
 *     writes are attempted immediately after the row write they describe,
 *     and a failure to write the audit row is logged and RE-THROWN (unlike
 *     `oidc-client-admin-audit.ts`'s own best-effort precedent) — an
 *     unaudited sensitive policy mutation is worse than a mutation the
 *     caller is told to retry, per Rule 10.
 */

import { compileAbacPolicy } from "../abac/dsl";
import type {
  NewPolicyInput,
  NewPolicyVersionInput,
  PolicyAdminActor,
  PolicyAdminAuthorizer,
  PolicyRecord,
  PolicyRegistryProvider,
  PolicyStatus,
} from "./types";
import { assertValidTransition, SENSITIVE_TRANSITIONS } from "./lifecycle";
import {
  InsufficientAssuranceError,
  InvalidPolicyContentError,
  PolicyAlreadyExistsError,
  PolicyNotFoundError,
  PolicyVersionConflictError,
  SelfApprovalNotAllowedError,
} from "./errors";

/**
 * Phase 16 (Policy Versioning) immutability guard. `createPolicy()` and
 * `createNewVersion()` both compute the version number they are about to
 * insert from a PRIOR read (`getLatestVersionNumber()`), then do other
 * work (rule-content validation, which may be non-trivial) before actually
 * calling `provider.insertVersion()`. Between that read and the write, a
 * concurrent writer may have already inserted into the exact same
 * `(policyId, version)` slot — this function is the last check before the
 * write, re-confirming the slot is still free by asking the provider
 * directly (`getPolicy(policyId, version)`) rather than trusting the
 * earlier `getLatestVersionNumber()` result. Throws
 * `PolicyVersionConflictError` if the slot is already occupied; a no-op
 * (returns normally) otherwise. See that error's own doc comment for why
 * this is a real race to guard, not paranoia, and why the correct caller
 * response is "retry the whole operation", never "proceed anyway".
 *
 * Deliberately a plain exported function, not inlined into
 * `createPolicy()`/`createNewVersion()` — both call sites need the exact
 * same check, and keeping it as one function means there is only one place
 * that can get this guard subtly wrong.
 */
export async function assertVersionSlotFree(provider: PolicyRegistryProvider, policyId: string, version: number): Promise<void> {
  const existing = await provider.getPolicy(policyId, version);
  if (existing) {
    throw new PolicyVersionConflictError(policyId, version);
  }
}

/** Same assurance vocabulary `Subject.assuranceMethods` (../types.ts)
 *  already uses. "Strong" excludes a bare base-session login — matches
 *  the roadmap's own Phase 09 vocabulary this codebase has not built yet,
 *  but the method-name strings already exist on `Subject` today. */
const STRONG_ASSURANCE_METHODS = new Set(["otp", "totp", "passkey", "backup_code"]);

function hasStrongAssurance(actor: PolicyAdminActor): boolean {
  return (actor.assuranceMethods ?? []).some((m) => STRONG_ASSURANCE_METHODS.has(m));
}

function toAuditSnapshot(policy: PolicyRecord): Record<string, unknown> {
  // Everything except the rule source text itself — the DSL expression is
  // already durably present as the row's own `rules` column (readable via
  // getPolicy/listVersions), duplicating it into every audit row this
  // policy's lifecycle ever passes through would bloat the audit log for
  // no additional information. Every other field IS duplicated here,
  // deliberately, since audit rows must remain meaningful even after a
  // later version supersedes this one.
  const { rules: _rules, ...rest } = policy;
  return rest as unknown as Record<string, unknown>;
}

export class PolicyRegistry {
  constructor(
    private readonly provider: PolicyRegistryProvider,
    private readonly authorizer: PolicyAdminAuthorizer,
  ) {}

  /** Creates version 1 of a brand-new policy, status DRAFT. Throws
   *  `PolicyAlreadyExistsError` if `input.policyId` already has any
   *  version on file — use `createNewVersion()` for those. */
  async createPolicy(actor: PolicyAdminActor, input: NewPolicyInput): Promise<PolicyRecord> {
    await this.authorizer.assertCanManagePolicies(actor);

    const existingLatest = await this.provider.getLatestVersionNumber(input.policyId);
    if (existingLatest > 0) {
      throw new PolicyAlreadyExistsError(input.policyId);
    }

    this.validateRuleContent(input);

    // Phase 16: re-confirm version 1's slot is still free immediately
    // before writing — `existingLatest > 0` above may itself be a stale
    // read (see assertVersionSlotFree()'s own doc comment).
    await assertVersionSlotFree(this.provider, input.policyId, 1);

    const created = await this.provider.insertVersion({ ...input, version: 1, createdBy: actor.userId });
    await this.provider.recordAudit({
      actorId: actor.userId,
      policyId: created.policyId,
      version: created.version,
      policyRowId: created.id,
      action: "policy_created",
      before: null,
      after: toAuditSnapshot(created),
    });
    return created;
  }

  /** Creates the NEXT version of an existing policy (latest + 1), status
   *  DRAFT — never mutates the prior version's row (Rule 11). Throws
   *  `PolicyNotFoundError` if `policyId` has no prior version at all
   *  (use `createPolicy()` first). */
  async createNewVersion(actor: PolicyAdminActor, policyId: string, input: NewPolicyVersionInput): Promise<PolicyRecord> {
    await this.authorizer.assertCanManagePolicies(actor);

    const latest = await this.provider.getLatestVersionNumber(policyId);
    if (latest === 0) {
      throw new PolicyNotFoundError(policyId);
    }

    this.validateRuleContent(input);

    const nextVersion = latest + 1;

    // Phase 16: re-confirm nextVersion's slot is still free immediately
    // before writing — `latest` above may itself be a stale read (see
    // assertVersionSlotFree()'s own doc comment; this is exactly the
    // TOCTOU race that function exists to catch).
    await assertVersionSlotFree(this.provider, policyId, nextVersion);

    const created = await this.provider.insertVersion({
      ...input,
      policyId,
      version: nextVersion,
      createdBy: actor.userId,
    });
    await this.provider.recordAudit({
      actorId: actor.userId,
      policyId: created.policyId,
      version: created.version,
      policyRowId: created.id,
      action: "policy_version_created",
      before: null,
      after: toAuditSnapshot(created),
    });
    return created;
  }

  /**
   * Moves (policyId, version) from its current status to `next`, per
   * lifecycle.ts's transition graph. Enforces, in order:
   *   1. the version exists at all (`PolicyNotFoundError`);
   *   2. the transition is legal from its CURRENT status
   *      (`PolicyLifecycleError` — thrown by `assertValidTransition`);
   *   3. `actor` holds the right permission for this transition —
   *      `admin.policy.approve` specifically for → APPROVED,
   *      `admin.policy.manage` for every other transition
   *      (`PolicyAuthorizationError`);
   *   4. no self-approval: for → APPROVED, `actor.userId` must differ from
   *      the version's own `createdBy` (`SelfApprovalNotAllowedError`);
   *   5. strong assurance for any transition in `SENSITIVE_TRANSITIONS`
   *      (today: → ACTIVE) (`InsufficientAssuranceError`).
   * Only on passing all of the above does this actually write anything —
   * see file header for why steps 1-5 all happen before any DB mutation
   * (fail closed: a rejected transition must never partially apply).
   *
   * When `next` is ACTIVE, any OTHER version of the same `policyId`
   * currently ACTIVE is first transitioned to DISABLED (at most one ACTIVE
   * version per policyId — see migration 099's partial unique index for
   * the DB-level backstop on this same invariant).
   */
  async transitionStatus(actor: PolicyAdminActor, policyId: string, version: number, next: PolicyStatus): Promise<PolicyRecord> {
    const current = await this.provider.getPolicy(policyId, version);
    if (!current) {
      throw new PolicyNotFoundError(policyId, version);
    }

    assertValidTransition(current.status, next);

    if (next === "APPROVED") {
      await this.authorizer.assertCanApprovePolicies(actor);
      if (actor.userId === current.createdBy) {
        throw new SelfApprovalNotAllowedError(actor.userId);
      }
    } else {
      await this.authorizer.assertCanManagePolicies(actor);
    }

    if (SENSITIVE_TRANSITIONS.has(next) && !hasStrongAssurance(actor)) {
      throw new InsufficientAssuranceError(next);
    }

    if (next === "ACTIVE") {
      const currentlyActive = await this.provider.getActivePolicy(policyId);
      if (currentlyActive && currentlyActive.version !== version) {
        await this.applyStatusChange(actor, currentlyActive, "DISABLED");
      }
    }

    return this.applyStatusChange(actor, current, next);
  }

  private async applyStatusChange(actor: PolicyAdminActor, before: PolicyRecord, next: PolicyStatus): Promise<PolicyRecord> {
    // Snapshot BEFORE calling the provider, not after — see this method's
    // own file header note (added after a real bug: an in-memory provider
    // that mutates a row object in place, rather than returning a fresh
    // one, would otherwise corrupt the "before" half of the audit record,
    // since `before` and the provider's internal row would end up being
    // the SAME object by the time `toAuditSnapshot()` ran). Capturing the
    // snapshot up front makes the audit record correct regardless of
    // whether a given `PolicyRegistryProvider` implementation mutates in
    // place or returns a new object — `scripts/src/test-policy-registry.ts`
    // pins this down directly (see that suite's audit-shape test).
    const beforeSnapshot = toAuditSnapshot(before);
    const approvedBy = next === "APPROVED" ? actor.userId : before.approvedBy;
    const updated = await this.provider.updateStatus(before.policyId, before.version, next, approvedBy);
    await this.provider.recordAudit({
      actorId: actor.userId,
      policyId: updated.policyId,
      version: updated.version,
      policyRowId: updated.id,
      action: "policy_status_changed",
      before: beforeSnapshot,
      after: toAuditSnapshot(updated),
    });
    return updated;
  }

  async getPolicy(policyId: string, version?: number): Promise<PolicyRecord | null> {
    return this.provider.getPolicy(policyId, version);
  }

  async getActivePolicy(policyId: string): Promise<PolicyRecord | null> {
    return this.provider.getActivePolicy(policyId);
  }

  async listActivePolicies(filter?: { application?: string; resource?: string }): Promise<PolicyRecord[]> {
    return this.provider.listActivePolicies(filter);
  }

  /** Phase 23A (Admin Policy Console). See `PolicyRegistryProvider
   *  .listAllPolicies()`'s own doc comment (registry/types.ts) — this is a
   *  plain delegation, same as `listActivePolicies()`/`listVersions()`
   *  above; every actual "latest wins, then filter" semantic lives in the
   *  provider (real or fake) so both implementations are forced to agree
   *  on it independently, not funneled through one shared helper here. */
  async listAllPolicies(filter?: { application?: string; resource?: string; status?: PolicyStatus }): Promise<PolicyRecord[]> {
    return this.provider.listAllPolicies(filter);
  }

  async listVersions(policyId: string): Promise<PolicyRecord[]> {
    return this.provider.listVersions(policyId);
  }

  /** Throws `InvalidPolicyContentError` (wrapping the underlying
   *  `DslError`) if `input.rules` does not compile. Called before any DB
   *  write on both create paths — never store an unparseable policy. */
  private validateRuleContent(input: Pick<NewPolicyInput, "ruleKind" | "rules" | "effect">): void {
    if (input.ruleKind !== "abac_dsl") {
      throw new InvalidPolicyContentError(`Unsupported ruleKind "${input.ruleKind}".`);
    }
    try {
      compileAbacPolicy({ id: "validation", effect: input.effect, expression: input.rules });
    } catch (err) {
      throw new InvalidPolicyContentError(`Policy rule content failed to compile: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }
}
