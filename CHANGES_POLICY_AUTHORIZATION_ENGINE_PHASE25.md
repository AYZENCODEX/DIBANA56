# AYZEN Policy & Authorization Mega Engine — Phase 25 (Production Hardening)

## Scope

The roadmap's own Phase 25 line item, "timeout limits" — the only item in
that section this pass implements (Rule 16: do not implement future phases
prematurely; other Phase 25 items, if any, are left for their own pass).

Until this phase, nothing in `lib/policy/*` bounded how long it would wait
on a single unit of work:

- `PolicyEngine.evaluateCore()` (`policy-engine.ts`) `await`s each
  registered `PolicyRule` with no timeout.
- `authorize()` (`pep/authorize.ts`) `await`s a Phase 18
  `PolicyInformationPoint`'s `resolveSubject()`/`resolveContext()` the same
  way.

Every rule/provider this engine ships today is fast (in-memory, or a
single indexed DB query), so this was never observed in practice — but a
slow or hung DB connection, or a future rule/provider that calls out to a
slow external service, would block the whole authorization pipeline
indefinitely. An authorization decision that never resolves is not merely
slow, it is a denial-of-service surface (one hung dependency can hang
every request waiting on it), and it is a direct violation of the
roadmap's own NON-NEGOTIABLE Rule 8 ("Authorization failures must fail
closed") — a decision that never resolves is not "closed," it is stuck.

## The fix

Three files changed, all additive:

- **`lib/policy/hardening/timeout.ts`** (new) — `withTimeout(operation,
  timeoutMs, stage)`, the one shared primitive both call sites now use.
  Races `operation` against a `timeoutMs`-millisecond timer; on timeout,
  rejects with a new `AuthorizationTimeoutError(stage, timeoutMs)`.
  `timeoutMs` of `undefined`/`0`/negative disables the timeout entirely —
  `operation` is awaited exactly as unbounded as every pre-Phase-25 call
  site already did. The internal timer is `unref()`'d so an authorization
  call awaiting a timeout can never keep the Node process alive on its
  own. Honest about its own limits: JavaScript has no general way to
  cancel an arbitrary in-flight promise, so past the deadline this stops
  *waiting* on the original operation and lets the caller proceed as if it
  had failed — the operation may still be running in the background. That
  is still the correct fix for the DoS/fail-closed concern above: the
  *pipeline's own wait* is what must never hang, not the underlying
  dependency call.
- **`lib/policy/policy-engine.ts`** — new `PolicyEngineOptions.
  ruleTimeoutMs` (constructor option). `evaluateCore()`'s rule loop now
  calls `withTimeout(() => Promise.resolve(rule(request)), this.
  ruleTimeoutMs, \`rule "${id}"\`)` instead of `await rule(request)`
  directly. A timed-out rule rejects with `AuthorizationTimeoutError`,
  which lands in the loop's pre-existing `catch (cause)` — the exact same
  branch a plain throwing rule has always taken, producing the exact same
  `POLICY_EVALUATION_ERROR` DENY. **No new reason code was needed.**
- **`lib/policy/pep/authorize.ts`** — new `PepEnrichmentOptions.
  pipTimeoutMs` (`pep/types.ts`). Both `pip.resolveSubject()` and
  `pip.resolveContext()` are now wrapped in `withTimeout(..., pipTimeoutMs,
  ...)`. A timed-out provider call rejects with `AuthorizationTimeoutError`,
  which lands in `authorize()`'s existing Phase 22E PIP try/catch — the
  exact same `pipFailureOutcome()` / `PIP_ENRICHMENT_ERROR` DENY a plain
  provider throw already produces. **No new reason code was needed here
  either.**

Both wirings deliberately reuse an already-correct fail-closed path
instead of inventing a new one — Phase 22E already proved (and this
phase's own test suite reconfirms) that both `POLICY_EVALUATION_ERROR` and
`PIP_ENRICHMENT_ERROR` are safe, audited DENY outcomes; a timeout is just
one more way to arrive at "this rule/provider did not produce a
trustworthy result," not a new category of outcome.

`lib/policy/index.ts` re-exports `./hardening/timeout` in a new Phase 25
section at the end of the barrel.

## Opt-in, zero-behavior-change-by-default

Both new options (`ruleTimeoutMs`, `pipTimeoutMs`) default to `undefined`.
No existing `new PolicyEngine(...)` or `authorize({ enrichment: {...} })`
call site anywhere in this codebase passes either one, so every one of
them keeps byte-for-byte the same unbounded-wait behavior it already had
(Rule 5: prefer additive; Rule 6: preserve API compatibility). This phase
does not wire a timeout into any concrete engine construction — same
"engine, not endpoint" posture every phase before it has shipped with.

## Scope note: `PrecedenceEngine` was not touched

`precedence-engine.ts`'s `PrecedenceEngine.evaluateCore()` has the
identical `await rule(request)` pattern inside its own tier loop, and
would hang on the same class of slow/hung rule `PolicyEngine` did before
this phase. The roadmap's own Phase 25 framing (and this phase's `timeout.
ts` header) names exactly two call sites — `policy-engine.ts`'s rule loop
and `pep/authorize.ts`'s PIP resolution — so `PrecedenceEngine` is left
unchanged here rather than assumed into scope. If a `ruleTimeoutMs`-style
option is wanted there too, it would follow the identical pattern: a new
`PrecedenceEngineOptions.ruleTimeoutMs`, `withTimeout()` around the same
`await rule(request)` call, landing in the loop's own existing
`POLICY_EVALUATION_ERROR` catch branch. Flagged here rather than silently
left as a gap.

## Tests

```
npx tsx scripts/src/test-policy-hardening-timeout.ts
```

**Executed live in this environment** (Node v22, via `tsx` — no
`node_modules` install required; this file has no non-type-only runtime
dependency outside the repo's own `lib/policy` barrel). Twelve cases, all
passing:

```
Policy Engine — Phase 25 (Production Hardening: timeout limits) tests
  ok — withTimeout(): timeoutMs undefined disables the timeout — a slow-but-finite operation still resolves, unbounded
  ok — withTimeout(): timeoutMs of 0 and negative both disable the timeout, same as undefined
  ok — withTimeout(): operation finishing within budget resolves normally
  ok — withTimeout(): a genuinely hanging operation rejects with AuthorizationTimeoutError naming the stage and budget
  ok — withTimeout(): a synchronously-throwing operation is still caught and surfaces as a rejection, not an unhandled throw
  ok — withTimeout(): an operation that rejects on its own (no timeout involved) still rejects with its own error, unchanged
  ok — ruleTimeoutMs: a hanging rule times out and resolves to DENY/POLICY_EVALUATION_ERROR — the pre-existing fail-closed path, not a new one
  ok — ruleTimeoutMs: a rule that finishes within budget is unaffected — resolves ALLOW as normal
  ok — ruleTimeoutMs omitted: preserves the pre-Phase-25 unbounded wait — a slow-but-finite rule still resolves
  ok — pipTimeoutMs: a hanging SubjectProvider inside resolveSubject() times out and resolves authorize() to DENY/PIP_ENRICHMENT_ERROR, not a pending promise forever
  ok — pipTimeoutMs: a hanging SessionProvider inside resolveContext() times out and resolves authorize() to DENY/PIP_ENRICHMENT_ERROR
  ok — pipTimeoutMs omitted: preserves the unbounded wait — a slow-but-finite PIP provider still resolves to ALLOW

All Phase 25 (Production Hardening: timeout limits) checks passed.
```

Note on the `SessionProvider` case: `withSessionAge()`
(`session-context-adapter.ts`) no-ops without a `sessionId` already on the
`PolicyContext` — the first draft of that test used a fake request with no
`sessionId`, which meant the fake provider was never actually reached and
the case passed for the wrong reason (nothing to time out). Fixed by
passing `enrichment.sessionId: () => "session-abc"` and asserting
`sessionProvider.calls === 1`, so the test really does exercise a hung
provider being reached and then timed out, not skipped.

Also re-run alongside this file, unchanged: `test-policy-engine.ts`
(Phase 1A — 12/12 pass), `test-policy-pep.ts` (Phase 19 — 20/20 pass),
`test-policy-security-reliability.ts` (Phase 22E — 12/12 pass, including
its own two "provider timeout" cases, which model a provider that has
already *finished* rejecting with a timeout-shaped error — this phase's
suite is the first to model a provider whose promise never settles at
all). No regression in any of the three.
