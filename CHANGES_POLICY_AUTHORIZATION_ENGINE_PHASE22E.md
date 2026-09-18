# AYZEN Policy & Authorization Mega Engine — Phase 22E (Security / Abuse Testing — Reliability category)

## Scope

Roadmap Phase 22 section implemented for its **Reliability** sub-list only,
verbatim:

> "Reliability:
>  - database failure
>  - policy failure
>  - provider timeout
>  - cache failure
>  - partial context failure
>
>  Authorization failures must fail closed."

Phase 22 has five categories (Authentication, Authorization, Context,
Policy, Reliability). 22A covered Authorization, 22B Authentication, 22C
Context, 22D Policy. This is Reliability — the last category — and with it,
**Phase 22 is complete.**

## Unlike 22A-22D, this phase changed production code

Every prior Phase 22 sub-phase was test-only: existing behavior was already
correct, so the suite only had to demonstrate it. Writing this phase's
fixtures — a `SubjectProvider`/`RiskProvider`/`SessionProvider`/
`DeviceProvider` that can be told to throw on demand, fed through
`authorize()` via `enrichment.pip` (the same Phase 18/19 wiring 22C's own
fixtures already use) — surfaced a real gap:

**`pep/authorize.ts` had no try/catch anywhere around a Phase 18 PIP
provider call.** If `enrichment.pip.resolveSubject()`/`resolveContext()`
threw — a database outage, a network timeout, any other provider-level
failure, exactly what this category is named for — the exception
propagated straight out of `authorize()` as a **rejected promise**, not a
`DENY` decision. A caller of `authorize()`/`requirePolicy()` (once Phase 19
is wired into a real route) would see an unhandled rejection where it
expects a decision object — at best an unhandled-rejection crash, at worst
(depending on how a future route wraps this call) a 500 that some
generic error-middleware might map to something other than a deny, or that
a caller might mishandle as "no decision was reached, treat as pending."
Either reading is a direct violation of the roadmap's own **NON-NEGOTIABLE
Rule 8** ("Authorization failures must fail closed") and this exact phase's
own closing line, quoted above.

This is a genuinely different situation from every other provider-backed
rule in this engine (RBAC, ReBAC, resource-grant, ...), which **already**
fails closed correctly, because `PolicyEngine.evaluateCore()`
(policy-engine.ts) wraps every registered rule call in a try/catch that
converts any throw into a `POLICY_EVALUATION_ERROR` DENY — a mechanism that
has existed since Phase 1A. A PIP provider throws *before* a request (and
therefore before any rule) even exists, entirely outside that mechanism's
reach. Nothing else in this codebase's PIP layer (`pip/policy-information-
point.ts`'s `resolveSubject()`/`resolveContext()`, or the individual
adapters — `risk-level-adapter.ts`'s `withRiskLevel()`, `session-context-
adapter.ts`'s `withSessionAge()`, `device-trust-adapter.ts`'s
`withDeviceTrust()`) had ever caught a provider throw either — this was a
gap in the PIP layer as a whole, not a one-line oversight in `authorize.ts`
alone, though `authorize.ts` is the one and only call site today (Phase 19
is the only thing that ever calls `PolicyInformationPoint`'s methods), so
that is where the fix lives.

Given Rule 8 is NON-NEGOTIABLE, and Rule 15 requires "an audit/review
before continuing" each phase, documenting a fail-OPEN gap the way 22C/22D
documented already-safe absences (e.g. "no organizations table exists")
would not be the same kind of finding — it would mean shipping a Phase 22
test suite whose own header has to admit "this category does not actually
pass Rule 8." The correct call, per the roadmap's own rules, was to fix it
as part of completing this phase, not defer it to a hypothetical Phase 22F.

## The fix

Two files changed, both minimal and additive:

- **`lib/policy/decision-reasons.ts`** — added one new closed-vocabulary
  reason code, `PIP_ENRICHMENT_ERROR`, with its own doc comment
  distinguishing it from `POLICY_EVALUATION_ERROR` (a registered *rule*
  throwing, already handled) and a `DECISION_REASON_DESCRIPTIONS` entry.
- **`lib/policy/pep/authorize.ts`** — wraps the `enrichment.pip.
  resolveSubject()`/`resolveContext()` calls in a try/catch. On a throw,
  `authorize()` now returns a synthesized `PIP_ENRICHMENT_ERROR` DENY
  immediately:
  - `subject: null` on the returned `AuthorizeOutcome` — reflecting the
    true state honestly ("no subject could be safely resolved", not
    "unauthenticated"; those are different facts and now carry different
    reason codes).
  - `request: undefined` — there is no trustworthy `AuthorizationRequest`
    to have built.
  - `requestId` on the decision is stamped from the **pre-PIP**
    `PolicyContext` (already built DB-free by `policyContextFromRequest()`
    before the PIP was ever invoked, so it's still safe to use for
    correlation/audit even though enrichment itself failed).
  - `engine.evaluate()` is **deliberately never called** on this path —
    the one narrow, documented exception to `authorize.ts`'s own
    long-standing "always call the real engine" invariant (see that
    file's header). Every other early-decision path
    (`resolveRequestOrEarlyDecision()`'s invalid-context/unauthenticated
    branches) describes a well-defined, safe-to-evaluate state — `subject:
    null` is a real, meaningful input the engine already knows how to
    fail closed on. A PIP throw describes the *absence* of any such
    well-defined state: there is no safe `Subject`/`PolicyContext` to
    evaluate at all, so falling back to the raw, unenriched `req.user`
    would silently authorize the request against a WEAKER attribute set
    than the caller explicitly asked for by supplying a PIP in the first
    place (e.g. a risk-aware or device-aware rule missing exactly the
    risk/device signal it depends on to deny) — precisely the "never
    trust... without server-side validation" posture Rule 9 exists to
    prevent, read alongside Rule 8's fail-closed mandate.

No other file changed. `pip/policy-information-point.ts` and the
individual adapters (`risk-level-adapter.ts`, `session-context-
adapter.ts`, `device-trust-adapter.ts`) are untouched — the fix sits at the
one call site that exists today (`authorize.ts`), which is sufficient
because nothing else in this codebase calls `PolicyInformationPoint`'s
methods. A second PEP-layer entry point, if one is ever added, would need
the same try/catch — this is called out explicitly in `authorize.ts`'s own
header so it isn't missed.

## Implementation (test file)

Twelve cases across the five named categories:

- **database failure** — an `RbacProvider` (`getUserRoleKeys()`, then
  separately `getRolePermissionKeys()` deeper in `role-resolver.ts`'s BFS)
  throwing a connection-shaped error mid-evaluation resolves to
  `DENY`/`POLICY_EVALUATION_ERROR` — already-correct PDP behavior, pinned
  down with throwing fakes rather than trusted from reading the source. A
  third case exercises the PAP/admin path: `PolicyRegistry.createPolicy()`
  rejects outright (never partially writes) when the provider's first read
  fails, confirmed via `insertVersion`/`recordAudit` call counts of zero.
- **policy failure** — a rule with a plain programmer bug (not a
  provider/DB problem at all) still resolves to `DENY`/
  `POLICY_EVALUATION_ERROR`; a second case confirms a *later* rule's throw
  overrides an *earlier* rule's ALLOW and short-circuits every rule after
  it (a rule registered after the throwing one is confirmed, via call
  count, to never run); a third confirms `evaluateWithTrace()`'s trace
  stops exactly at the throwing rule, never showing a rule that didn't
  actually execute.
- **provider timeout** — a `RbacProvider` call rejecting with a
  timeout-shaped error is caught identically to any other throw (PDP
  layer, already correct); a second case exercises the Phase 22E fix
  itself end to end — a `RiskProvider` timing out inside `enrichment.pip.
  resolveSubject()` now resolves `authorize()` to `DENY`/
  `PIP_ENRICHMENT_ERROR` instead of rejecting the returned promise, with a
  spy engine confirming `evaluate()` is never reached.
- **cache failure** — no cache exists anywhere in `lib/policy/*` (the same
  finding 22D's own header already made, from its poisoning/staleness
  angle; this file reconfirms it from the reliability angle: a "cache
  down" scenario cannot occur independently of "the provider is down,"
  already covered above, because every read already goes straight
  through). Confirmed with a call-counting provider wrapper:
  `PolicyRegistry.getActivePolicy()` reaches the provider on every one of
  three consecutive calls, with zero memoization.
- **partial context failure** — a PIP wired with multiple providers where
  one (subject/risk) succeeds and a later one (session, then separately
  device) throws: the whole `authorize()` call fails closed rather than
  proceeding with a partially-enriched context, `outcome.subject` stays
  `null` even though subject resolution itself had already succeeded (the
  overall failure is reported honestly, not the partial success along the
  way), and the spy engine confirms `evaluate()` is never reached either
  time. A third case confirms the Phase 1B fallback path (no `enrichment.
  pip` at all) has no PIP-layer partial-failure surface to begin with,
  since `subjectFromAuthUser()`/`policyContextFromRequest()` are pure and
  DB-free.

## Tests

```
npx tsx scripts/src/test-policy-security-reliability.ts
```

**Executed live in this environment** (Node v22, via `tsx`/esbuild — no
`node_modules` install required; this file has no non-type-only runtime
dependency outside the repo's own `lib/policy` barrel). All twelve cases
pass, including the two that exercise this phase's own production-code
fix end to end:

```
Policy Engine — Phase 22E (Security / Abuse Testing — Reliability) tests
  ok — database failure: ... (x3)
  ok — policy failure: ... (x3)
  ok — provider timeout: ... (x2)
  ok — cache failure: ...
  ok — partial context failure: ... (x3)

All Phase 22E Reliability abuse-testing checks passed.
Phase 22 (Security / Abuse Testing) — all five categories (Authorization,
Authentication, Context, Policy, Reliability) complete.
```

This is the one Phase 22 sub-phase whose test file's own assertions
depend on a source-code change made in this same phase (the `authorize.ts`
try/catch); confirming it actually passes live — not just by hand-tracing
— matters more here than it did for 22A/22C/22D, and it does.

Also re-run alongside this file, in the same pass: `test-policy-security-
authorization.ts` (22A), `test-policy-security-context.ts` (22C),
`test-policy-security-policy.ts` (22D) — all still pass unchanged, since
none of their own fixtures exercise `authorize.ts`'s PIP-failure path
(22C's fixtures use always-succeeding providers). `test-policy-security-
authentication.ts` (22B) could **not** be run in this sandbox — it
imports `jsonwebtoken` at runtime (not type-only), which is not installed
and cannot be installed here (no network access to the package registry).
This is a sandbox constraint, not a code or test defect — 22B's own file
already documents this same limitation from when it was originally
written. The full remaining `scripts/src/test-policy-*.ts` suite (every
file with no `jsonwebtoken`/`@workspace/db` runtime dependency — over 40
files, covering Phases 1-21) was also re-run in full as a regression
check and passes unchanged; see "Regression status" below.

## Security tests

This entire file *is* the security test suite for its category — twelve
cases, see Implementation above.

## Known limitations

- **22B (Authentication) could not be re-verified live in this sandbox**
  — see "Tests" above. Not a regression from this phase; unrelated to the
  files this phase changed.
- **No provider-level timeout/deadline exists anywhere in this engine.** A
  provider whose promise never settles at all (as opposed to one that
  quickly rejects) will hang the whole authorization decision
  indefinitely, at both the PDP layer (a rule `await`-ing a provider) and
  the PIP layer — this phase's fix catches a *throw*, it does not race a
  slow provider against a clock. Every "provider timeout" case in this
  file models a provider that *rejects* with a timeout-shaped error (what
  a real HTTP/DB client library actually does once its own internal
  deadline fires), which is the realistic shape a caller of this engine
  will observe; this engine has never had a deadline of its own. Adding
  one (an `AbortSignal`/`Promise.race` wrapper around every provider call)
  is real, additive infrastructure work, not a test-phase fix, and is
  deliberately left to a future phase (Rule 16 — do not implement future
  phases prematurely; Rule 17 — avoid unnecessary infrastructure
  introduced reactively rather than by deliberate design).
- **`PolicyEvaluationError`'s own message (`policy-errors.ts`) is a fixed
  template** — `Policy "<id>" threw during evaluation` — not the
  underlying cause's message. The original error's text is preserved on
  `PolicyEvaluationError.cause`, but that wrapper (and its `.cause`) is
  never itself attached to the returned `AuthorizationDecision` — only
  `.message` is read, inside `evaluateCore()`'s catch branch. This is a
  real audit-detail gap (Rule 10 cares about *why* a decision was reached,
  and today's `POLICY_EVALUATION_ERROR` decisions only ever say "a policy
  threw," never what it threw) but is **not** a fail-closed gap — the
  DENY itself, and `policyId` naming which rule failed, are both already
  fully correct. Left as an observed finding, not fixed here: widening
  `AuthorizationDecision`/`deny()` to carry a cause is a larger,
  Phase-17-adjacent (Audit) design question — which fields belong in a
  decision object versus only in whatever log line an `onDecision`
  observer writes — not something to decide unilaterally inside a
  Reliability test phase (Rule 16 again).
- **The "database failure" PAP-layer case only fails
  `getLatestVersionNumber()`**, the first call `createPolicy()`/
  `createNewVersion()` make — not every `PolicyRegistryProvider` method
  individually. This models "the DB was unreachable for this whole
  operation" (the realistic failure mode) and is sufficient to confirm no
  partial write occurs; `PolicyRegistry` has no try/catch anywhere, so ANY
  method throwing simply rejects the whole call, uniformly — this case
  does not claim to have exercised every individual method's own
  (nonexistent) bespoke handling.

## Migration status

None — no schema changes, no new tables, no new routes.

## Regression status

**Verified live.** The entire `scripts/src/test-policy-*.ts` suite that
does not require `jsonwebtoken`/`@workspace/db` (everything runnable in
this sandbox — over 40 files spanning Phases 1 through 22D) was re-run
after applying this phase's two production-code changes, and every file
still passes unchanged. This confirms by execution, not just inspection,
that: `authorize.ts`'s change is additive (a new try/catch branch around
existing calls, one new early-return helper) and does not alter behavior
on the success path at all — every existing caller that never supplies a
throwing PIP provider observes byte-for-byte the same behavior as before
this phase. `decision-reasons.ts`'s change is a pure addition to a closed
union plus one new description-map entry; no existing reason code changed
shape or meaning. The new test file imports only already-existing modules
via the `lib/policy` barrel — no writes to shared fixtures, caches, or
module state that would outlive the process.

## Phase 22 — complete

With this file, all five Phase 22 categories are done:

| Sub-phase | Category | File |
|---|---|---|
| 22A | Authorization | `scripts/src/test-policy-security-authorization.ts` |
| 22B | Authentication | `scripts/src/test-policy-security-authentication.ts` |
| 22C | Context | `scripts/src/test-policy-security-context.ts` |
| 22D | Policy | `scripts/src/test-policy-security-policy.ts` |
| 22E | Reliability | `scripts/src/test-policy-security-reliability.ts` |

Every category's own roadmap-mandated closing line — "Authorization
failures must fail closed" — now holds for every case each of the five
files actually tests, including (per this phase's fix) the one path
(Phase 18 PIP provider failures reached through Phase 19's `authorize()`)
that did not hold before this phase.

## Next phase

Phase 23 — **Admin Policy Console** (Policies / Roles / Permissions /
Resources / Assignments / Simulations / Approvals / Decision Logs / Policy
Versions admin sections, protected with admin authorization, high
assurance for sensitive changes, audit trail, version history, rollback,
pre-activation validation). Per Rule 16, not started here.
