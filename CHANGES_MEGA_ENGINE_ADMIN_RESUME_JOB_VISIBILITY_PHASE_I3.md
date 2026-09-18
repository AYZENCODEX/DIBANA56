# AYZEN Mega Engine — Phase I3: Surface a Run's `workflow.resume` Job(s) on Admin Inspection

## Scope
Closes the item Phase I2 named in its own "Still open" list: *"No
admin-facing surface change: an operator inspecting a cancelled run
still has to separately check the scheduler's own job list to see that
its `workflow.resume` job was cancelled too."*

## What was built

**`lib/scheduler/job-store.ts`** — new `getJobsForCorrelation(jobType, correlationId)`,
the read-side twin of I2's `cancelJobsForCorrelation()`: same
`(job_type, correlation_id)` key, but returns the actual row(s)
(mapped through the existing `rowToJob()`), newest `createdAt` first,
instead of a count. Plural and ordered rather than "just the current
one" on purpose — a WAITING run's wakeup job can be re-scheduled more
than once over a run's lifetime (each step-retry backoff re-parks under
the same `runId` correlation id), so a caller inspecting run history
benefits from seeing all of them, not just whichever is currently
non-terminal. Exported from `lib/scheduler/index.ts`'s barrel alongside
`getJob`/`cancelJob`/`cancelJobsForCorrelation`.

**`routes/admin-mega-engine.ts`** — `GET /admin/mega-engine/workflow/runs/:id`
now also calls `getJobsForCorrelation(WORKFLOW_RESUME_JOB_TYPE, req.params.id)`
and returns it as `resumeJobs` alongside the existing `run`/`stepRuns`
fields. `WORKFLOW_RESUME_JOB_TYPE` was already exported from the
workflow barrel (`lib/workflow/index.ts`, re-exported from
`scheduler-integration.ts`) — no new cross-module export needed there.
`resumeJobs` is `[]` for a run that's never been `WAITING` (nothing
scheduled yet), not an error case — same "empty is a normal outcome,
not a fault" posture every list-shaped field on this route already
uses (`stepRuns` itself is `[]` for a run with no step history yet).

No new route was added — this widens an existing response shape rather
than introducing a new endpoint, matching the narrowest possible surface
for what was actually asked (an operator inspecting a run wants this
information right where they're already looking, not through a second
request cross-referencing the run id against the separate scheduler
job-list endpoint by hand).

## Still open (carried forward, untouched by I3)
- The in-flight action itself remains non-interruptible (I1's own
  scope decision, unchanged).
- The two negligible-window races named in I1 (`executeRun()`'s
  loop-top gap, `resumeRun()`'s top-of-function gap) — still open,
  still judged not worth a dedicated fix.
- Step-level `WorkflowStepDefinition.timeoutMs`, `traceId` propagation,
  §40 Audit Integration, admin-UI screens generally (this phase widened
  an existing JSON response; no frontend page renders `resumeJobs` yet),
  `workflow.timed_out` as a bus event, the `tx`-supplied caller edge
  case (H1) — all still carried forward untouched.
