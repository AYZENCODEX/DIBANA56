# AYZEN Mega Engine — Phase G1: Latency Metrics (§65 "G: Observability/admin"; §39's own "Latency metrics" list)

## Scope
§65 ("Recommended Phase Placement") lists Mega Engine work as A Event Bus
foundation, B Scheduler foundation, C Workflow foundation, D Cross-engine
integration, E Domain integrations, F Reliability/security, G
Observability/admin, H Production hardening — the correction
`CHANGES_MEGA_ENGINE_RELIABILITY_PHASE_F1.md` already made explicit for
this session: what E1–E3 actually built (health/metrics/admin
inspection/replay/dead-letter tools/cleanup/retention, §57-E's own list)
is closer to §65's `G` than its `E`. This phase is the next `G`-lettered
slice: E1's own "Still open" section flagged it directly, word for word,
every time it was carried forward through E2 and E3 without being
touched — *"Latency metrics (§39's `event_publish_latency`/
`event_handler_latency`/`workflow_duration`/`step_duration`/
`scheduler_lag`/`job_execution_duration`) — this phase only covers §39's
plain counters/gauges, not the latency-metrics list further down the
same section."*

## What was built

**New file `lib/latency-histogram.ts`** — a shared, zero-dependency
`createLatencyHistogram()` (`record(ms)`/`snapshot()`), living directly
under `lib/` rather than under `mega-engine/`, for the same reason
`lib/logger.ts`/`lib/log-bus.ts` already live there: `event-bus/
metrics.ts`, `scheduler/metrics.ts`, and `workflow/metrics.ts` each need
it, and `mega-engine/*` already imports FROM all three of those
directories — a shared dependency under `mega-engine/` would invert that
direction. Deliberately count/sum/min/max/avg only, no percentiles (a
real p50/p95/p99 needs a reservoir sample or a streaming sketch — Rule
17, not a natural extension of "increment a counter" yet). Negative or
non-finite samples are silently dropped rather than corrupting the
running aggregate.

**`event-bus/types.ts` + `event-bus/metrics.ts`** — `EventBusMetricsSnapshot`
gains `publishLatencyMs`/`handlerLatencyMs` (both `LatencySnapshot`);
`recordPublishLatency()`/`recordHandlerLatency()` exported.
- `event-bus/publisher.ts`: `publishEvent()` times its own outbox INSERT
  (payload validation excluded — synchronous/cheap, same "measure the
  I/O" scope every recording site in this phase draws) — §39's
  `event_publish_latency`.
- `event-bus/dispatcher.ts`: `dispatchRow()` times each subscriber's
  handler call, started just after the `hasProcessed()` idempotency check
  (dedupe bookkeeping, not the handler's own work) and recorded in BOTH
  the success path and the catch block — §39's `event_handler_latency`,
  independent of outcome (`dispatched`/`handlerFailures` already cover
  outcome).

**`scheduler/types.ts` + `scheduler/metrics.ts`** — `SchedulerMetricsSnapshot`
gains `schedulerLagMs`/`jobExecutionDurationMs`; `recordSchedulerLag()`/
`recordJobExecutionDuration()` exported.
- `scheduler/worker.ts`: both `dispatchJob()` (one-time) and
  `dispatchRecurringJob()` (cron/interval) record `scheduler_lag`
  (`dispatchStartedAt - job.runAt`, before the handler runs — queue wait
  time, not handler behavior) and `job_execution_duration` (after the
  handler settles, success or failure). For a recurring job under
  CATCH_UP, `job_execution_duration` covers the whole `runsToExecute`
  loop as one sample, not per-occurrence — that dispatch is already
  treated as one unit for retry/backoff purposes, so its duration is
  measured the same way.

**`workflow/types.ts` + `workflow/metrics.ts`** — `WorkflowMetricsSnapshot`
gains `runDurationMs`/`stepDurationMs`; `recordRunDuration()`/
`recordStepDuration()` exported.
- `workflow/run-store.ts`: `transitionRun()` records `workflow_duration`
  once a run reaches ANY terminal status (via `state-machine.ts`'s
  `isTerminalRunStatus()`, not just COMPLETED — a FAILED/CANCELLED/etc.
  run still took real time and is just as useful a duration sample),
  measured from the run's own `startedAt` (its value from BEFORE this
  transition's `patch` is applied).
- `workflow/engine.ts`: `runStep()` records `step_duration` around
  `dispatchAction()` only — not the surrounding condition evaluation or
  step-run row transitions, and not the `WaitForResume` control-flow path
  (a step that's waiting hasn't settled, so no duration sample is taken
  for it).

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `latency-histogram.ts`'s `LatencySnapshot`/`LatencyHistogram` exports
  match every import site's usage (`event-bus/types.ts`,
  `scheduler/types.ts`, `workflow/types.ts` all import only
  `LatencySnapshot`; the three `metrics.ts` files import only
  `createLatencyHistogram`).
- No circular import: `lib/latency-histogram.ts` imports nothing from
  `event-bus/`, `scheduler/`, or `workflow/` — confirmed by grep; it's a
  pure leaf module, same posture `lib/logger.ts` already has.
- Every new `record*()` call site's counterpart function exists with a
  matching name and single-`number`-argument signature in the metrics
  file it's imported from (`recordPublishLatency`/`recordHandlerLatency`
  in `event-bus/metrics.ts`; `recordSchedulerLag`/
  `recordJobExecutionDuration` in `scheduler/metrics.ts`;
  `recordRunDuration`/`recordStepDuration` in `workflow/metrics.ts`).
- `mega-engine/engine-health.ts`'s three `get*Metrics()` call sites read
  named fields off each snapshot (`m.handlerFailures`, etc.) rather than
  spreading or literal-constructing the whole shape, so the new fields
  added here are additive and don't require any change there — confirmed
  by grep across `mega-engine/`.
- `run-store.ts`'s `transitionRun()` reads `current.startedAt` — the
  value fetched BEFORE this transition's own `UPDATE` — not a value the
  `patch` being applied in the same call could have just set, so a
  terminal transition's own `completedAt`/etc. arriving in the same
  `patch` object doesn't retroactively change what `startedAt` this
  duration sample is measured against.

## Still open (carried forward, untouched by G1)
- `traceId` propagation as a first-class observability concern (§39's
  opening list) — `correlationId`/`causationId` already exist across all
  three subsystems, but nothing yet adds a dedicated `traceId`.
- §40 Audit Integration — a separate, security-focused concern §39's own
  section boundary keeps apart from this phase's metrics work.
- Workflow → Event Bus reverse-direction publishing
  (`workflow.started`/`.completed`/`.failed` as actual bus events, not
  just in-process counters) — still on D's carried-over "still open"
  list, untouched by G1.
- Admin-UI screens generally, and no route yet surfaces the new latency
  fields specifically (`GET /admin/mega-engine/metrics`, from E2,
  already returns the full `get*Metrics()` snapshots as-is, so the new
  fields are already reachable there with no route change needed — but
  nothing highlights them specifically for an operator).
- No percentile latency (p50/p95/p99) — deliberately out of scope, see
  this phase's own "What was built" section above.
