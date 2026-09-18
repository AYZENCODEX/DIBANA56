# AYZEN Policy & Authorization Mega Engine — Phase 14: Policy Simulation

## Scope

Implements the roadmap's Phase 14 section verbatim:

> Add dry-run mode.
> Input: subject, action, resource, context.
> Output: decision, policy, version, matched rules, reason, required
> assurance.
> Simulation must NEVER execute the business action.

Before this pass, the codebase shipped through Phase 13 (Separation of
Duties) — see `CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE13.md`. This
document covers Phase 14 only.

## Why this is "run the real engine and report what happened", not a
## second engine

The roadmap's own output list — decision, policy, version, matched rules,
reason, required assurance — is a request for *visibility* into an
authorization decision, not a different decision-making process. A
simulation whose combining logic could ever diverge from what a real
`evaluate()` call would decide (e.g. a hand-maintained second copy of
`PolicyEngine`'s deny-overrides loop) would be strictly worse than no
simulation at all: an admin trusting a simulated ALLOW that a real request
would actually DENY is a security bug, not a UX inconvenience.

So Phase 14 adds exactly one capability to each existing engine —
`evaluateWithTrace()` — that runs the *exact same* internal loop
`evaluate()` already runs (both are now thin wrappers around a shared,
refactored `evaluateCore()`) and additionally returns which rules it
consulted, in order, including abstentions. The new `lib/policy/simulation/`
module is then just a thin, read-mostly adapter over that: call
`evaluateWithTrace()`, optionally look up a version number from the
existing Phase 07 registry, and reshape the result into the roadmap's own
named fields. Nothing about how any individual `PolicyRule` (RBAC,
ownership, ReBAC, ABAC, assurance, risk, temporary access, approval,
separation-of-duties) executes changes based on whether it was invoked
from `evaluate()` or from a simulation — there is no "dry run" flag
threaded through any rule.

## What this pass built

| File | What it does |
|---|---|
| `lib/policy/policy-engine.ts` (**changed**) | Added `RuleEvaluationTrace` (`{ id, decision }`) and a new public `evaluateWithTrace()` method. Refactored the private `evaluateCore()` to build this trace unconditionally (every rule actually invoked, including abstentions, in order) and return it alongside the decision/request it already returned. `evaluate()` itself is now a two-line wrapper that discards the trace — its own behavior, return type, and the `onDecision` observer contract are all byte-for-byte unchanged. |
| `lib/policy/precedence-engine.ts` (**changed**) | Same shape of change: added `PrecedenceRuleTrace` (`{ id, tier, decision }`) and `evaluateWithTrace()`. The previously-inline `evaluate()` loop was extracted into a private `evaluateCore()` that builds this trace unconditionally (independent of, and in addition to, the pre-existing `onTierEvaluated` hook, which is untouched — same tiers, same non-abstaining-only semantics, same call sites). `evaluate()` is now a two-line wrapper around `evaluateCore()` that discards the trace. |
| `lib/policy/types.ts` (**changed**) | Added one new optional field to `AuthorizationDecision`: `requiredAssurance?: string`. Populated only by a rule that gates on a *named* minimum assurance level — today, only `assurance/assurance-rule.ts`'s STEP_UP — so the roadmap's "required assurance" simulation output can be a structured field instead of text parsed back out of `message`. Every other decision producer leaves it `undefined`; this is purely additive (optional field, no existing code reads or requires it). |
| `lib/policy/authorization-decision.ts` (**changed**) | `stepUp()` gained an optional `requiredAssurance` option, threaded through `stamp()`'s existing signature (one new optional parameter). `allow()`/`deny()`/`approvalRequired()` are untouched. |
| `lib/policy/assurance/assurance-rule.ts` (**changed**) | Its one `stepUp()` call site now also passes `requiredAssurance: requirement.minimumLevel` — the actual unmet level, verbatim. This is the ONLY rule in the codebase that populates the new field (see `risk/risk-rule.ts`'s own STEP_UP, deliberately left untouched — see "design decisions" below). |
| `lib/policy/simulation/types.ts` (**new**) | Pure types: `SimulationInput` (= `BuildAuthorizationRequestInput`, so simulating and actually authorizing ask the PDP the identical question), `MatchedRuleTrace`, `MatchedTierTrace`, and `PolicySimulationResult` — the roadmap's own field list (decision/policy/version/matched-rules/reason/required-assurance), each mapped 1:1 in the type's own doc comment, plus `requestId`/`evaluatedAt` for parity with every other decision this engine already produces. |
| `lib/policy/simulation/policy-simulator.ts` (**new**) | `simulatePolicy(engine, input, options?)` and `simulatePrecedence(engine, input, options?)` — the whole Phase 14 surface. Each calls its target engine's new `evaluateWithTrace()`, reshapes the trace into `matchedRules`/`matchedTiers`, and — only if an `options.registryProvider` (Phase 07's existing `PolicyRegistryProvider` interface) was supplied — attempts a best-effort, never-throwing `getActivePolicy(decision.policyId)` lookup to populate `policyVersion`. |
| `lib/policy/simulation/index.ts` (**new**) | Barrel. No Drizzle provider to exclude — this phase adds zero new persistence (the optional registry lookup reuses Phase 07's existing interface; it neither constructs nor requires a real Drizzle-backed provider). |
| `lib/policy/index.ts` (**changed**) | `./simulation` added to the top-level barrel. |
| `scripts/src/test-policy-simulation.ts` (**new**) | 21 DB-free tests. |

## Design decisions worth calling out

- **`evaluateWithTrace()` is additive, not a replacement.** `evaluate()`'s
  own return type, timing, and observer-firing behavior are unchanged on
  both engines — verified directly by re-running every pre-existing
  `test-policy-*.ts` suite (see Verification below) with zero modification
  to any of them. A caller who never touches the new method gets exactly
  Phase 1A/1C/08's own behavior.
- **The trace records abstentions, not just decisive rules.** The roadmap
  says "matched rules" — read narrowly, that's
  `matchedRules.filter(r => r.decision !== null)`. The full list (including
  `decision: null` entries) is what the field itself holds, so an
  admin/debug caller can also answer "was this rule even consulted"
  (useful for "why didn't policy X apply here" — the answer is sometimes
  "it never ran at all" because an earlier rule already short-circuited via
  deny-overrides, which the trace makes directly visible via where it
  stops).
- **`requiredAssurance` is a new structured field on `AuthorizationDecision`
  itself, not something simulation derives by parsing `message`.** This
  keeps the field trustworthy for a UI/API consumer (a `message` string is
  documented everywhere else in this engine as human-readable-only, never
  meant to be machine-parsed) at the cost of one new optional field on a
  type that hasn't changed shape since Phase 1A. Deliberately populated by
  exactly one rule (`assurance-rule.ts`) — `risk/risk-rule.ts`'s own
  MEDIUM-risk STEP_UP is left `undefined`, because risk-driven step-up has
  no "named minimum level" to report (it's driven by a risk tier, not an
  `AssuranceLevel`); fabricating one would be inventing information the
  risk rule was never given.
- **`policyVersion` enrichment is best-effort, optional, and correctly
  `undefined` most of the time today.** Phase 07's own header already
  states nothing in this codebase yet loads registry policies into either
  engine as rules — every rule actually registered anywhere today (RBAC,
  ownership, ReBAC, assurance, risk, separation-of-duties, ...) is a
  hand-constructed `PolicyRule` from its own phase's module, with a
  hand-picked `policyId` string like `"rbac"`/`"assurance"`/`"risk"`/`"sod"`
  — none of which exist as rows in the Phase 07 registry. `policyVersion`
  is therefore `undefined` for essentially every simulation this codebase
  can currently run, and that is the CORRECT, honest answer, not a bug —
  the field exists so that once a future phase wires registry-backed
  policies into either engine as actual rules, simulations of THOSE
  policies immediately gain a real version number with zero further change
  to this module. Pinned directly by five dedicated tests (hit, no
  provider, no matching row, throwing provider, and the engine's own
  no-`policyId` fallback) — none of the five failure/absence modes ever
  throws out of `simulatePolicy()`/`simulatePrecedence()`.
- **Simulation cannot execute a business action — by construction, not by
  a runtime flag.** Neither `simulatePolicy()` nor `simulatePrecedence()`
  accepts anything resembling "the operation to perform" as a parameter;
  their only two operations are (1) call the target engine's own
  `evaluateWithTrace()` and (2) an optional read-only registry lookup.
  There is no code path here that could reach a business service even if
  misused. Pinned by a dedicated test using a "business action spy" that a
  simulation call must never invoke, plus a signature-arity assertion.
- **No new `DecisionReasonCode`.** Simulation surfaces the same reason
  codes every other phase already produces — it doesn't introduce a new
  category of denial/outcome, only a new way to observe an existing one.
- **No admin/route wiring.** Same "engine only, route wiring is a later
  phase" posture every prior phase shipped with — nothing calls
  `simulatePolicy()`/`simulatePrecedence()` from any route yet (that's
  Phase 19/23 territory: an admin-console "test this policy" endpoint would
  be the natural caller, per the roadmap's own Phase 23 "Simulations"
  admin section).

## What is deliberately NOT in Phase 14

- **No bridge from the Phase 07 registry into either engine's rule list.**
  Registry policies still aren't loaded as `PolicyRule`s anywhere in this
  codebase — Phase 07's own header already documented this as future work,
  and Phase 14 doesn't change that; it only makes `policyVersion`
  enrichment ready for when it happens (see design decisions above).
- **No `requiredAssurance` for risk-driven STEP_UP.** See design decisions
  above — this is a deliberate absence, not an oversight, since risk-rule.ts
  has no named level to report.
- **No new precedence tier, no engine-combining-algorithm change.**
  `evaluateWithTrace()` is a pure observation addition to the exact same
  algorithm each engine already implements.
- **No API/route surface.** Simulation is an importable function pair, not
  an endpoint — same posture Phase 07's `PolicyRegistry` itself shipped
  with ("This file provides the engine, not the endpoint").

## Verification — actually run to confirm

- **`npx tsx scripts/src/test-policy-simulation.ts`** — **21/21 pass.**
- **Full regression** — every `scripts/src/test-policy-*.ts` suite
  re-run (19 pre-existing + this phase's new one, 20 total) — **all
  pass, no regressions.**
- **Isolated `tsc --noEmit --strict` type-check** of the full
  `lib/policy` barrel (`artifacts/api-server/src/lib/policy/index.ts`,
  Drizzle providers excluded per every earlier phase's own precedent) —
  **no errors from any Phase 14 code.** The only two errors reported
  (`express` types not found, `node:crypto` types not found) are the same
  pre-existing sandbox environment gaps every phase since Phase 02 has
  documented (no `node_modules`/`@types/node`/`express` installed in this
  repo's own workspace). To actually execute the suites in this sandbox, a
  scratch `typescript`/`tsx`/`@types/node` toolchain was installed
  *outside* the repo (`/tmp/tstools`, not committed, not part of this
  diff) — the isolated `tsc` check against the repo's own (uninstalled)
  dependency set remains the documented mitigation, same as every prior
  phase.
- **Dynamic-code-execution audit:** no `eval`/`new Function`/`vm.Script`
  anywhere in `lib/policy/simulation/*`, `policy-engine.ts`, or
  `precedence-engine.ts`.
- **SQL-injection / DB-surface audit:** `lib/policy/simulation/*` imports
  nothing from `@workspace/db` or `drizzle-orm` — only type-only imports
  from sibling `lib/policy/*` modules (including Phase 07's existing
  `PolicyRegistryProvider` *interface*, never a concrete Drizzle
  implementation). This phase adds zero new persistence.
- **`pnpm run typecheck` (full workspace)** could not be run in this
  sandbox — `node_modules` cannot be installed via the workspace's own
  package manager (no network path to a private/lockfile-pinned install in
  this sandbox's egress allowlist for that specific flow). Same known
  limitation every phase since Phase 02 has documented; the isolated `tsc`
  check above (plus the scratch-toolchain execution run) is the
  mitigation.

## Security tests covered

- **Never executes a business action:** a dedicated "business action spy"
  test confirms `simulatePolicy()` has no code path capable of invoking
  anything beyond the target engine's own `evaluateWithTrace()` and the
  optional read-only registry lookup; a second test pins the function's
  own arity (no hidden "action to perform" parameter).
- **Fail-safe registry enrichment:** an absent provider, a provider with no
  matching row, and a provider that itself throws all resolve
  `policyVersion` to `undefined` — none ever throws out of
  `simulatePolicy()`/`simulatePrecedence()`, so a registry outage can never
  turn a working simulation into a failed one.
- **Equivalence with real evaluation:** every simulation test asserts the
  simulated `effect`/`reason`/`policyId` matches what a real `evaluate()`
  call for the identical input actually returns — including a deny-
  overrides case (a later DENY overriding an earlier ALLOW) and a real,
  non-synthetic ownership-style rule, not only fixed-verdict stand-ins.
- **Short-circuit correctness:** `matchedRules` for a DENY-short-circuited
  evaluation contains only the rules actually invoked up to and including
  the deciding one — never a rule that was registered but never reached.
- **Invalid/unauthenticated inputs never throw:** both resolve to a
  complete, well-formed `PolicySimulationResult` (empty `matchedRules`,
  correct `reason`), never an unhandled exception.
- **Determinism:** two simulations of the identical input agree on
  effect/reason/matchedRules shape.

## Regression status
No regressions — all 20 `test-policy-*.ts` suites pass (19 pre-existing +
Phase 14's new suite).

## Migration status
No migration. This phase adds zero new schema/tables/columns — the
optional registry-version lookup reuses Phase 07's existing
`PolicyRegistryProvider` interface and existing `policy_registry`
table/rows; nothing new is persisted. Nothing route/middleware-level calls
`simulatePolicy()`/`simulatePrecedence()` yet (same dormant, additive
posture every phase before it shipped with).

## Next phase
Per the roadmap, the next formal audit gate is Phase 15 (Policy Logic
Audit) — Phase 15 (Explainability) is next in sequence.
