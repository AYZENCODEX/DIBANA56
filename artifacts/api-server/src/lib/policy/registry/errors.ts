/**
 * lib/policy/registry/errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 07 (Policy Registry / PAP).
 *
 * Distinct error classes so a caller (a future admin route — nothing calls
 * these yet, see policy-registry.ts's header) can tell WHY a mutation was
 * rejected without parsing a message string — same posture ../policy-errors.ts
 * already established for the PDP side.
 */

export class PolicyNotFoundError extends Error {
  constructor(policyId: string, version?: number) {
    super(version === undefined ? `No policy registered with policyId "${policyId}".` : `No version ${version} of policy "${policyId}".`);
    this.name = "PolicyNotFoundError";
  }
}

export class PolicyAlreadyExistsError extends Error {
  constructor(policyId: string) {
    super(`A policy with policyId "${policyId}" already exists — use createNewVersion() instead.`);
    this.name = "PolicyAlreadyExistsError";
  }
}

/** Thrown when the supplied rule content fails validation — today this
 *  always means `compileAbacPolicy()` (../abac/dsl) threw a `DslError` on
 *  the supplied DSL text. A hostile/malformed policy must never be
 *  silently registered (Rule 8: fail closed) — see policy-registry.ts. */
export class InvalidPolicyContentError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "InvalidPolicyContentError";
  }
}

/** Thrown by lifecycle.ts's `assertValidTransition()` for any transition
 *  not in `LIFECYCLE_TRANSITIONS` — including any attempt to leave
 *  ARCHIVED (terminal) or to skip a required step (e.g. DRAFT → ACTIVE
 *  directly, bypassing TESTING/APPROVED). */
export class PolicyLifecycleError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal policy status transition: ${from} → ${to}.`);
    this.name = "PolicyLifecycleError";
  }
}

/** Thrown when `actor` lacks the required RBAC permission for the
 *  attempted registry mutation (see authorizer.ts). */
export class PolicyAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyAuthorizationError";
  }
}

/** Maker-checker guard: the same userId that authored/last-edited a policy
 *  version may not also be the one who approves it. See
 *  policy-registry.ts's `transitionStatus()`. */
export class SelfApprovalNotAllowedError extends Error {
  constructor(userId: number) {
    super(`User ${userId} authored this policy version and may not also approve it.`);
    this.name = "SelfApprovalNotAllowedError";
  }
}

/** Thrown when `actor.assuranceMethods` does not include at least one
 *  strong-assurance method for a sensitive transition (today: → ACTIVE).
 *  See lifecycle.ts's `SENSITIVE_TRANSITIONS` / policy-registry.ts. */
export class InsufficientAssuranceError extends Error {
  constructor(status: string) {
    super(`Transitioning a policy to ${status} requires a strong-assurance authentication method on this session.`);
    this.name = "InsufficientAssuranceError";
  }
}

/**
 * Phase 16 (Policy Versioning). Thrown by `assertVersionSlotFree()`
 * (policy-registry.ts) when the exact `(policyId, version)` slot a
 * `createPolicy()`/`createNewVersion()` call is about to insert into
 * ALREADY has a row on file — i.e. `getLatestVersionNumber()`'s earlier
 * read was stale (a concurrent writer inserted into this same slot in the
 * meantime). This is a genuine TOCTOU race, not a user input error: two
 * concurrent admins (or an admin plus a retried request) both computing
 * "next version = N" from a read that is no longer current. Rule 11
 * ("Policy changes must be versioned") requires every version row to be
 * insert-once; silently overwriting or silently renumbering around the
 * collision would both violate that. The caller's correct response is to
 * retry the whole create/version-bump call (which will re-read the latest
 * version number and compute a fresh slot) — never to catch this and
 * proceed with the stale `version` value. */
export class PolicyVersionConflictError extends Error {
  constructor(
    readonly policyId: string,
    readonly version: number,
  ) {
    super(`Policy "${policyId}" version ${version} was concurrently created by another writer — retry the operation.`);
    this.name = "PolicyVersionConflictError";
  }
}
