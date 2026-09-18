# AYZEN Policy & Authorization Mega Engine — Phase 21A (Policy Test Framework — declarative model)

## Scope

Roadmap Phase 21 section implemented, verbatim, for its framework half only:

> "Declarative test model:
>  GIVEN subject + resource + context
>  WHEN action
>  THEN decision
>
>  Every policy should have:
>  - happy path
>  - negative path
>  - boundary cases
>  - privilege escalation case
>  - tenant isolation case"

This sub-phase ships the framework itself — the GIVEN/WHEN/THEN case
shape, the five-category coverage vocabulary, and a runner that
evaluates a case against a real engine and reports pass/fail plus
category-coverage gaps. It does **not** rewrite every existing
`scripts/src/test-policy-*.ts` suite into this declarative shape with
full five-category coverage — that is Phase 21B, applying this
framework across every already-shipped policy rule, one rule at a
time. Shipping the framework and immediately claiming every rule is
"covered" without writing that coverage would be exactly the kind of
premature completion Rule 16 warns against.

## Implementation

New directory `lib/policy/test-framework/`:

- **`types.ts`** — `PolicyTestGiven`/`PolicyTestWhen` are
  `BuildAuthorizationRequestInput` split at the roadmap's own GIVEN/WHEN
  seam (never a second, parallel request shape). `PolicyTestExpectation`
  matches on whatever a case's `then` actually sets — `effect` is
  required, `reason`/`policyId`/`requiredAssurance` are optional,
  exact-match-when-present. `PolicyTestCategory` is a closed, five-value,
  roadmap-verbatim union so coverage checking can be exhaustive.
  `PolicyTestCase` (name + category + given + when + then) and
  `PolicyTestSuite` (policyId + cases[]) round out the model.

- **`runner.ts`** — `runPolicyTestCase()` calls `engine.evaluate()`, the
  exact same method `authorize()`/`authorizeMany()`/every real route
  eventually calls; it never re-implements combining logic or produces a
  decision of its own. A mismatched `then` field is reported in the
  returned `failures` array, never thrown. `runPolicyTestSuite()` runs
  every case in a suite and additionally reports `missingCategories` (in
  the roadmap's own listed order) — a suite of all-passing `happy_path`
  cases is reported `passed: false` until all five categories are
  present, since a coverage gap is exactly the kind of thing a long,
  all-passing case list can hide from a human reviewer.
  `assertPolicyTestSuitePassed()` is the thin `node:assert`-shaped
  wrapper every `scripts/src/test-policy-*.ts` file's existing
  `test()`/`assert` harness can call directly.

- **`index.ts`** — barrel for the two files above; no Drizzle provider to
  exclude (this directory only ever touches a caller-supplied
  `PolicyEngine`/`PrecedenceEngine`).

`lib/policy/index.ts` re-exports `./test-framework`.

## Tests

`scripts/src/test-policy-test-framework.ts` (`npx tsx
scripts/src/test-policy-test-framework.ts`) tests the framework itself
against a real `PolicyEngine` wired with three already-shipped rules
(RBAC, resource-ownership, organization-access):

- A real "vault-access" GIVEN/WHEN/THEN suite covering all five roadmap
  categories, run end-to-end and reported as fully passing — kept as
  living documentation of how to write one, not a placeholder. Its RBAC
  fixture grants the read permission on a dedicated `vault-reader` role
  assigned to exactly one subject, rather than on the shared baseline
  role every subject holds — granting it on the shared role would let
  RBAC silently ALLOW every subject and defeat the suite's own
  negative-path/tenant-isolation cases before organization-access ever
  got a chance to run.
- `runPolicyTestCase()` reports a mismatched expectation in `failures`
  without throwing, and returns the real decision alongside it.
- Optional `then` fields (`policyId`, `requiredAssurance`) are confirmed
  to be checked only when a case actually sets them.
- `runPolicyTestSuite()` reports every missing category, in the
  roadmap's own listed order, independent of whether the present cases
  pass.
- `assertPolicyTestSuitePassed()` is silent on a passing suite and
  throws a readable summary (failing case names + failure lines +
  missing categories) on a failing one.

All suites pass:

```
npx tsx scripts/src/test-policy-test-framework.ts
```

## Deliberately not done here (Phase 21B)

Declarative, five-category-covered suites for every other already-shipped
policy rule (ownership beyond the one case above, explicit resource
grants, locked-resource, ReBAC, ABAC, registry/PAP, precedence, assurance,
risk, temporary access, approval, SoD). This phase only makes writing
that coverage possible.
