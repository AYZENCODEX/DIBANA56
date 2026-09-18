# AYZEN Mega Engine — Phase E2: Admin Inspection (§57-E health/metrics/replay/dead-letter tools, HTTP surface)

## Scope
`AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md` §57's Part E list
is: `health`, `metrics`, `admin inspection`, `replay`, `dead-letter
tools`, `cleanup`, `retention`. Phase E1
(`CHANGES_MEGA_ENGINE_OBSERVABILITY_PHASE_E1.md`) built the first two —
`getEngineHealth()` (§61) and the three engines' `get*Metrics()`
functions — but flagged its own gap in "Still open": *"The admin/health
route itself — `getEngineHealth()` has no HTTP handler wired to it
yet."* E2 is that handler, plus the next two items on §57-E's list:
`admin inspection` and `replay`/`dead-letter tools`.

The `replay`/`dead-letter tools` *logic* isn't new — `event-bus/
dead-letter.ts` (Part A) and `scheduler/dead-letter.ts` (Part B1) have
had `listDeadLetters()`/`replayDeadLetter()`/`discardDeadLetter()` since
their own phases, exported from each engine's barrel. What was missing
was any way to actually reach them — no route, no admin console page,
nothing outside a direct function call from other backend code. E2 adds
that surface; it adds no new dead-letter behavior underneath it.

Workflow has no dead-letter table of its own (a run that can't proceed
lands in its own `DEAD_LETTER` *run status* instead — see
`workflow/types.ts`'s `WorkflowRunStatus`), so there's nothing to
list/replay/discard on that side beyond what a future runs-inspection
endpoint would already show; this phase's dead-letter routes only cover
Event Bus and Scheduler.

## What was built

**New file `lib/mega-engine` consumer: `routes/admin-mega-engine.ts`** —
mounted through `routes/index.ts` at `/api/admin/mega-engine/*`, same
`requireDev`-gated tier every other admin console router in this
codebase already uses (`admin-oidc-rollout.ts`, `admin-policy-console.ts`,
etc.) — mounted right next to them.

- `GET /admin/mega-engine/health` — §61's `getEngineHealth()`, returned
  as-is (its own `state`/`eventBus`/`scheduler`/`workflow`/`checkedAt`
  shape needs no reshaping for an admin caller).
- `GET /admin/mega-engine/metrics` — all three engines'
  `get*Metrics()` snapshots in one response (`{ eventBus, scheduler,
  workflow }`), so an operator doesn't need three round-trips for the
  numbers `checkDispatcher()`/`checkWorkers()`/`checkRunner()` are
  already reading internally for the health check above.
- `GET /admin/mega-engine/dead-letters/:engine` — `:engine` is
  `"events"` or `"jobs"`, picking which pair of store-layer functions
  (event-bus's vs scheduler's) a request goes through — they're the same
  shape of operation (list/replay/discard by numeric id) but live in two
  different tables, so one param avoids tripling every route rather than
  writing `/dead-letters/events/*` and `/dead-letters/jobs/*` as fully
  separate trees. Optional `?status=PENDING|REPLAYED|DISCARDED` and
  `?type=` (event type or job type) query filters, passed straight
  through to each engine's own `listDeadLetters(filter)`.
- `POST /admin/mega-engine/dead-letters/:engine/:id/replay` — calls
  `replayEventDeadLetter(id)`/`replayJobDeadLetter(id)`. Both underlying
  functions only ever throw a plain `Error` for "not found" or "already
  resolved" (their own doc comments confirm those are the only two
  failure modes), so this route catches and reports it as a 400 with the
  thrown message, rather than letting it fall through to a generic 500.
- `POST /admin/mega-engine/dead-letters/:engine/:id/discard` — calls
  `discardEventDeadLetter(id)`/`discardJobDeadLetter(id)`. Both
  underlying functions' own `UPDATE ... WHERE status = 'PENDING'` guard
  makes an already-resolved or missing row a silent no-op rather than an
  error (same "only mutate it if it's still safe to" posture
  `scheduler/job-store.ts`'s `cancelJob()` already uses), so this route
  has nothing extra to detect or report beyond success.
- Route- and dead-letter-id validation (`engine` must be `"events"`/
  `"jobs"`; `id` must parse as a positive integer — both dead-letter
  tables use a numeric serial key, not a uuid, unlike most of this
  codebase's other id columns) rejects obviously-malformed input with a
  400 before touching the DB, same posture `admin-oidc-rollout.ts`'s own
  `appId` check already uses.
- Successful `replay`/`discard` calls are logged via `logger.info(...)`
  with `actorId: req.user?.userId`, same audit-breadcrumb pattern
  `admin-oidc-rollout.ts`'s PATCH handler already uses for its own
  flag flips.

**`routes/index.ts`** — imports and mounts `adminMegaEngineRouter`, right
next to the other `requireDev`-gated admin console routers.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `requireDev`'s signature (`(req, res, next) => Promise<void>`, sets
  `req.user` before calling through) matches every other admin route's
  usage of it — confirmed against `middlewares/auth.ts`'s own
  definition, not assumed from a sibling file alone.
- `req.user?.userId` — `req.user`'s `Express.Request` augmentation lives
  in `middlewares/auth.ts` itself (`declare global` block), so importing
  only `requireDev` (no separate type import) is enough for this file to
  see the field, same as `admin-oidc-rollout.ts`'s own `req.user?.userId`
  reference.
- `getEngineHealth`/`getEventBusMetrics`/`getSchedulerMetrics`/
  `getWorkflowMetrics`/`listDeadLetters`/`replayDeadLetter`/
  `discardDeadLetter` — all seven are real barrel exports of `../lib/
  mega-engine`, `../lib/event-bus`, and `../lib/scheduler` respectively
  (confirmed against each `index.ts`, not assumed from the underlying
  file alone) — `../lib/workflow`'s barrel is only used for
  `getWorkflowMetrics` here, since workflow has no dead-letter functions
  to import.
- Express 5 (`package.json` pins `^5.2.1`) auto-forwards a rejected
  promise from an async handler to the default error middleware, so the
  `GET` handlers here (which don't validate anything that can fail)
  don't need their own `try/catch` — same reasoning every other admin
  route file in this codebase already relies on (none of them wrap their
  handlers either); only the two `POST .../replay` handler's call is
  wrapped, because that's the one call in this file whose thrown `Error`
  this phase wants surfaced as a 400 with a specific message rather than
  falling through to a generic 500.
- `/api` mount prefix: `app.ts`'s `app.use("/api", globalLimiter,
  apiKeyScopeGate, router)` confirms the four routes above resolve to
  `/api/admin/mega-engine/health`, `/api/admin/mega-engine/metrics`,
  `/api/admin/mega-engine/dead-letters/:engine`, and
  `/api/admin/mega-engine/dead-letters/:engine/:id/{replay,discard}`.

## Still open (Part E's remaining scope, out of E2)
- No admin **UI** page for any of this — E2 is the HTTP surface only, no
  frontend console screen consumes it yet (same split
  `admin-credit-console.ts`'s own backend-then-UI phases already show
  for a different subsystem).
- Workflow run inspection (`GET /admin/mega-engine/runs`, or similar —
  list/filter `workflow_run` rows, inspect one run's step history) isn't
  part of this phase; §57-E's "admin inspection" bullet is only covered
  here for the health/metrics/dead-letter angle, not a general workflow
  run browser.
- `cleanup` and `retention` (§57-E's last two bullets, §60's own
  per-table retention table) — untouched. No scheduled job or admin
  action anywhere yet deletes/archives old `event_outbox`/
  `event_processed`/`scheduled_job_attempt`/`workflow_run` rows per
  their own retention class.
- Latency metrics, `traceId` propagation, §40 Audit Integration, and
  Workflow → Event Bus reverse-direction publishing — all carried
  forward from E1's own "Still open" list, untouched by E2.
