# AYZEN Policy & Authorization Mega Engine — Phase 15 (Explainability) + Phase 16 (Policy Versioning)

## Scope

Roadmap Phase 15 and Phase 16 sections implemented verbatim. Both phases
build only on what Phases 01-14 already shipped (`PolicyEngine`,
`compileAbacPolicy()`, the RBAC permission chain, the Phase 07 registry) —
no engine-level combining-algorithm change, no new DB tables beyond one
additive permission-catalog row.

## Files added

| File | What it does |
|---|---|
| `lib/policy/explain/types.ts` | `GENERIC_DENIAL_MESSAGE`, `PolicyExplanationDetail`, `AuthorizationExplanation`. |
| `lib/policy/explain/explain-authorization.ts` | `explainAuthorizationDecision()` — renders an already-produced decision into the two-audience shape; never re-evaluates. |
| `lib/policy/explain/viewer-authorization.ts` | `canViewExplanationDetail()` + `POLICY_EXPLANATION_PERMISSION` — RBAC gate for `detail`, reusing `resolveEffectivePermissions()`/`permissionMatches()` verbatim. |
| `lib/policy/explain/index.ts` | Barrel for the above three. |
| `migrations/102_ayzen_policy_explain_permission.sql` | Seeds `admin.policy.explain` permission + grants it to `admin`. No schema change. Idempotent. |
| `lib/policy/registry/registry-rule-loader.ts` | `createRegistryPolicyRule()` / `createRegistryPolicyRules()` — feeds an ACTIVE `PolicyRecord` into the PDP as a real `PolicyRule`, stamping `policyId`+`policyVersion` on every decision it produces. Reuses `compileAbacPolicy()`/`evaluateAbacCondition()`/`permissionMatches()` — no second evaluator. |
| `lib/policy/registry/reproducibility.ts` | `getDecisionPolicySnapshot()` — resolves a decision's exact `(policyId, policyVersion)` row, never "whatever is active now". |
| `scripts/src/test-policy-explainability.ts` | 26 DB-free tests. |
| `scripts/src/test-policy-versioning.ts` | 16 DB-free tests. |

## Files changed

| File | What changed |
|---|---|
| `lib/policy/types.ts` | Added `AuthorizationDecision.policyVersion?: number` — optional, additive, `undefined` for every pre-Phase-16 decision. |
| `lib/policy/authorization-decision.ts` | `allow()`/`deny()`/`stepUp()`/`approvalRequired()` all accept an optional `policyVersion` and stamp it through `stamp()`. |
| `lib/policy/decision-observer.ts` | `createLoggingObserver()`'s `toLogFields()` now includes `policyVersion`. |
| `lib/policy/registry/errors.ts` | Added `PolicyVersionConflictError`. |
| `lib/policy/registry/policy-registry.ts` | Added `assertVersionSlotFree()` — a last-check-before-write guard against a concurrent-writer race on the `(policyId, version)` slot. Called in both `createPolicy()` (slot 1) and `createNewVersion()` (slot `latest+1`), immediately before `insertVersion()`. |
| `lib/policy/registry/index.ts` | Barrel now also exports `registry-rule-loader.ts` and `reproducibility.ts`. |
| `lib/policy/index.ts` | Top-level barrel now also exports `./explain` (Phase 15). Phase 16 needed no new top-level export line — `registry-rule-loader.ts`/`reproducibility.ts` already flow through the existing `export * from "./registry"`. |

## Notable design points

- **Explainability never re-evaluates.** `explainAuthorizationDecision()`
  takes an already-produced `AuthorizationDecision` as input; it cannot
  disagree with the decision it explains, because it never computes one.
- **`userMessage` is one fixed string for every non-ALLOW effect,
  regardless of reason code.** Varying it by reason would itself leak
  policy internals (e.g. "denied — risk too high" tells an attacker their
  risk score is tracked).
- **`includeDetail` is always caller-supplied, decided server-side.**
  `explain-authorization.ts` has no notion of "who is asking" — that
  question belongs entirely to `canViewExplanationDetail()`, called by the
  PEP/route layer against a DB-verified `Subject`, never a client flag.
- **`createRegistryPolicyRule()` fails closed on a non-ACTIVE record,
  synchronously, at construction** — never returns a rule that might
  misbehave later. `createRegistryPolicyRules()` takes the opposite stance
  for a batch: it silently skips non-ACTIVE rows, since a real
  `listActivePolicies()` result should never contain one in the first
  place, and one bad row shouldn't abort the whole load.
- **`assertVersionSlotFree()` is a real TOCTOU guard, not paranoia.**
  `createPolicy()`/`createNewVersion()` compute a version number from a
  prior `getLatestVersionNumber()` read, then do more work (rule-content
  compilation) before writing — a concurrent writer can occupy that exact
  slot in between. The guard re-checks the slot immediately before
  `insertVersion()` and throws `PolicyVersionConflictError` rather than
  double-inserting or silently overwriting (Rule 11: policy versions are
  insert-once).
- **Reproducibility is by `(policyId, version)`, never `getActivePolicy()`.**
  `getDecisionPolicySnapshot()` looks up the exact row a past decision was
  stamped against — verified by the test that promotes a `p-repro` policy
  from v1 to v2 and confirms the *old* decision still resolves back to
  v1's own `priority`, even after v2 has since gone ACTIVE and disabled v1.

## Correction made to the supplied `test-policy-versioning.ts`

The uploaded "reproducibility" test constructed its `decisionAgainstV1`
request with `resource.organizationId: 999` — a cross-org *mismatch*
against `subject.organizationId: 1`. Under the exact semantics the file's
own two preceding tests pin down (`organizationId: 1` → condition true →
DENY fires and stamps `policyId`/`policyVersion`; `organizationId: 999` →
condition false → the rule abstains and `policyVersion` is left
`undefined`), that value can never produce a decision with a defined
`policyVersion` — it was a copy-paste artifact from the abstain-case test
directly above it in the file. Corrected the local copy to
`organizationId: 1` (matching, so the rule actually fires) — the fix is
noted inline in the test file itself. No production code was changed to
work around this; the fix is confined to the test fixture's own input
data.

## Test status

- `scripts/src/test-policy-explainability.ts` — 26/26 passing.
- `scripts/src/test-policy-versioning.ts` — 16/16 passing.
- Full regression: all 19 pre-existing `scripts/src/test-policy-*.ts`
  suites (Phases 01-14, 1B, 1C) still pass unchanged.
- Scoped `tsc --strict --noEmit` over the entire `lib/policy/**` tree
  (Drizzle-provider files excluded, matching the barrel's own DB-free
  boundary) — zero errors.

## PHASE STATUS

**Phase 15 — Explainability**
- Implemented: yes — `explainAuthorizationDecision()`, `canViewExplanationDetail()`.
- Files changed: `lib/policy/index.ts`.
- Files added: 4 (`lib/policy/explain/*`), 1 test script.
- Database changes: 1 additive migration (102) — seed data only, no schema change.
- Tests: 26/26.
- Security tests: viewer-gating covered (unauthenticated, no-grant, explicit grant, wildcard `admin.*`/`*`, inherited role, revoked grant) + end-to-end proof the real reason code never leaks to a non-admin viewer.
- Known limitations: nothing wires `explainAuthorizationDecision()`/`canViewExplanationDetail()` into an actual Express route yet — this phase ships the engine, not the endpoint (same posture every prior phase shipped with).
- Migration status: written, not yet run against a live DB (run `102_ayzen_policy_explain_permission.sql` in Supabase SQL Editor, after 101).
- Regression status: clean — all Phase 01-14 suites still pass.
- Next phase: 16 (this same delivery).

**Phase 16 — Policy Versioning**
- Implemented: yes — `AuthorizationDecision.policyVersion`, `assertVersionSlotFree()`, `createRegistryPolicyRule()`/`createRegistryPolicyRules()`, `getDecisionPolicySnapshot()`.
- Files changed: `types.ts`, `authorization-decision.ts`, `decision-observer.ts`, `registry/errors.ts`, `registry/policy-registry.ts`, `registry/index.ts`.
- Files added: 2 (`registry/registry-rule-loader.ts`, `registry/reproducibility.ts`), 1 test script.
- Database changes: none.
- Tests: 16/16.
- Security tests: TOCTOU race on both `createPolicy()` and `createNewVersion()` simulated and confirmed rejected without double-inserting; non-ACTIVE record rejected from feeding the PDP at all.
- Known limitations: no real loader wires `createRegistryPolicyRules()`'s output into a running `PolicyEngine` from a live `listActivePolicies()` call yet — same "engine, not endpoint" posture as every prior phase.
- Migration status: n/a (no schema change this phase).
- Regression status: clean.
- Next phase: 17 (Authorization Audit).
