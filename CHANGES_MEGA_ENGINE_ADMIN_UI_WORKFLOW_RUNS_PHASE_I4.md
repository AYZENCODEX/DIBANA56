# AYZEN Mega Engine — Phase I4: Admin UI for Workflow Runs

## Scope
Closes the item Phase I3 named in its own "Still open" list: *"no
frontend page renders `resumeJobs` yet"* — and, more broadly, the
"admin-UI screens generally" line every phase since C has carried
forward untouched. `routes/admin-mega-engine.ts` has had a full
read/write HTTP surface since Part F1 (list/filter runs, inspect one
run's step history, cancel, replay) and Part I3 widened the run-detail
response with `resumeJobs` — but nothing in `artifacts/ayzen` has ever
rendered any of it. Confirmed by grep: no `.tsx` file anywhere in the
frontend referenced `mega-engine`/`megaEngine`/`MegaEngine` before this
phase.

Scoped the same narrow way every phase since I1 has been: this is the
Workflow Runs list + detail screen only — the exact surface I3 flagged.
Health, metrics, dead-letters (events/jobs), and retention already have
working routes on the same router (`getEngineHealth()`/
`getEventBusMetrics()`/`getSchedulerMetrics()`/`listDeadLetters()`/
`RETENTION_WINDOWS_MS`, etc.) but no screen of their own — that stays
carried-forward "admin-UI screens generally" work, not folded into this
phase. A run detail view is useless without a way to find a run id in
the first place, so the list view is the one piece of adjacent surface
this phase does add beyond I3's literal ask — everything else it
exposes (cancel, replay) is likewise limited to endpoints that already
existed before this phase touched anything.

## What was built

**`src/pages/admin/mega-engine.tsx`** — new page, `AdminMegaEnginePage`.
Two views:
- **List**: `GET /api/admin/mega-engine/workflow/runs`, filterable by
  status (a `<Select>` over the same `WorkflowRunStatus` union
  `admin-mega-engine.ts`'s own `WORKFLOW_RUN_STATUSES` validates
  against), `definitionId`, and `correlationId` — the same three query
  params that route already accepts, no new filtering added on the
  client. Each row opens the detail dialog on click.
- **Detail** (`Dialog`, opened per-run): `GET
  /api/admin/mega-engine/workflow/runs/:id`, rendering the run's own
  fields, its full step-run history (`stepRuns`), and — the item this
  phase exists for — its `workflow.resume` wakeup job history
  (`resumeJobs`, newest first, exactly as `getJobsForCorrelation()`
  already returns it). A run that's never been `WAITING` shows an
  explicit "no wakeup job has been scheduled" line rather than an empty
  table with no explanation, matching I3's own "empty is a normal
  outcome, not a fault" posture for that field.
- **Cancel** button, shown only when `run.status` is one of
  `PENDING`/`RUNNING`/`WAITING` — mirrors `run-store.ts`'s `cancelRun()`
  guard exactly (`CANCELLABLE` set in this file, commented with where it
  comes from) rather than showing a button that would silently no-op.
  Calls `POST /workflow/runs/:id/cancel`, then reloads both the list and
  the open detail view so the operator sees the `CANCELLED` status and
  (per I2) the now-cancelled `resumeJobs` row without a manual refresh.
- **Replay** button, shown only when `run.status` is one of
  `FAILED`/`TIMED_OUT`/`CANCELLED`/`DEAD_LETTER` — mirrors
  `replay.ts`'s own `REPLAYABLE_STATUSES` exactly, same reasoning.
  Calls `POST /workflow/runs/:id/replay`, toasts the returned
  `newRunId`, reloads the list, and opens the new run's own detail view
  (the operator's next question after replaying is almost always "how's
  the new one doing", not "let me go find it in the list myself").

No new backend code — every request this page makes is a plain
`customFetch` call to a route `admin-mega-engine.ts` has exposed since
F1/I3; this phase is UI only, same "expose what already exists" posture
that file's own header already establishes for itself.

**`src/lib/route-config.tsx`** — one new lazy import
(`AdminMegaEngine`) and one new route row, `/admin/mega-engine`, with
`allowedRoles: ["dev"]` — matching `requireDev`, the exact gate
`admin-mega-engine.ts` puts on every route this page calls, the same
"frontend role gate mirrors the backend's own middleware" convention
`/admin/ai-agent`/`/admin/mcp-agents` already use for their own
`requireDev`-gated APIs.

**`src/components/layout/app-sidebar.tsx`** — one new `DEV_NAV` group
("Mega Engine", one item: "Workflow Runs" → `/admin/mega-engine`),
placed in `DEV_NAV` specifically (not `ADMIN_NAV`) for the same reason
the route itself is `allowedRoles: ["dev"]` — an `admin`-only operator
with no `dev` role couldn't call any of these endpoints regardless, so
surfacing the link in a nav tree they can see would just be a dead end.

## Still open (carried forward, untouched by I4)
- Health/metrics/dead-letters (events + jobs)/retention still have no
  screen of their own — `getEngineHealth()`, `getEventBusMetrics()`/
  `getSchedulerMetrics()`/`getWorkflowMetrics()`, `listDeadLetters()`/
  `replayDeadLetter()`/`discardDeadLetter()` for both engines, and
  `RETENTION_WINDOWS_MS`/`runRetentionSweep()` are all still
  API-only, same as every phase before this one left them.
- The in-flight action itself remains non-interruptible (I1's own scope
  decision, unchanged) — cancelling a `RUNNING` run from this new UI
  still only stops it at the next step boundary, not mid-step-action,
  exactly as I1 documented; nothing about having a Cancel button now
  changes what `cancelRun()` itself can do.
- The two negligible-window races named in I1 (`executeRun()`'s
  loop-top gap, `resumeRun()`'s top-of-function gap) — still open,
  still judged not worth a dedicated fix.
- Step-level `WorkflowStepDefinition.timeoutMs`, `traceId` propagation,
  §40 Audit Integration, `workflow.timed_out` as a bus event, the
  `tx`-supplied caller edge case (H1) — all still carried forward
  untouched.
- No auto-refresh/polling on either view — an operator watching a
  `RUNNING` run's step history has to close and reopen the dialog (or
  hit the page-level Refresh button) to see new rows; a reasonable small
  follow-up, not part of this phase's own narrow scope.
