# AYZEN Mega Engine — Phase I8: Health/Metrics/Dead Letters/Retention Screen

## Scope
Closes the item `mega-engine.tsx`'s own header has carried forward,
unchanged, since I4 first named it — *"Health/metrics/dead-letters/
retention already have working routes on the same router but no screen
of their own yet either; that's carried forward untouched, not folded
in here."* — and every phase from I4 through I7 repeated verbatim in
its own "Still open" list. All four routes (`routes/admin-mega-engine.ts`,
Parts E1-E3) have existed since before I1; this page is their first
renderer.

Deliberately **one page, not four** — `Tabs`, not four separate sidebar
entries/routes — same "one screen for one coherent slice of the engine"
posture `mega-engine.tsx` itself set for the Workflow Runs list+detail
pair. Health/Metrics/Dead Letters/Retention are four different reads of
the same three subsystems (Event Bus, Scheduler, Workflow), not four
unrelated features, so one page keeps them next to each other the way
an operator actually reasons about "is the engine OK" — flip from
health to metrics to dead letters without losing place.

## What was built

**`src/pages/admin/mega-engine-observability.tsx`** (new)
- **Health tab** — `GET /admin/mega-engine/health`, rendered as three
  `SubsystemCard`s (Event Bus / Scheduler / Workflow), each showing its
  four leaf components (outbox/dispatcher/consumers/dlq,
  queue/workers/lease/dlq, registry/runner/checkpoint/store) with a
  status badge (HEALTHY/DEGRADED/UNHEALTHY/DISABLED) and any
  human-readable `reasons[]` engine-health.ts attaches. Manual Refresh
  only — see "No polling" below.
- **Metrics tab** — `GET /admin/mega-engine/metrics`, the three engines'
  in-process counters plus their `LatencySnapshot` fields
  (count/sum/min/max/avg), rendered as plain stat grids with a
  `fmtLatency()` helper for the "no samples yet" empty case.
- **Dead Letters tab** — `GET /admin/mega-engine/dead-letters/:engine`
  with an engine toggle (events/jobs) and optional status/type filters,
  a table of rows, and per-row Replay/Discard actions
  (`POST .../:engine/:id/replay`, `POST .../:engine/:id/discard`) —
  both already-existing store-layer operations, this tab is their first
  UI. `DeadLetterRow` intentionally carries both engines' fields as
  optional (`eventId`/`eventType`/`consumer`/`envelope` vs.
  `jobId`/`jobType`/`payload`/`attempts`) rather than two separate row
  types, matching the route's own single-shape-per-engine response.
- **Retention tab** — `GET /admin/mega-engine/retention` (the five
  configured `RETENTION_WINDOWS_MS` windows, read-only — §60's `audit`
  row deliberately excluded, same as the backend) plus a confirm-gated
  "Run sweep now" button (`POST /admin/mega-engine/retention/run`) that
  shows the returned `RetentionSweepResult` counts per table after it
  runs. The confirm dialog's copy is explicit that this is the same
  sweep already running daily at 03:00 UTC, not a second mechanism, and
  that audit records are never touched — matching retention.ts's own
  scope.

All four tabs' TypeScript interfaces mirror their backend counterparts
byte-for-byte (`lib/mega-engine/engine-health.ts`'s `HealthState`/
`ComponentHealth`/`EventBusHealth`/`SchedulerSubsystemHealth`/
`WorkflowSubsystemHealth`/`EngineHealth`; `event-bus/types.ts`,
`scheduler/types.ts`, `workflow/types.ts`'s three `*MetricsSnapshot`
shapes; `retention.ts`'s `RETENTION_WINDOWS_MS` key set and
`RetentionSweepResult`) — no new backend fields, no reshaping, this
page only renders what the four routes already return.

**`src/lib/route-config.tsx`**
- New lazy import `AdminMegaEngineObservability` and a new route entry
  `/admin/mega-engine/observability`, `allowedRoles: ["dev"]` — same
  gate as `/admin/mega-engine` itself and every other entry in this
  file's Mega Engine/OIDC/Policy admin-console cluster.

**`src/components/layout/app-sidebar.tsx`**
- New "Health & Metrics" item under the existing "Mega Engine" sidebar
  group, alongside "Workflow Runs", using a new `Gauge` icon import
  (kept distinct from `HeartPulse`, already used elsewhere in this file
  for Emergency Access, to avoid two unrelated sidebar entries sharing
  one icon).

## No polling on any tab
Unlike `mega-engine.tsx`'s own I5/I6/I7 (detail-dialog poll, list poll,
tab-visibility guard on both) — intentionally out of scope for this
phase's own narrow slice, same "start with the Refresh button, add
polling later if actually asked for" posture `mega-engine.tsx`'s
*original* I4 version took before I5 added polling. Each tab has its
own Refresh button; nothing here auto-refreshes, and there is
accordingly nothing here for I7's tab-visibility guard to apply to.

## Still open (carried forward, untouched by I8)
- The in-flight action non-interruptibility (I1), the two negligible
  I1-named races, step-level `timeoutMs`, `traceId` propagation, §40
  Audit Integration, `workflow.timed_out` as a bus event, the
  `tx`-supplied caller edge case (H1) — all still carried forward
  untouched.
- I6's banner copy on the Workflow Runs list is still generic ("a run
  appeared or changed status") with no count or per-row highlight —
  unchanged from I6.
- No polling/auto-refresh anywhere on this new page (see "No polling on
  any tab" above) — a reasonable future follow-up if this screen sees
  enough operator use to justify it, same way I5/I6 followed I4 for the
  Workflow Runs page, but not this phase's own scope.
- Health/Metrics/Dead Letters/Retention now have a screen — but no
  cross-links between it and the Workflow Runs page (e.g. a dead-letter
  row for a workflow-adjacent job doesn't link to the run it's
  correlated with, and the Workflow subsystem's health card doesn't
  link out to the runs list). Two separate pages under one sidebar
  group for now, not yet a single integrated console.
