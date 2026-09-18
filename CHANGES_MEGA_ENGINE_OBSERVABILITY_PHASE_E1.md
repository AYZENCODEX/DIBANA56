# AYZEN Mega Engine — Phase E1: Observability (§39 metrics + §61 Engine Health Model)

## Scope
`AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md` §57's own ordering
puts Part E ("Operations") after the D-phase integration work
(`CHANGES_MEGA_ENGINE_WORKFLOW_PHASE_D2.md`'s own "Still open" list
carries D's remaining integration items forward, untouched by this
phase). E1 is the first slice of Part E: §39's `events.*`/`workflow.*`/
`jobs.*`/`worker.*` counters, and §61's Engine Health Model that reads
them.

Part A (`event-bus/metrics.ts`) already shipped `events.*` (`published`/
`dispatched`/`handlerFailures`/`retried`/`deadLettered`/`unknownType`) —
nothing changed there this phase. What was still missing, and is what
E1 actually builds:
- Scheduler's own `jobs.*`/`worker.*` counters — `scheduler/metrics.ts`
  didn't exist at all.
- Workflow's own `workflow.*` run-lifecycle counters — `workflow/
  metrics.ts` didn't exist at all.
- §61's Engine Health Model itself — nothing under `lib/mega-engine/`
  existed; the directory didn't exist.

## What was built

**New file `lib/scheduler/metrics.ts`** — same in-process-counters, V1
posture `event-bus/metrics.ts` already documents for itself (see that
file's own header). Six counters (`jobsScheduled`/`jobsExecuted`/
`jobsFailed`/`jobsRetried`/`jobsDeadLettered`/`workerFailures`) plus two
gauges, `workerActive`/`workerLastHeartbeatAt`, set (not incremented)
around each `runSchedulerSweep()` tick — a hung sweep (`workerActive`
still `true` well past the 5s poll cadence) is itself a DEGRADED signal
for `engine-health.ts` to read. New `SchedulerMetricsSnapshot` type in
`scheduler/types.ts`; `getSchedulerMetrics()` exported from `scheduler/
index.ts`'s barrel alongside the existing scheduler exports.

- `scheduler/job-store.ts`: `recordJobScheduled()` called from all three
  scheduling entry points — `scheduleJob()`, `scheduleCron()`,
  `scheduleRecurring()`.
- `scheduler/worker.ts`: `recordJobExecuted()`/`recordJobFailed()`/
  `recordJobDeadLettered()`/`recordJobRetried()` called at the matching
  outcome in both `dispatchJob()` (one-time) and `dispatchRecurringJob()`
  (cron/interval) — same pairing both functions already had for
  `moveToDeadLetter()`/backoff. `recordWorkerSweepStart()`/
  `recordWorkerSweepEnd()` wrap `runSchedulerSweep()`'s body (`finally`,
  so a thrown sweep still clears `workerActive`); `recordWorkerFailure()`
  fires on that same thrown-sweep path, before the error is rethrown.

**New file `lib/workflow/metrics.ts`** — same posture, scoped to just
the four run-lifecycle counters §39 actually lists
(`workflow.started`/`.completed`/`.failed`/`.timed_out`); `CANCELLED`/
`COMPENSATED`/`DEAD_LETTER` aren't in §39's list and so aren't counted
(see the new `WorkflowMetricsSnapshot` type's own doc comment in
`workflow/types.ts`). `recordRunTransition(to)` takes the transition's
target status and switches on it internally, so `run-store.ts`'s
`transitionRun()` — the one place every run-status change already
funnels through, per its own §17 `assertRunTransition()` guard — only
needs one call per transition rather than picking the right counter at
every call site.

- `workflow/run-store.ts`: `recordRunStarted()` called from `startRun()`;
  `recordRunTransition(to)` called from `transitionRun()`, after the
  status write.
- `workflow/index.ts`: exports `getWorkflowMetrics` and the
  `WorkflowMetricsSnapshot` type from the barrel.

**New directory `lib/mega-engine/`** — didn't exist before this phase.
- `engine-health.ts` — §61's own three-subsystem tree (Event Bus /
  Scheduler / Workflow), each with four leaves, each leaf resolving to
  one of `HealthState`'s four values (`HEALTHY`/`DEGRADED`/`UNHEALTHY`/
  `DISABLED` — nothing produces `DISABLED` yet, same
  shape-exists-nothing-produces-it-yet posture `workflow/types.ts`'s
  `WorkflowRunStatus` already has for a few of its own members). A
  subsystem's state is the worst of its leaves'; the engine's overall
  state is the worst of the three subsystems'.
  - Event Bus: `outbox` (overdue `PENDING`/`FAILED` rows, DB query),
    `dispatcher` (handler-failure ratio, from `getEventBusMetrics()`),
    `consumers` (any `unknownType` seen this process), `dlq` (pending
    dead-letter count).
  - Scheduler: `queue` (overdue `SCHEDULED`/`RETRYING` rows), `workers`
    (heartbeat staleness + `workerFailures`, from `getSchedulerMetrics()`),
    `lease` (expired-but-unreclaimed `RUNNING` rows), `dlq` (pending
    dead-letter count).
  - Workflow: `registry`/`store` (DB-reachability only — neither has its
    own counter yet, so a successful `workflow_run` query is the only
    signal available in V1), `runner` (stuck-`RUNNING`-run count, via a
    proxy — see the file's own "still open" caveat about `timeoutMs`/
    `maxRuntimeMs` not being enforced yet — plus `getWorkflowMetrics()`'s
    failure ratio), `checkpoint` (shares `store`'s outcome; kept as its
    own field so §61's four-leaf shape stays intact for whenever a real
    checkpoint signal exists).
  - `getEngineHealth()` — the top-level §61 call; does several DB
    round-trips (`Promise.all`'d across the three subsystems), so it's
    meant for an admin/health route or a periodic self-check job, not a
    hot request path.
  - Every threshold (overdue grace windows, DEGRADED/UNHEALTHY counts,
    stale-heartbeat window, stuck-run grace) is a fixed constant, not
    configurable — deliberately coarse V1 (§56), same posture this
    phase's other two metrics modules already document for themselves.
- `index.ts` — barrel export (`getEventBusHealth`/`getSchedulerHealth`/
  `getWorkflowHealth`/`getEngineHealth` + the `HealthState`/
  `ComponentHealth`/`*SubsystemHealth`/`EngineHealth` types), same
  "import from the directory, not the file" convention `event-bus/
  index.ts`, `scheduler/index.ts` and `workflow/index.ts` already
  establish for themselves.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `event_outbox`/`event_dead_letter`, `scheduled_job`/
  `scheduled_job_dead_letter`, `workflow_run` — the raw-SQL table names
  `engine-health.ts`'s `sql` template literals and `db.select()` calls
  use — match the `pgTable(...)` first argument in `lib/db/src/schema/
  event-bus.ts`/`scheduler.ts`/`workflow.ts` exactly, and each of those
  tables' `status`/`next_attempt_at`/`run_at`/`locked_until`/
  `updated_at` columns exist under the names the queries reference.
- `eventOutboxTable`, `eventDeadLetterTable`, `scheduledJobTable`,
  `scheduledJobDeadLetterTable`, `workflowRunTable` — all five are real
  named exports of `@workspace/db` (via `lib/db/src/schema/*.ts`), so
  `engine-health.ts`'s import line resolves.
- No circular import: `mega-engine/engine-health.ts` imports from
  `../event-bus`, `../scheduler`, `../workflow`; none of those three
  barrels (or anything they import) reaches into `../mega-engine` —
  confirmed by grep across all three directories.
- `getEventBusMetrics()`'s return shape (`published`/`dispatched`/
  `handlerFailures`/`retried`/`deadLettered`/`unknownType`) matches what
  `checkDispatcher()`/`checkConsumers()` read off it; same check for
  `getSchedulerMetrics()` against `checkWorkers()` and
  `getWorkflowMetrics()` against `checkRunner()`.
- `WorkflowRunStatus`'s ten members (`workflow/types.ts`) — the
  `recordRunTransition()` switch in the new `workflow/metrics.ts`
  only branches on the three that exist in both that union and §39's
  list; the `default: break` case is deliberate, not a missed value.

## Still open (Part E's remaining scope, out of E1)
- The admin/health route itself — `getEngineHealth()` has no HTTP
  handler wired to it yet (`engine-health.ts`'s own header already flags
  this as "Part E's remaining 'admin inspection' item, not yet built").
- Latency metrics (§39's `event_publish_latency`/`event_handler_latency`/
  `workflow_duration`/`step_duration`/`scheduler_lag`/
  `job_execution_duration`) — this phase only covers §39's plain
  counters/gauges, not the latency-metrics list further down the same
  section.
- `traceId`/`causationId` propagation as a first-class observability
  concern (§39's opening list) — `correlationId`/`causationId` already
  exist as columns/params across all three subsystems from earlier
  phases, but nothing in E1 adds a dedicated `traceId`.
- §40 Audit Integration — a separate, security-focused concern §39's own
  section boundary keeps apart from this phase's metrics/health work.
- Workflow → Event Bus reverse-direction publishing
  (`workflow.started`/`.completed`/`.failed` as actual bus events, not
  just in-process counters) — still on D's carried-over "still open"
  list, untouched by E1.
