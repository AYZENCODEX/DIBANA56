# AYZEN Policy & Authorization Mega Engine — Phase 21B (Policy Test Framework — declarative coverage)

## Scope

Roadmap Phase 21 section, applied across every already-shipped policy
rule. Phase 21A shipped the framework (GIVEN/WHEN/THEN case shape, the
five-category vocabulary, `runPolicyTestSuite()`); this phase applies it,
one rule at a time, writing the actual coverage — happy path, negative
path, boundary, privilege escalation, tenant isolation — that framework
only made possible.

## Implementation

Twelve `scripts/src/test-policy-declarative-*.ts` files, each a single
`PolicyTestSuite` for one rule (or the minimal companion pairing a
gate-only rule needs to produce a genuine ALLOW):

| File | Rule(s) under test | Companion rule (gate-only rules need one for `happy_path`) |
|---|---|---|
| `-rbac.ts` | `createRbacRule()` | — |
| `-ownership.ts` | `createResourceOwnershipRule()` | — |
| `-rebac.ts` | `createRebacRule()` | — |
| `-abac.ts` | `createAbacRule()` | — |
| `-organization-access.ts` | `createOrganizationAccessRule()` | — |
| `-explicit-grant.ts` | `createExplicitResourceGrantRule()` | — |
| `-locked-resource.ts` | `createLockedResourceRule()` | resource-ownership |
| `-assurance.ts` | `createAssuranceRule()` | resource-ownership |
| `-risk.ts` | `createRiskRule()` | resource-ownership |
| `-approval.ts` | `createApprovalGateRule()` | — (can ALLOW on its own) |
| `-separation-of-duties.ts` | `createSeparationOfDutiesRule()` | resource-ownership |
| `-temporary-access.ts` | `createTemporaryAccessRule()` | — (can ALLOW on its own) |

Every file follows the same shape established by the first eight: a
dedicated `PolicyEngine`, in-memory fakes for whatever provider the rule
needs (same fakes — `FakeRbacProvider`, `FakeRelationshipProvider`,
`FakeResourceGrantProvider`, `FakeTemporaryAccessGrantProvider`,
`FakeApprovalRequestProvider` — every existing `test-policy-*.ts` suite
already uses), five `PolicyTestCase`s tagged with all five roadmap
categories, `runPolicyTestSuite()` + `assertPolicyTestSuitePassed()`.

Notes on the four rules added this phase, since each has a real
asymmetry from the first eight:

- **risk** — never ALLOWs (LOW/unset abstain, MEDIUM STEP_UPs, HIGH
  DENYs unconditionally); registered alongside resource-ownership so
  `happy_path` has a genuine ALLOW to observe. `boundary` pins down that
  an entirely unset `riskLevel` is treated identically to `"low"`, not
  guessed as `"high"`.
- **temporary-access** — allow-only, keyed on `context.timestamp`
  against the rule's own half-open interval `[startsAt, expiresAt)`.
  `negative_path`/`boundary` pin both edges of that interval
  (`expiresAt` exclusive, `startsAt` inclusive) rather than only
  approaching the boundary from one side.
- **approval-gate** — the one gate in this engine that CAN ALLOW on its
  own (a live `APPROVED` row IS the grant), so unlike the other three
  additions it needed no companion rule. `boundary` covers a `REJECTED`
  prior request being treated identically to "never requested at all"
  (still `APPROVAL_REQUIRED`, never a permanent DENY) — a real,
  non-obvious code path distinct from the plain "no row on file"
  `negative_path` case.
- **separation-of-duties** — never ALLOWs, and uniquely among this
  phase's four runs TWO independent checks per matching constraint
  (`blockResourceOwner` + `conflictingRelations`). `boundary` exercises
  the relations check specifically (non-owner holding a conflicting
  `editor` relation), distinct from `negative_path`'s owner check, so
  both independent code paths inside the rule get their own case.

## Bug caught while writing this phase

The first draft of `-separation-of-duties.ts`'s own `happy_path` case
made the subject their own resource's owner while attempting to
`approve` it — which the rule correctly denies (that IS the "creator !=
approver" conflict this rule exists to catch), so the case was actually
asserting the wrong thing. Fixed by using an action outside the
registered constraint's `actions` scope (a plain read) for `happy_path`
instead — the gate never even reaches its conflict checks for an action
it wasn't asked to constrain, which is what genuinely demonstrates
abstention.

## Tests

```
npx tsx scripts/src/test-policy-declarative-abac.ts
npx tsx scripts/src/test-policy-declarative-approval.ts
npx tsx scripts/src/test-policy-declarative-assurance.ts
npx tsx scripts/src/test-policy-declarative-explicit-grant.ts
npx tsx scripts/src/test-policy-declarative-locked-resource.ts
npx tsx scripts/src/test-policy-declarative-organization-access.ts
npx tsx scripts/src/test-policy-declarative-ownership.ts
npx tsx scripts/src/test-policy-declarative-rbac.ts
npx tsx scripts/src/test-policy-declarative-rebac.ts
npx tsx scripts/src/test-policy-declarative-risk.ts
npx tsx scripts/src/test-policy-declarative-separation-of-duties.ts
npx tsx scripts/src/test-policy-declarative-temporary-access.ts
```

All twelve suites pass, each reporting all five roadmap categories
present. Also re-ran `test-policy-test-framework.ts` (Phase 21A's own
self-test) and `test-policy-pep.ts` (Phase 19) to confirm no regression
from the DB-free `lib/policy` barrel these suites all import through.

## Deliberately not done here

- **A DSL/registry-sourced policy's own declarative suite.**
  `test-policy-declarative-abac.ts`'s own header already points at this:
  every ABAC case in this phase uses hand-built `AbacPolicyDefinition`s,
  never a policy actually compiled from the Phase 06 DSL string and
  loaded through the Phase 07 registry (`registry-rule-loader.ts`'s
  `createRegistryPolicyRule()`). That is a materially different code
  path (parser → compiler → registry lifecycle → PDP) and deserves its
  own suite, not a shortcut folded into the hand-built ABAC file.
- **Precedence-engine-level coverage.** Every suite in this phase (and
  21A's own worked example) registers rules on a flat `PolicyEngine`.
  `PrecedenceEngine`'s own tiered, deny-overrides-within-tier resolution
  (Phase 08) has no declarative suite of its own yet — a real gap, since
  several rules this phase covers (risk's DENY, assurance's STEP_UP,
  SoD's DENY) explicitly defer their precedence-tier placement to
  whoever wires up a `PrecedenceEngine` instance.
