# AYZEN Mega Engine — Phase D2: Workflow ↔ Scheduler (§23 Schedule + Delayed triggers)

## Scope
`AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md` §57's own Part D
list orders the integration work as: Event Bus ↔ Workflow (D1, done) →
**Workflow ↔ Scheduler (D2)** → Services ↔ Event Bus → domain
integrations (Notifications/Credits/Organizations/OIDC/Vault/
Telegram/Astra) → Part E Operations. D1's own close-out
(`CHANGES_MEGA_ENGINE_WORKFLOW_PHASE_C_COMPLETE_D1.md`) explicitly
tracked this piece separately: §23's `"schedule"` and `"delayed"`
trigger kinds had a type shape (`types.ts`) and validation
(`definition-store.ts`'s `validateDefinition()`) since Part C1, but no
actual wiring — no cron job ever got created for a `{ kind: "schedule" }`
definition, and no event listener ever turned a `{ kind: "delayed" }`
definition's anchor event into a scheduled job.

This is **not** the `workflow.resume` wakeup path (`scheduler-
integration.ts`/`scheduler-handler.ts`, §24 Waiting) — that's a
RUNNING run's own step-retry-backoff/wait mechanism, already wired since
Part C2. D2 is about **starting brand-new runs** from a clock (schedule)
or from "N time after some other event" (delayed) — the other two
trigger kinds §23 lists beyond D1's `"event"`.

## What was built

New file: `lib/workflow/schedule-triggers.ts`.

- `registerWorkflowTriggerJobHandlers(env)` — registers ONE job handler
  shared by both trigger kinds (`WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE` =
  `"workflow.trigger.schedule"`, `WORKFLOW_DELAYED_TRIGGER_JOB_TYPE` =
  `"workflow.trigger.delayed"`). Both do the same thing at due-time:
  read `workflowId` (+ optional `context`/`causationId`) from the job's
  payload, `startRun()` + `executeRun()`.
- `registerWorkflowScheduleTriggers(env)` — boot-time registrar. Loads
  every ACTIVE `{ kind: "schedule" }` definition and, for each one that
  doesn't already have a live recurring job (see dedupe note below),
  calls `scheduleCron()` with the definition's own `cron`/`timezone`,
  payload `{ workflowId }`, `correlationId: workflowId`.
- `registerWorkflowDelayedTriggers(env)` — boot-time registrar. Loads
  every ACTIVE `{ kind: "delayed" }` definition, groups the ones that
  have a `relativeToEventType` by that eventType, and subscribes exactly
  ONE event-bus consumer per distinct eventType (`workflow-delayed-
  trigger:<eventType>`) — same one-consumer-fans-out-to-N-workflows
  shape D1's `triggers.ts` already uses for the `"event"` kind. On each
  matching event, schedules a ONE-TIME job `afterMs` out via
  `scheduleDelayed()` (not an immediate run — the run only starts later,
  when that delayed job comes due), carrying the anchor event's
  `userId`/`organizationId`/`correlationId`/`payload` through as the
  eventually-started run's `WorkflowContext`, same safe/narrow field set
  D1 already copies for its own immediate trigger.
- Definitions with `{ kind: "delayed" }` but no `relativeToEventType`
  are logged and skipped — §23's own example ("run 24 hours after
  event") presumes an anchor event; there's nothing to measure `afterMs`
  from otherwise, and guessing one (boot time? first observation?) isn't
  this phase's call to make.

## New store-layer helpers

- `definition-store.ts`: `listActiveScheduleTriggeredDefinitions()` and
  `listActiveDelayedTriggeredDefinitions()`, mirroring D1's own
  `listActiveEventTriggeredDefinitions()`. Factored the shared "newest
  ACTIVE version per workflowId, across all workflows" query out into a
  private `listLatestActiveDefinitions()` so the three functions don't
  triplicate the same dedupe-by-workflow loop.
- `scheduler/job-store.ts`: `hasActiveJobForCorrelation(jobType,
  correlationId)` — new. `subscribe()` (event-bus) is naturally
  idempotent per `(eventType, consumer)`, so D1's registrar needed no
  extra guard against re-running at every boot. `scheduleCron()` is
  **not** idempotent — it inserts a fresh row every call — so without
  this guard, `registerWorkflowScheduleTriggers()` re-running at every
  boot would accumulate one duplicate recurring cron job per restart for
  the same workflow. The guard checks for any not-yet-terminal
  (`COMPLETED`/`FAILED`/`CANCELLED`/`DEAD_LETTER` excluded) job of that
  `jobType`+`correlationId` and skips re-scheduling if one already
  exists. Exported from `scheduler/index.ts`'s barrel alongside the
  existing `scheduleJob`/`scheduleCron`/etc.

## Barrel export
`lib/workflow/index.ts` now also exports `WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE`,
`WORKFLOW_DELAYED_TRIGGER_JOB_TYPE`, `registerWorkflowTriggerJobHandlers`,
`registerWorkflowScheduleTriggers`, `registerWorkflowDelayedTriggers`, and
the two new definition-store list functions — same "ready to be wired up
by a future phase's boot code" posture D1 and Part C2's `registerWorkflowResumeHandler`
already document for themselves. No `AyzenMegaEngine.start()` (§36) boot
file exists anywhere in this codebase yet — that's still a later phase's
job (Part D's remaining domain-integration items, or Part E) to actually
call all of `registerWorkflowResumeHandler()` / `registerWorkflowEventTriggers()`
/ `registerWorkflowScheduleTriggers()` / `registerWorkflowDelayedTriggers()`
together at process boot.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `scheduledJobTable` column names (`jobType`, `correlationId`, `status`)
  match `hasActiveJobForCorrelation()`'s query exactly, and there's
  already an index on `correlationId` (migration 112), so the dedupe
  check is cheap.
- `drizzle-orm`'s `notInArray` — not previously imported anywhere in this
  codebase, but a standard sibling of the already-used `inArray`
  (confirmed via the installed package's own type exports pattern this
  codebase already relies on for `inArray`/`eq`/`and`/`desc`).
- `scheduleCron()`'s `ScheduleCronParams` and `scheduleDelayed()`'s
  signature (`jobType, delayMs, payload, opts`) match what
  `schedule-triggers.ts` calls them with.
- `startRun()`'s `StartWorkflowRunParams` (`definitionId`, `context`,
  `correlationId`, `causationId`) and `executeRun(runId, env)` match.
- No circular import: `schedule-triggers.ts` imports `./engine` (like
  `triggers.ts` already does); `engine.ts` does not import
  `schedule-triggers.ts` back, so — unlike the resume path's
  `scheduler-integration.ts`/`scheduler-handler.ts` split — one file for
  both the registrar and the job-handler registration is fine here, same
  as D1's `triggers.ts` already being a single file for its own
  subscribe-registration + (implicit, via `executeRun`) handling.

## Still open (Part D's remaining scope, out of D2)
- Workflow → Event Bus (reverse direction): run lifecycle
  (`workflow.started`/`.completed`/`.failed`) publishing as its own
  event — still not registered (carried over from D1's own "এখনো বাকি"
  list, untouched by D2).
- `"api"`/`"manual"` trigger kind route wiring, and the actual
  domain-integration connections (Notifications/Credits/Organizations/
  OIDC/Vault/Telegram/Astra) §57-D lists after "Workflow ↔ Scheduler" —
  still not started.
- Step-level `timeoutMs` / run-level `maxRuntimeMs` enforcement (noted
  as missing since Part C, still missing).
- Mid-step cancellation (noted as missing since Part C, still missing).
- The durable, cross-restart version of both redelivery guards in this
  codebase now (`triggers.ts`'s `startedForEvent`, this file's
  `scheduledForEvent`) — both are still process-local in-memory sets.
