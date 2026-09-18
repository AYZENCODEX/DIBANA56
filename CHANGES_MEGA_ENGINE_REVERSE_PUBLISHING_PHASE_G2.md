# AYZEN Mega Engine — Phase G2: Workflow → Event Bus Reverse Publishing (§65 "G: Observability/admin"; §39's opening list)

## Scope
The single most persistently-carried-forward item in this session's
"Still open" sections — named, word for word, in
`CHANGES_MEGA_ENGINE_WORKFLOW_PHASE_D2.md` (where it originates, as
D's own leftover), then in every one of E1/E2/E3's own "Still open"
lists, then again in G1's: *"Workflow → Event Bus reverse-direction
publishing (`workflow.started`/`.completed`/`.failed` as actual bus
events, not just in-process counters)."* D1/D2 already built the
opposite direction (Event Bus → Workflow: `triggers.ts` subscribes to
bus events and starts runs from them) and Workflow → Scheduler
integration (`scheduler-integration.ts`); this phase is the one
remaining leg of §39's cross-engine observability list D2 flagged and
never came back to.

Deliberately scoped to exactly the three event types D2's own wording
names — `workflow.started`/`.completed`/`.failed` — not every
`WorkflowRunStatus`. `recordRunTransition()` (`workflow/metrics.ts`,
Part E1) already counts a fourth status, `TIMED_OUT`, as an in-process
counter; this phase does not additionally promote it to a bus event,
since no "still open" note anywhere in this session's history has ever
named it as part of this item's scope — widening it is a future phase's
call to make deliberately, not this one's to guess at (Rule 17).

## What was built

**`lib/workflow/run-store.ts`** — three new event types self-registered
at module load, same "individual domain modules... take over
registering their own types" convention `scheduler/worker.ts`'s own
`scheduler.job.*` registrations already established for a sibling engine
publishing in this same reverse direction:
- `workflow.started` — `{ runId, definitionId, definitionVersion }`.
- `workflow.completed` — `{ runId, definitionId, definitionVersion }`.
- `workflow.failed` — `{ runId, definitionId, definitionVersion,
  lastError? }` (`lastError` optional, mirroring `transitionRun()`'s own
  `patch.lastError` being optional).

No circular import: `workflow/` already imports FROM `event-bus/` in one
direction (`triggers.ts`'s `subscribe`/`EventEnvelope` import, from Part
D) — `run-store.ts` adding `registerEvent`/`publishEvent` from the same
package is the same direction, not a new one, and `event-bus/` still
imports nothing from `workflow/` — confirmed by grep across both
directories, same check every phase touching this boundary has run.

- `startRun()` — publishes `workflow.started` right after the run/first-
  step-run inserts, passed the SAME optional `tx` the function itself
  took (same reasoning `publisher.ts`'s own header gives: when a caller
  provides a transaction, "a run exists" and "a `workflow.started` event
  exists" can never disagree; without one, this is the weaker,
  already-documented best-effort guarantee every other optional-`tx`
  call site in this codebase has). `correlationId`/`causationId` on the
  envelope are the run's own start params, preserving whatever caused
  the run to begin.
- `transitionRun()` — publishes `workflow.completed`/`workflow.failed`
  immediately after the existing G1 `workflow_duration` recording, gated
  on `to === "COMPLETED"` / `to === "FAILED"` respectively, same optional
  `tx` pass-through. `correlationId` is the run's own (preserving the
  trace chain from however the run was started); `causationId` is the
  run's own `id` — this run reaching a terminal status is what directly
  caused the event, there being no more specific "triggering event id"
  available inside the engine's synchronous transition path (contrast
  `scheduler.job.completed`, which reuses the job's own `correlationId`
  as its `causationId` too, for lack of any per-job "originating event
  id" field to point at instead — `WorkflowRun` has a real, separate
  `causationId` column already, so this phase uses that instead of
  reaching for the same workaround).

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `registerEvent`/`publishEvent` are real named exports of
  `event-bus/index.ts`'s barrel (`export { registerEvent, ... } from
  "./event-registry"`; `export { publishEvent, ... } from
  "./publisher"`), so `run-store.ts`'s `import { registerEvent,
  publishEvent } from "../event-bus"` resolves.
- `PublishEventParams<T>`'s shape (`type`, `payload`, `version?`,
  `actor?`, `aggregate?`, `correlationId?`, `causationId?`, `metadata?`)
  covers every field this phase's three `publishEvent()` call sites pass
  — no call site supplies anything the type doesn't declare.
- `z` from `"zod/v4"` — the same import path `event-bus/event-registry.ts`
  and `scheduler/worker.ts` already use for their own `registerEvent()`
  schemas, confirmed by grep, not a different major version accidentally
  pulled in.
- `transitionRun()`'s new branch reads `patch?.lastError` — already a
  real field of that function's own `patch` parameter type
  (`Partial<Pick<WorkflowRun, "lastError" | ...>>`), not a new field
  invented for this phase.
- `current.definitionId`/`current.definitionVersion`/
  `current.correlationId` — all real fields of `WorkflowRun`
  (`workflow/types.ts`), already populated by the same `getRun(id)` call
  `transitionRun()` was making before this phase, not new reads added
  without a matching source.
- No dispatcher-side change: `event-registry.ts`'s
  `DEFAULT_EVENT_TYPES` list is untouched, and `dispatcher.ts` needs no
  changes to deliver these — any subscriber that calls `subscribe(
  "workflow.started" | "workflow.completed" | "workflow.failed", ...)`
  from here on gets delivery through the exact same claim/lease/retry
  path every other event type already uses.

## Still open (carried forward, untouched by G2)
- Nobody actually subscribes to the three new event types yet — this
  phase is the *publish* side only. §57-D's own "actual domain-
  integration connections (Notifications/Credits/Organizations/OIDC/
  Vault/Telegram/Astra)" list (still not started, per D2's own "still
  open") is the natural source of a first real subscriber, whenever that
  work begins.
- `workflow.timed_out` (or any other `WorkflowRunStatus` beyond the three
  built here) as a bus event — deliberately out of scope, see this
  phase's own "Scope" section above.
- `traceId` propagation, §40 Audit Integration — both carried forward
  from E1/G1's own "Still open" lists, untouched here.
- Admin-UI screens generally — still just a backend/event-bus surface,
  same gap E2 flagged for its own routes and no phase since has closed.
