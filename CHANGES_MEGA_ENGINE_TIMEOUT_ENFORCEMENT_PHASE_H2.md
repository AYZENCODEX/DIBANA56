# AYZEN Mega Engine — Phase H2: Run-Level maxRuntimeMs Enforcement (§65 "H: Production hardening")

## Scope
Same starting point as H1's own header: §65 gives Phase H a one-line
label with no bullet list to check completeness against, so this
phase's scope is drawn from a specific, named, carried-forward "Still
open" item rather than guessed at wholesale. `CHANGES_MEGA_ENGINE_WORKFLOW_PHASE_D2.md`
is where this one first appears, word for word: *"Step-level `timeoutMs`
/ run-level `maxRuntimeMs` enforcement (noted as missing since Part C,
still missing)."* Untouched through every phase since (D2, E1–E3, F1,
F2, G1, G2, H1) — none of their own "Still open" sections mention
touching it, confirmed by grep across every `CHANGES_MEGA_ENGINE_*.md`
file in this session. A workflow engine that accepts a `maxRuntimeMs`
budget at definition time (§16), persists it onto every run
(`workflow_run.max_runtime_ms`, migration 113), and then never once
reads that column back is exactly the kind of gap "production hardening"
names: a stuck or slow-looping run has no way to ever be cut off, which
is a correctness-in-the-lab / risk-in-production split of the same shape
H1's own item was.

This phase deliberately does ONLY the run-level half. Step-level
`WorkflowStepDefinition.timeoutMs` (§16, still read nowhere in this
codebase — confirmed by grep) is a materially harder problem: enforcing
it means racing a single step's `dispatchAction()` call against a timer
(there is no cooperative cancellation in this action-dispatch model —
`actions.ts`'s registry is plain `async` functions, not anything
abort-signal-aware), and a timed-out race still leaves the original
action promise running in the background with no way to actually stop
it or know what it eventually does — a correctness/at-least-once
question this phase does not want to answer by omission inside what's
meant to be a narrowly-scoped slice. Left open below, same "a future
phase's call to make deliberately" posture G2 used for `workflow.timed_out`
as a bus event.

## What was built

**`lib/workflow/engine.ts`** — new `checkRunTimeout(run)` helper:
no-ops (`false`) when `run.maxRuntimeMs` or `run.startedAt` is unset
(most runs — both are optional); otherwise compares wall-clock elapsed
since `startedAt` against the budget and, if exceeded, transitions the
run straight to the state machine's existing `TIMED_OUT` terminal status
(already legal from both `RUNNING` and `WAITING` in
`state-machine.ts`'s `RUN_TRANSITIONS` — no state-machine change needed)
with a `lastError` naming the budget, elapsed time, and current step,
and returns `true`.

Wired at two call sites:
- **`executeRun()`'s main loop** — checked once per iteration,
  immediately after re-reading the run's current state and before
  looking at `currentStepId` — so a run that's been continuously
  `RUNNING` through many steps (never once parked in `WAITING`) is still
  caught between steps, not only one that happens to pass through a
  scheduler wakeup.
- **`resumeRun()`** — checked BEFORE the existing `WAITING -> RUNNING`
  transition, so a run whose scheduled wakeup lands after its own
  budget already elapsed (a long backoff/delay, or a scheduler that
  fell behind) times out directly from `WAITING` — itself a legal
  transition — rather than briefly touching `RUNNING` only to be cut off
  a moment later by the loop's own check.

No change to `state-machine.ts`, `types.ts`, or any migration —
`TIMED_OUT` was already a full member of `WorkflowRunStatus` and the
state machine's terminal-status list (`RUN_TRANSITIONS.TIMED_OUT = []`)
since Part C1; this phase is purely the missing call site that actually
reaches it via this path, not new state-machine surface.

Deliberately does NOT publish a `workflow.failed`/`.completed` bus event
for a `TIMED_OUT` transition — G2's own CHANGES doc already made this
exact call explicitly ("TIMED_OUT specifically is NOT in this phase's
three... not a missing case"), and this phase treats that as a decision
already made, not something to reopen by extension. `transitionRun()`'s
G1-added `workflow_duration` recording (fires for ANY terminal status,
not just COMPLETED) and `recordRunTransition()`'s existing `TIMED_OUT`
counter case (Part E1, `metrics.ts`) both already cover a
`TIMED_OUT` run for free — no metrics change needed either.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `"TIMED_OUT"` — a real member of the `WorkflowRunStatus` union
  (`types.ts`) and a real key of `RUN_TRANSITIONS`
  (`state-machine.ts`), with `RUNNING -> TIMED_OUT` and
  `WAITING -> TIMED_OUT` both present in its transition lists — so
  `assertRunTransition()` (called internally by `transitionRun()`)
  accepts both call sites this phase added without throwing.
- `transitionRun()`'s `patch` parameter type
  (`Partial<Pick<WorkflowRun, "lastError" | "startedAt" | "completedAt">>
  & {...}`) already accepts both `lastError` and `completedAt` — neither
  is a new field invented for this phase.
- `run.maxRuntimeMs`/`run.startedAt` — both real, already-populated
  optional fields of `WorkflowRun` (`run-store.ts`'s `rowToRun()`:
  `maxRuntimeMs: row.maxRuntimeMs ?? undefined`,
  `startedAt: row.startedAt ?? undefined`), not new reads added without
  a matching source; `startedAt` is set by the existing
  `PENDING -> RUNNING` transition in `executeRun()`, untouched by this
  phase.
- `recordRunTransition()` (`metrics.ts`) already has a `case
  "TIMED_OUT":` branch (confirmed by grep, pre-dates this phase, Part
  E1) — no metrics-side change needed for this phase's new call sites
  to be counted correctly.
- Brace/paren balance of the edited file confirmed programmatically
  (a crude but real check, given no `tsc` in this session) — 0/0 either
  way after the edit.
- No new imports needed: `checkRunTimeout()` only calls `transitionRun()`,
  already imported at the top of `engine.ts` before this phase.
- `isTerminalRunStatus(to) && current.startedAt` (the G1 duration-
  recording guard inside `transitionRun()`) evaluates true for a
  `TIMED_OUT` transition specifically because `RUN_TRANSITIONS.TIMED_OUT`
  is an empty array — same mechanism, unmodified, that already made
  every other terminal status's duration recording work.

## Still open (carried forward, untouched by H2)
- **Step-level `WorkflowStepDefinition.timeoutMs`** — deliberately out
  of scope for the reasons given in "Scope" above (no cooperative
  cancellation in the current action-dispatch model; a `Promise.race`
  timeout would leave the original action running unobserved in the
  background, which is a correctness question this phase does not
  answer by omission). A future phase's call to make deliberately, with
  an explicit decision about what "timed out but still running in the
  background" means for that step's eventual output/idempotency key.
- **Mid-step cancellation** — noted as missing since Part C, still
  missing; a related-but-distinct problem from timeout enforcement (a
  human/admin cancelling a specific in-flight step vs. a budget
  expiring), not attempted here.
- `schedule-triggers.ts`'s `scheduledForEvent` durable backstop (H1's
  own "Still open"), the `tx`-supplied-caller edge case (H1's own "Still
  open"), `traceId` propagation, §40 Audit Integration, admin-UI screens
  generally — all still carried forward, untouched by this phase either.
- No admin-facing surface change: an operator still can't see "this run
  timed out because of `maxRuntimeMs`" anywhere except that run's own
  `last_error` column, reachable only through whatever admin route
  already lists/inspects runs (F1's own listRuns()/getRun() surface) —
  no new route was added specifically to highlight `TIMED_OUT` runs,
  same "admin-UI screens generally" gap every phase since E2 has left
  open for its own new surface.
