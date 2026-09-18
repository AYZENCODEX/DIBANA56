# AYZEN Policy & Authorization Mega Engine — Phase 13: Separation of Duties

## Scope

Implements the roadmap's Phase 13 section verbatim: "Support constraints
such as: creator != approver, requester != reviewer, key-rotator != sole
approver. Prioritize finance, vault, security and organization
administration."

Before this pass, the merge chain was: main archive shipped through Phase
10B; Phase 11 (Temporary/Expiring Access) and Phase 12 (Approval Engine)
had been delivered separately and were merged into the main codebase as
this pass's own prerequisite (migration numbering 100 → 101 → new,
`lib/policy/index.ts` barrel sequence, and the `lib/db` schema barrel all
had to land in order first). See `CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE11.md`
/ `..._PHASE12.md` for those two phases' own reports; this document covers
Phase 13 only.

## Why this reduces to two existing data sources, not a new one

The roadmap names three examples. All three share one shape — "the
subject who already touched this resource in role A must not also perform
this action in role B" — which reduces to two checks a
`SeparationOfDutyConstraint` can opt into independently, using data this
engine already has:

1. **"creator != approver"** — `resource.ownerId === subject.userId`. No
   new schema, no new provider: `ResourceRef.ownerId` is a field
   `ownership-rule.ts` (Phase 03A) already reads off every request.

2. **"requester != reviewer" / "key-rotator != sole approver"** — a
   registered set of conflicting ReBAC relations (Phase 04). Holding a
   write-capable relation (`owner`/`editor`/`manager`) on a resource and
   then also attempting to `approve` on that same resource is the
   conflict. This reuses Phase 04's existing `RelationshipProvider` /
   `resolveRelations()` resolver — no new schema, no new provider.
   `relation-action-map.ts`'s own header (Phase 04) already anticipated
   this exact use: the `approver` relation is documented there as "never
   also granted write ... per the roadmap's Phase 13 (Separation of
   Duties) concern this relation exists to support."

"Key-rotator != sole approver" is treated as the same conflict shape as
"requester != reviewer", applied to a vault-key-rotation resource
specifically (see the test suite's dedicated
`sylo.encryption_key.approve` case) — not as a request for a
multi-signature/quorum feature. The roadmap's wording is a conflict
constraint ("the rotator may not be the approver"), not a headcount
requirement ("at least N approvers"); the latter is a different,
unrequested feature (Rule 16).

## What this pass built

| File | What it does |
|---|---|
| `lib/policy/sod/types.ts` (**new**) | `SeparationOfDutyConstraint` — `id`, optional `actions` (RBAC's `permissionMatches()` grammar, same "omit = every action" default every other requirement list in this engine uses), `blockResourceOwner` (default `true`), `conflictingRelations` (`RelationKind[]`, Phase 04's vocabulary), optional `message`. Caller-constructed, not persisted — same posture `AssuranceRequirement`/`ApprovalRequirement` already established. |
| `lib/policy/sod/separation-of-duties-rule.ts` (**new**) | `createSeparationOfDutiesRule(constraints, relationshipProvider?)` — a DENY-only gate (never ALLOW, same one-sided posture `assurance-rule.ts` established for STEP_UP). For every constraint whose `actions` cover the request's action: checks `resource.ownerId === subject.userId` first (if `blockResourceOwner`), then checks the subject's ReBAC relations on the resource against `conflictingRelations` (if a `RelationshipProvider` was supplied and `resource.id` is present) — returns the first conflict found as `deny(..., "SEPARATION_OF_DUTIES_VIOLATION")`, or abstains (`null`) if nothing conflicts. |
| `lib/policy/sod/index.ts` (**new**) | Barrel. No Drizzle provider to exclude — this phase introduces no new persistence at all (reuses `ResourceRef.ownerId` and Phase 04's existing `RelationshipProvider`). |
| `lib/policy/decision-reasons.ts` (**changed**) | Added `SEPARATION_OF_DUTIES_VIOLATION` to `DecisionReasonCode` and its description — kept distinct from every other `*_DENIED`/`*_VIOLATION` code so audit logs can tell "the same person is on both sides of this workflow" apart from any other rule's denial, without inspecting `policyId`. |
| `lib/policy/index.ts` (**changed**) | `./sod` added to the top-level barrel. |
| `scripts/src/test-policy-separation-of-duties.ts` (**new**) | 22 DB-free tests. |

## Design decisions worth calling out

- **DENY, not STEP_UP — a hard, unconditional stop.** Unlike
  `assurance-rule.ts` (which gates with STEP_UP — more authentication can
  satisfy it), no amount of additional assurance fixes "you are also the
  person who created/requested/rotated the thing you are now trying to
  approve/review." Same posture `locked-resource-rule.ts` and the DENY
  half of `explicit-grant-rule.ts` already take for their own hard stops
  — must win via deny-overrides (`policy-engine.ts`) regardless of
  registration order. Pinned directly by the "SoD DENY beats an ownership
  ALLOW regardless of registration order" test (both orderings assert
  `DENY`/`SEPARATION_OF_DUTIES_VIOLATION`).
- **This rule never returns ALLOW.** Same one-sided posture
  `assurance-rule.ts` documents: it only ever *removes* a path an
  otherwise-permitted subject would have had for the narrow "same person,
  conflicting role" case the roadmap names; it says nothing about
  role/ownership/relationship/attributes/approval-state on its own.
- **Both checks are evaluated per matching constraint — no "strictest
  wins" the way `assurance-rule.ts` picks one requirement.** A
  separation-of-duties conflict is a plain boolean per check (there is no
  "worse" violation to prefer), so the rule walks every matching
  constraint and returns the first conflict found (resource-owner check
  first, then relations); which one is reported only affects the DENY's
  `message` wording, never whether a conflict is found.
- **Omitting a `RelationshipProvider` is not an error.** Same "no data
  source, nothing to check, abstain rather than fabricate" posture
  `rebac-rule.ts`/`approval-gate-rule.ts` take toward their own optional
  storage reads — a caller who only needs the `blockResourceOwner` check
  (no storage read required, `ownerId` is already on the request) may
  construct this rule with no provider at all. Pinned by "conflictingRelations
  set but no RelationshipProvider constructed — check is skipped, never
  throws."
- **No new precedence tier.** `precedence-tiers.ts`'s existing tier 4
  ("Resource deny") is the natural home — same tier
  `locked-resource-rule.ts` and the DENY half of `explicit-grant-rule.ts`
  already occupy, since a separation-of-duties conflict is, like those
  two, a fact about *this* resource rather than a tenant-wide or global
  policy. Tier assignment remains a registration-time choice by whoever
  wires up a `PrecedenceEngine` instance — same posture every gate/deny
  rule in this engine already documents; nothing in `precedence-tiers.ts`
  changed.
- **No new schema, no new migration.** Both checks reuse data this engine
  already collects (`ResourceRef.ownerId` from Phase 01, ReBAC relations
  from Phase 04) — Phase 13 adds zero new tables/columns.

## What is deliberately NOT in Phase 13

- **No route/middleware calls `createSeparationOfDutiesRule()`** — real
  wiring is Phase 19 (PEP), same posture every earlier phase's
  engine/rule shipped with.
- **No action-history ledger** for "who performed the triggering action"
  beyond what already exists. `resource.ownerId` and ReBAC relations are
  the two "who is already involved with this resource" facts this
  codebase has; Phase 12's `approval_requests.initiatorUserId` already
  answers this exact question for anything that goes through the
  Approval Engine specifically. A general-purpose action-history table is
  a larger, separate feature the roadmap's Phase 13 text does not ask for
  (Rule 16).
- **No "at least N distinct approvers" quorum/multi-signature concept.**
  "Key-rotator != sole approver" is a conflict constraint, not a
  headcount requirement — see above.
- **No integration with `ApprovalEngine`/`createApprovalGateRule()`.**
  Phase 12's `SelfDecisionNotAllowedError` already covers the identical-
  user case for anything that goes through an `approval_requests` row;
  Phase 13's rule is a broader, independent PDP-level gate that applies
  even to actions that never create an approval request at all. Wiring
  the two together (e.g. having a future route register both under the
  same precedence tier) is a registration-time decision for whoever
  builds that route, not something this phase decides.
- **No new precedence tier, no `PrecedenceEngine` registration** — see
  design decisions above.
- **No admin/write API** for managing constraints — same "engine only,
  route wiring is a later phase" posture as every prior phase.

## Verification — actually run to confirm

- **`npx tsx scripts/src/test-policy-separation-of-duties.ts`** — **22/22
  pass.**
- **Full regression** — every `scripts/src/test-policy-*.ts` suite
  re-run (18 pre-existing + this phase's new one, 19 total) — **all
  pass, no regressions.**
- **Isolated `tsc --noEmit --strict` type-check** of the full
  `lib/policy` barrel (`artifacts/api-server/src/lib/policy/index.ts`,
  drizzle providers excluded per every earlier phase's own precedent) —
  **no errors from any Phase 11/12/13 code.** The only two errors
  reported (`express` types not found, `node:crypto` types not found)
  are the same pre-existing sandbox environment gaps
  `CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE12.md` already documented
  (`node_modules`/`@types/node`/`express` not installed — no network in
  this sandbox), unrelated to this phase's code.
- **Dynamic-code-execution audit:** no `eval`/`new Function`/`vm.Script`
  in `lib/policy/sod/*`.
- **SQL-injection / DB-surface audit:** `lib/policy/sod/*` imports
  nothing from `@workspace/db` or `drizzle-orm` at all — this phase adds
  zero new persistence.
- **`pnpm run typecheck` (full workspace)** could not be run in this
  sandbox — `node_modules` cannot be installed (no network). Same known
  limitation every phase since Phase 02 has documented; the isolated
  `tsc` check above is the mitigation.

## Security tests covered

- **Creator/approver conflict:** the resource's own `ownerId` is denied a
  matching action; a non-owner is not blocked by this check alone.
- **Relation conflict:** `owner`/`editor`/`manager` relations conflict
  with a matching `approve` action; a `viewer` relation and the
  `approver` relation itself do not (a legitimate, uninvolved approver is
  never wrongly blocked).
- **IDOR / resource-ID substitution:** a conflicting relation on resource
  555 does not leak to a substituted resourceId 556.
- **Cross-user:** a conflicting relation granted to one user does not
  extend to a different subject.
- **Privilege escalation:** forging unrelated resource fields
  (`classification`, `organizationId`) does not manufacture a conflict
  that shouldn't exist.
- **Unauthenticated:** never reaches the rule at all (engine-level
  UNAUTHENTICATED fires first).
- **Composition/precedence:** a SoD DENY beats an ownership ALLOW
  regardless of registration order; when there is no conflict, SoD
  abstains and lets another rule's ALLOW through untouched.
- **Determinism:** the same request object evaluated twice yields the
  same effect and reason.
- **Fail-safe defaults:** an omitted `RelationshipProvider`, a missing
  `resource.id`, or a resource with no `ownerId` at all all abstain
  cleanly rather than throwing or fabricating a conflict.

## Regression status
No regressions — all 19 `test-policy-*.ts` suites pass.

## Migration status
No migration. This phase adds zero new schema/tables/columns — see
"design decisions" above. Nothing route/middleware-level calls this
rule yet (same dormant, additive posture every phase before it shipped
with).

## Next phase
Per the roadmap, the next formal audit gate is Phase 15 (Policy Logic
Audit) — Phase 14 (Policy Simulation / dry-run mode) is next in sequence.
