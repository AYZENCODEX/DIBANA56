# AYZEN Mega Engine — Phase I1: Mid-Step Cancellation

## Scope
The specific carried-forward item named (word for word) in
`CHANGES_MEGA_ENGINE_WORKFLOW_PHASE_C_COMPLETE_D1.md`'s "Known gaps"
list: *"mid-step cancellation isn't respected (only checked at step
boundaries)."* Untouched through every phase since (D2, E1–E3, F1, F2,
G1, G2, H1, H2, H3 — confirmed by grep across every
`CHANGES_MEGA_ENGINE_*.md` file). Given its own letter rather than
folded into H: it's a distinct failure mode from H1's/H3's dedupe-guard
gaps and H2's run-level-timeout gap, and the blueprint's own §65 phase
list stops at H — this is the first phase past what the blueprint names,
scoped the same narrow way every phase since C has been.

`run-store.ts`'s `cancelRun()` and its admin route
(`routes/admin-mega-engine.ts`, Part F1) already existed before this
phase — a plain conditional `UPDATE ... WHERE status IN
(PENDING, RUNNING, WAITING)`. What this phase is about is what
`engine.ts`'s execution loop does (or, before this phase, didn't do)
when that UPDATE lands while the loop is in the middle of a step.

## What was NOT attempted, and why
Actually interrupting an in-flight `dispatchAction()` call — so that
cancelling a run stops the *current* step immediately rather than only
before the *next* one — is the same problem H2's own header already
declined for step-level `timeoutMs`: there is no cooperative cancellation
in this action-dispatch model (`actions.ts`'s registry is plain `async`
functions, not anything abort-signal-aware), and racing the call with a
timer/flag still leaves the original action promise running unobserved
in the background with no way to stop it or know what it eventually
does — a correctness/at-least-once question this phase does not answer
by omission any more than H2 did. This phase leaves that exact problem
open, for the same reason, unchanged.

## What was actually broken
Before this phase, `executeRun()`'s loop only re-checked the run's
status at the TOP of each iteration (`if (run.status !== "RUNNING")
return`) — true "step boundary" checking, matching the gap's own
description exactly. Everything the loop does AFTER a step's outcome
comes back and BEFORE the next iteration's check — `advanceOrComplete()`
(`advanceCurrentStep()`, an unguarded write), `parkForWait()`
(`transitionRun(..., "WAITING", ...)`), `failOrCompensate()`
(`transitionRun(..., "FAILED"` or `"COMPENSATING", ...)`) — assumed the
run was still in the exact RUNNING status the loop saw at the top of
that same iteration. If an admin's `cancelRun()` call landed while
`runStepSafely()` was still awaiting `dispatchAction()` for that step
(the realistic window — a step's action can take real wall-clock time; a
DB round trip between two awaits with no I/O in between cannot), two
different things could happen depending on which branch the step's
outcome took:

- **Silent clobber** (outcome `"ok"`, more steps remaining):
  `advanceOrComplete()`'s `advanceCurrentStep()` is a raw, unguarded
  UPDATE with no status check of its own (by design — see that
  function's own doc comment) — it would happily keep moving
  `current_step_id` forward on a row that was already CANCELLED,
  leaving a cancelled run's `current_step_id` pointing somewhere past
  where it was actually cancelled.
- **Uncaught crash** (outcome `"waiting"`, or `"failed"` with retries
  exhausted): `parkForWait()`/`failOrCompensate()`'s `transitionRun()`
  call re-fetches the row's current status internally
  (`run-store.ts`'s own `transitionRun()`) and runs it through
  `state-machine.ts`'s `assertRunTransition()` — which correctly sees
  CANCELLED (a terminal status with **no** legal outgoing transitions)
  and throws `IllegalTransitionError`. Before this phase, that exception
  propagated **uncaught** out of `executeRun()`/`resumeRun()` — a crash
  for whatever called them: an HTTP request handler awaiting
  `executeRun()` directly, or `worker.ts`'s dispatch of a
  `workflow.resume` scheduler job, which would then record the crash as
  a job failure and retry/eventually dead-letter a run that was actually
  cancelled on purpose, not one that failed.

## What was built
**`lib/workflow/engine.ts`** — one added check in `executeRun()`'s main
loop, immediately after `runStepSafely()` returns and before any of the
three outcome branches (`waiting`/`ok`/`failed`) run their
`transitionRun()`/`advanceOrComplete()` side effects: a fresh `getRun(runId)`,
and if the live row is no longer `RUNNING`, the loop logs it at `info`
(naming the run, the step, the outcome that's being discarded, and the
run's actual current status) and returns immediately — without calling
`advanceOrComplete()`, `parkForWait()`, or `failOrCompensate()` at all.
One choke point closes both failure modes above at once, rather than
patching `advanceOrComplete()`/`parkForWait()`/`failOrCompensate()`
separately. The step's own row is unaffected either way — `runStep()`
already durably recorded its `COMPLETED`/`FAILED` outcome on the
`workflow_step_run` row before this check ever runs (§18 durability; a
step doesn't get retroactively un-run) — this only stops the RUN's own
bookkeeping from advancing past the point it was cancelled at.

## Still open (carried forward, untouched by I1)
- **The actual in-flight action itself is still not interruptible** —
  see "What was NOT attempted" above; unchanged from H2's identical
  stance on step-level `timeoutMs`.
- **Two much smaller, same-shape races, left open as negligible**: (1)
  `executeRun()`'s own loop-top window between reading `run` and its
  `checkRunTimeout()`/`transitionRun(..., "COMPLETED", ...)` calls a few
  lines later, and (2) `resumeRun()`'s window between its initial
  `getRun()` and its own `checkRunTimeout()`/`transitionRun(..., "RUNNING", ...)`
  calls. Both involve at most one intervening awaited call with no real
  I/O of its own in the non-timeout path, versus this phase's actual
  target (an in-flight `dispatchAction()` call, which can take
  arbitrary wall-clock time) — same "worth a named caveat, not worth
  this phase's own fix" posture H1's own "Still open" list used for its
  `tx`-supplied-caller edge case.
- **A cancelled-while-`WAITING` run's already-scheduled `workflow.resume`
  job is not proactively cancelled.** It was already safe before this
  phase (`resumeRun()`'s own `if (run.status !== "WAITING") return`
  guard no-ops it harmlessly when it eventually fires) and stays that
  way — just a wasted job dispatch, not a bug. Actively calling
  `scheduler`'s `cancelJob()` from `cancelRun()` when a `WAITING` run is
  cancelled would be a reasonable, small follow-up but is a distinct
  piece of tidiness, not part of this phase's own scope.
- Step-level `WorkflowStepDefinition.timeoutMs`, `traceId` propagation,
  §40 Audit Integration, admin-UI screens generally, `workflow.timed_out`
  as a bus event, the `tx`-supplied caller edge case (H1) — all still
  carried forward untouched.
