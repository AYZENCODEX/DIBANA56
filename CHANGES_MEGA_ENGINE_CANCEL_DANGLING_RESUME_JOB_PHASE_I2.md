# AYZEN Mega Engine — Phase I2: Cancel Dangling `workflow.resume` Jobs on `cancelRun()`

## Scope
Closes the specific item Phase I1 named in its own "Still open" list:
*"A cancelled-while-WAITING run's already-scheduled `workflow.resume`
job is not proactively cancelled."* I1 was explicit that this was
"already safe... just a wasted job dispatch, not a bug" — this phase is
that follow-up tidiness item, not a correctness fix.

## What was built

**`lib/scheduler/job-store.ts`** — new `cancelJobsForCorrelation(jobType, correlationId)`,
same conditional-`UPDATE`/"only mutate it if it's still safe to" shape
as the existing `cancelJob(id)` right above it, but keyed on
`(job_type, correlation_id)` instead of a single job's own generated
id — for a caller that knows a job by the correlation key its own
scheduling call used rather than by the id `scheduleJob()`/`scheduleDelayed()`
returned (which that caller may never have captured — `parkForWait()`
(`engine.ts`) doesn't keep `scheduleWorkflowResume()`'s returned id
anywhere). Cancels every matching not-yet-terminal (`SCHEDULED`/`RETRYING`)
row rather than assuming there's at most one, though in practice a
workflow run has at most one live `workflow.resume` job at a time
(§24's WAITING/wakeup model). Returns the count cancelled (0 is a valid,
non-error outcome). Exported from `lib/scheduler/index.ts`'s barrel
alongside the existing `cancelJob`.

**`lib/workflow/run-store.ts`** — `cancelRun()` now calls
`cancelJobsForCorrelation(WORKFLOW_RESUME_JOB_TYPE, id)` right after a
successful cancel (`updated.length > 0`), using the same
`correlationId: runId` key `scheduler-integration.ts`'s
`scheduleWorkflowResume()` already sets on every wakeup job it
schedules (see that file's own doc comment — the field exists
specifically so a run's own id is enough to find its wakeup job, no
lookup table needed). Deliberately unconditional rather than gated on
"was this run WAITING before cancel" — a PENDING or actively-RUNNING
run simply has no `workflow.resume` job scheduled yet, so the call is a
harmless no-op for those cases, and checking the run's prior status
first would only cost a second read for no behavioral difference.

No import cycle introduced: `run-store.ts` now imports
`cancelJobsForCorrelation` from `../scheduler` and
`WORKFLOW_RESUME_JOB_TYPE` from its own sibling `./scheduler-integration.ts`
— the latter only ever imports `scheduleJob` from `../scheduler` and
never imports `run-store.ts` (directly or via the workflow barrel), so
the dependency stays one-directional.

## Why this wasn't just "delete the row instead"
`cancelJobsForCorrelation()` reuses the exact `CANCELLED`-status
conditional update `cancelJob()` already uses, not a hard delete — same
reasoning as every other "only mutate it if it's still safe to" guard in
this codebase (`scheduler/job-store.ts`'s own `cancelJob()`,
`run-store.ts`'s `cancelRun()` itself, `lib/mail-send-queue.ts`'s
undo-send): the job row's own terminal-state history (a `CANCELLED`
`workflow.resume` job, visible on whatever admin surface already lists
scheduled jobs) is more useful than silently making it disappear, and
costs nothing extra to keep.

## Still open (carried forward, untouched by I2)
- Everything I1's own "Still open" list carried forward except the one
  item this phase closes: the in-flight action itself is still not
  interruptible (no cooperative cancellation in the action-dispatch
  model — unchanged from H2's identical stance on step-level
  `timeoutMs`), and the two negligible-window races (`executeRun()`'s
  own loop-top gap, `resumeRun()`'s own top-of-function gap) are still
  open, same "worth a named caveat, not worth its own fix" posture.
- No admin-facing surface change: an operator inspecting a cancelled
  run still has to separately check the scheduler's own job list to see
  that its `workflow.resume` job was cancelled too, rather than seeing
  it surfaced on the run's own admin view.
- Step-level `WorkflowStepDefinition.timeoutMs`, `traceId` propagation,
  §40 Audit Integration, admin-UI screens generally, `workflow.timed_out`
  as a bus event, the `tx`-supplied caller edge case (H1) — all still
  carried forward untouched.
