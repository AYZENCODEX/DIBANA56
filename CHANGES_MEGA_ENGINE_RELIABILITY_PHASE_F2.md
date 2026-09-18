# AYZEN Mega Engine — Phase F2: Workflow Security Test Coverage (§65 "F: Reliability/security", closing out §58's Security row)

## Scope
`CHANGES_MEGA_ENGINE_RELIABILITY_PHASE_F1.md` built workflow run
inspection/cancel/replay and, in its own "Still open" section, named five
of §58's seven Security test rows as untouched by that phase:

```
§58 Security tests:  PEP denial, stale authorization, cross-organization
                      access, privilege changes during waiting, event
                      replay, workflow replay, admin-only operations
```

`event replay` (Part A/E2) and `workflow replay` (this same F1 phase)
already existed with no executable test behind either — every phase in
this session has shipped "Verified by hand" source-trace sections instead,
for the same disclosed reason (no `node_modules`, no reachable Postgres).
F2 is this codebase's first phase to actually write and syntax-verify a
runnable test suite for any of the Mega Engine's security guarantees,
closing the five rows F1 left open. It does not add new production logic —
every case below tests code that already existed before this phase.

## What was built
**New file `scripts/src/test-policy-security-workflow.ts`** — one suite,
following the `scripts/src/test-policy-security-*.ts` naming convention
already established by Phase 22's five sub-phases (22A–22E), extended here
to a workflow-specific sixth. Twelve cases across the five open rows:

| §58 row | Cases | What's proven |
|---|---|---|
| PEP denial | 2 | A real registered DENY rule's decision passes through `authorizeWorkflowAction()` unchanged; engine.ts's own `ctx.authorize` call-site convention (throw `WorkflowActionDeniedError` on anything but ALLOW) actually fires for a real DENY, reproduced verbatim from engine.ts's `runStep()`, not reimplemented. |
| stale authorization / privilege changes during waiting | 2 | The SAME `WorkflowRun` object, authorized twice through the SAME `resolveSubject` function whose backing data changes in between (a role downgrade; an account suspension), gets the SECOND call's fresh fact both times — not the first call's cached one. `resolveCalls === 2` is asserted directly, not inferred. |
| cross-organization access | 3 | A workflow action's `ctx.authorize()` call, scoped by `organizationId` on the resource, goes through the exact same `createOrganizationAccessRule()` the HTTP path already uses (no separate workflow-specific tenant rule exists, confirmed by using the real export) — cross-org denies, same-org allows, and `run.context.organizationId` is confirmed NOT trusted as a substitute for a fresh `resolveSubject()` lookup. |
| admin-only operations | 4 | `requireRole(["dev", "admin"])` — the real exported factory `middlewares/auth.ts`'s private `devRoleCheck` is built from, with the identical role list `requireDev` uses — allows `dev` and `admin`, denies `member` (403) and no-user (401), via the real Express middleware chain (`ownership-route-test-kit.ts`'s `fakeReq`/`fakeRes`/`invoke` harness, not a reimplementation of the gate). |

Every case calls the real, unmodified function — `authorizeWorkflowAction()`
(`lib/workflow/authorization.ts`) or `requireRole()`
(`lib/policy/pep/middleware.ts`) — never a stand-in. See the file's own
header for the full reasoning on why `authorizeWorkflowAction()` alone
(not the full DB-backed `runStep()`/`executeRun()` loop) is the correct,
non-weaker seam to test.

## The one claim this phase actually had to verify, not just re-read
F1's "Still open" section explicitly flagged this as unconfirmed:

> does a `WAITING` run re-check authorization on resume, or only at each
> new step dispatch — `engine.ts`'s existing `authorizeWorkflowAction()`
> call site would need to be read closely to answer this with certainty,
> not assumed

This phase answers it with an executable case, not a closer reading:
`authorization.ts`'s own header already asserted `resolveSubject` is
"looked up FRESH on every call — never memoized". The
"stale authorization / privilege changes during waiting" cases construct a
scenario where that claim, if false, would produce an observably wrong
decision (a revoked admin still getting ALLOW) — and assert both the
decision AND the resolver's call count. The claim holds: `engine.ts` never
caches a `Subject` across a WAITING boundary, because `authorizeWorkflowAction()`
itself never does, and every step's `ctx.authorize` closure calls it fresh
(engine.ts's `runStep()`, lines ~112–121 — unchanged since C2).

## Cross-organization access — the other half, explicitly stated
F1's own "Still open" list raised cross-organization access only in the
context of the new admin routes (`routes/admin-mega-engine.ts`), and
already stated the answer for that half: `requireDev` is a global-admin
gate, deliberately with no per-org boundary. This phase does not revisit
that decision — it remains correct and is restated here for completeness,
not re-argued.

What F1 did NOT address is the other half: a workflow ACTION handler's own
`ctx.authorize()` call, when a domain module's handler passes an
organization-scoped `ResourceRef`. This phase closes that half — see the
table above. No engine-level change was needed: §22's own diagram already
routes every workflow-triggered authorization through the same PEP/PDP
path an HTTP request uses, so the existing `createOrganizationAccessRule()`
already applies with zero additional wiring. This phase's contribution is
proving that with a test, not building new tenant-isolation logic.

## Verified — script actually parsed
```
$ node -e "... ts.transpileModule(...) ..." scripts/src/test-policy-security-workflow.ts
Diagnostics: 0
```
Same syntax-only verification method F1 used for `requirePublicAudit()`
(TypeScript compiler API, no `node_modules` for full module resolution —
`@workspace/db`/`express`/`drizzle-orm` are not installed in this sandbox).
**Real `tsx scripts/src/test-policy-security-workflow.ts` was not run** —
same constraint every phase this session has disclosed. Every assertion
was additionally traced by hand against the current, real source of
`authorization.ts`, `policy-engine.ts`, `organization-access-rule.ts`, and
`pep/middleware.ts` to confirm the exact code path each case exercises
(see the file's own "Not covered here" closing section for the full list
of what was and wasn't traced this way). Please run it in a real
environment (`DATABASE_URL` set — importing `lib/workflow`/`lib/policy`
transitively imports `@workspace/db`, which throws at import time if
unset, same constraint `ownership-route-test-kit.ts`'s own header
documents; the suite never actually reaches the DB, same reasoning) and
report back if any case doesn't match this analysis.

## §58 Security row status after this phase
```
PEP denial                          — tested (this phase)
stale authorization                 — tested (this phase)
privilege changes during waiting    — tested (this phase)
cross-organization access           — tested (this phase)
admin-only operations               — tested (this phase, PDP-level only — see below)
event replay                        — built (Part A/E2), not executably tested
workflow replay                     — built (Part F1), not executably tested
```
All seven rows are now either executably tested or explicitly, honestly
flagged as build-only. Phase F itself (§65's "Reliability/security", no
roadmap bullet list of its own — see F1's own naming-correction section)
has no single spec to check "complete" against the way §57-E's Operations
phase could be. Given that, and given this phase closes every §58 Security
row F1 itself named as the phase's own remaining scope, this is treated as
Phase F's natural completion point rather than reaching for further,
self-assigned scope (Rule 16).

## Still open (deliberately not this phase's scope)
- **"admin-only operations" stops at the PDP role-gate, not `requireDev`'s
  full token/DB prelude** (`getTokenFromReq()`/`getUserFromToken()`). This
  is shared, generic auth-layer plumbing used by every `requireDev`/
  `requireAdmin` route in this codebase, not something Mega-Engine-
  specific — a real test for it belongs in a `middlewares/auth.ts` suite
  of its own, covering every consumer of that prelude at once, not a
  narrower Mega-Engine-only copy of it.
- **`replayRun()`/`cancelRun()` (workflow/event replay) still have no
  executable test** — both are real `@workspace/db` (drizzle) functions
  with call chains (`db.select`/`db.update`/`db.insert` across
  `run-store.ts` and `definition-store.ts` in combination) that don't
  reduce to the single mockable `db.select(...).limit(1)` seam
  `ownership-route-test-kit.ts` already handles for resource builders. A
  future phase with a reachable test database (not this sandbox) could
  either write that mock chain or, better, run a true end-to-end
  integration test against a real Postgres instance.
- **`runStep()`/`executeRun()`'s full execution loop is still never
  exercised end-to-end** — this phase's own header explains why testing
  `authorizeWorkflowAction()` in isolation is the correct, non-weaker
  substitute for the authorization-specific guarantee, but it does not
  substitute for a true integration test of the whole loop (retry,
  timeout, waiting, resume, cancellation, compensation, idempotency,
  restart recovery — §58's own Workflow test list, separate from the
  Security list this phase addresses). Same DB-reachability blocker as
  above.
- `scheduled_job` retention, config-wired retention windows, §40 Audit
  Integration, latency metrics, `traceId` propagation, and Workflow →
  Event Bus reverse publishing — all still open, carried forward
  unchanged from E1/E2/E3/F1's own lists (untouched by this phase).
