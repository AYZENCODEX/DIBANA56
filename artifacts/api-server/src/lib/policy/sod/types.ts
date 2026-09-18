/**
 * lib/policy/sod/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 13 (Separation of Duties).
 *
 * The one interface `createSeparationOfDutiesRule()`
 * (separation-of-duties-rule.ts) is written against — same "caller-
 * constructed, in-memory, not persisted/versioned/administered anywhere"
 * posture `AssuranceRequirement` (../assurance/assurance-rule.ts) and
 * `ApprovalRequirement` (../approval/approval-gate-rule.ts) already
 * established for their own requirement lists (Rule 16 — do not implement
 * future phases prematurely; a future Phase 07-style registry entry could
 * compile down to this shape later, but nothing in Phase 13 builds that
 * bridge).
 *
 * ── Two independent conflict sources, both optional, checked together ─────
 * The roadmap's Phase 13 section names three examples: "creator !=
 * approver", "requester != reviewer", "key-rotator != sole approver". All
 * three share one shape — "the subject who already touched this resource
 * in role A must not also perform this action in role B" — reduced here to
 * two checks a constraint can opt into independently:
 *
 *   1. `blockResourceOwner` — "creator != approver", using the
 *      `resource.ownerId` field `ownership-rule.ts` (Phase 03A) already
 *      reads. No new schema, no new provider: a resource's creator is
 *      already a fact the caller supplies on every `ResourceRef`.
 *
 *   2. `conflictingRelations` — "requester != reviewer" (and, for a Vault
 *      key-rotation resource specifically, "key-rotator != sole
 *      approver"), using Phase 04's ReBAC vocabulary
 *      (`../rebac/types.ts#RelationKind`) and its existing
 *      `RelationshipProvider`/`resolveRelations()` resolver abstraction —
 *      again no new schema, no new provider. `relation-action-map.ts`'s own
 *      header already anticipates this: the `approver` relation is
 *      documented there as "never also granted write ... per the roadmap's
 *      Phase 13 (Separation of Duties) concern this relation exists to
 *      support". Holding a WRITE-capable relation (`owner`/`editor`/
 *      `manager`) on a resource and then also attempting to `approve` on
 *      that same resource is exactly the conflict this check exists to
 *      catch, regardless of whether the two actions came through the same
 *      `approval_requests` row or not.
 *
 * A constraint may register either check, or both — see
 * `separation-of-duties-rule.ts`'s own header for why both are evaluated
 * per matching constraint rather than only the first that applies.
 *
 * ── Deliberately NOT modeled here ───────────────────────────────────────
 * - No "who performed the triggering action" history table (e.g. "who
 *   rotated this specific key on this specific date"). `resource.ownerId`
 *   and ReBAC relations are the two "who is already involved with this
 *   resource" facts this codebase already has; a genuine action-history
 *   ledger (distinct from Phase 12's `approval_requests.initiatorUserId`,
 *   which already answers this exact question for anything that goes
 *   through the Approval Engine) is a larger, separate feature this
 *   phase's roadmap text does not ask for (Rule 16).
 * - No "at least N distinct approvers" quorum/multi-signature concept —
 *   the roadmap's "key-rotator != sole approver" example is a conflict
 *   constraint (rotator cannot BE the approver), not a headcount
 *   requirement (requiring two or more approvers is a different, unasked-
 *   for feature).
 */

import type { RelationKind } from "../rebac/types";

/**
 * One "these two roles on this resource must not be held by the same
 * subject" statement, as `createSeparationOfDutiesRule()` consumes it.
 * Deliberately NOT persisted/versioned/administered anywhere — see file
 * header.
 */
export interface SeparationOfDutyConstraint {
  /** Stable identifier for this individual statement (distinct from the
   *  rule's own registration id). Surfaced in the decision's `message` for
   *  audit/debugging, same role `AssuranceRequirement.id` /
   *  `ApprovalRequirement.id` play. */
  id: string;
  /** Optional action pattern(s) this constraint applies to, using
   *  `permissionMatches()`'s grammar (e.g. `["ryft.payment.approve"]`).
   *  Omit to apply to every action regardless of what it is — same
   *  "no actions list means every action" default `abac-rule.ts`'s /
   *  `assurance-rule.ts`'s / `approval-gate-rule.ts`'s own
   *  `*AppliesToAction()` helpers already use. */
  actions?: string[];
  /** When true (the default), a subject who is the resource's own
   *  `ownerId` ("creator") is blocked from performing a matching action on
   *  that same resource — the roadmap's own "creator != approver" example.
   *  Set to `false` to skip this check for a constraint that only cares
   *  about `conflictingRelations` below. */
  blockResourceOwner?: boolean;
  /** ReBAC relation kinds (Phase 04's seven-value vocabulary,
   *  `../rebac/types.ts#RelationKind`) that conflict with a matching
   *  action — e.g. `["owner", "editor", "manager"]` blocks anyone who can
   *  write/manage the resource from also performing a matching `approve`
   *  action on it (the roadmap's "requester != reviewer" example).
   *  Omitted or empty means this check contributes nothing for this
   *  constraint — same "no requirement, nothing to check" abstain-by-
   *  default posture every optional-check field in this engine already
   *  uses. Checked only when `createSeparationOfDutiesRule()` was
   *  constructed with a `RelationshipProvider` (see that function's own
   *  header for what happens when one wasn't). */
  conflictingRelations?: readonly RelationKind[];
  /** Optional human-readable detail surfaced on a resulting DENY
   *  decision's `message`. Never put secrets/PII here — same rule as
   *  everywhere else in this engine. */
  message?: string;
}
