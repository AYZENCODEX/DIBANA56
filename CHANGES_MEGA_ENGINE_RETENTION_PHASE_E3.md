# AYZEN Mega Engine — Phase E3: Retention & Cleanup (§60 / §57-E's last two bullets)

## Scope
§57-E's full list is `health`, `metrics`, `admin inspection`, `replay`,
`dead-letter tools`, `cleanup`, `retention`. E1 built the first two, E2
built the middle three (as an HTTP surface over store-layer functions
that mostly already existed). E3 is the last two — the only pair on the
list with no prior implementation at all, store-layer or otherwise.

§60 defines the actual policy, one row per table-class:

```
event_outbox      -> short operational retention
event_processing  -> compact retention
dead_letter       -> longer operational retention
workflow_run      -> configurable business retention
scheduler attempts -> short operational retention
audit             -> governed by existing audit policy
```

`audit` is explicitly excluded — §60's own closing line: *"Do not delete
audit records merely because event records expire."* Nothing in this
phase touches anything audit-related.

## What was built

**New file `lib/mega-engine/retention.ts`** — implements the five
non-audit rows above as one function, `runRetentionSweep()`:

- **`event_outbox`** (short — 3 days): only `PUBLISHED` rows, cut off by
  `publishedAt`. `PENDING`/`FAILED` rows are never touched regardless of
  age — those are exactly what `engine-health.ts`'s own `checkOutbox()`
  reads as an overdue-dispatcher signal, so sweeping them would hide a
  real problem instead of reporting it.
- **`event_processed`** (compact — 7 days): plain age cutoff on
  `processedAt`. This table is a pure `(event_id, consumer)`
  idempotency-dedupe record with no status of its own — once a row is
  past any plausible redelivery window it has no further use.
- **`event_dead_letter` + `scheduled_job_dead_letter`** (longer — 90
  days): both engines' DLQ tables, treated as one policy since §57-E
  groups them as a single "dead_letter" bullet and `engine-health.ts`
  already treats them as parallel signals. Only `REPLAYED`/`DISCARDED`
  rows, cut off by `resolvedAt` — a still-`PENDING` dead letter is
  exactly what an operator is expected to still be looking at (via E2's
  `/dead-letters` routes) and is never swept regardless of age.
- **`workflow_run`** (business — 180 days, V1 placeholder for §60's own
  "configurable"): only the six terminal statuses
  (`COMPLETED`/`FAILED`/`CANCELLED`/`TIMED_OUT`/`COMPENSATED`/
  `DEAD_LETTER`) — never `PENDING`/`RUNNING`/`WAITING`/`COMPENSATING`.
  Cutoff is `updated_at`, not `completed_at` — `engine.ts`'s
  `transitionRun()` calls currently only set `completedAt` on the
  `COMPLETED` transition (confirmed by reading every `transitionRun(...)`
  call site in `engine.ts`), while `run-store.ts`'s `transitionRun()`
  itself always bumps `updated_at` in the same `UPDATE` regardless of
  target status, making it the one column reliably set across all six
  terminal statuses. Deletes cascade by hand into `workflow_step_run`,
  `workflow_checkpoint`, and `workflow_variable` (all three keyed by
  `run_id` with no FK/cascade — `schema/workflow.ts`'s own header says so
  explicitly), children-then-parent, inside one transaction so a crash
  mid-sweep can't strand orphaned child rows with no parent left to ever
  sweep them by.
- **`scheduled_job_attempt`** (short — 14 days): plain age cutoff on
  `startedAt`, independent of the parent job's own status — these are
  per-attempt log rows, not the job record itself.

Every window is a fixed constant (`RETENTION_WINDOWS_MS`), not yet wired
to a real config knob — §53's own Configuration list has no `RETENTION_*`
entry, so this is the same "deliberately coarse V1" posture
`engine-health.ts`'s thresholds already document for themselves. Every
delete is a plain unbounded `DELETE ... WHERE`, no batching — same
reasoning.

`scheduled_job` itself (the job row, as distinct from its
`scheduled_job_attempt` log rows) has **no §60 entry** and isn't touched
by this phase — see the file's own header for why that's a deliberate
omission, not an oversight, and this phase's own "Still open" section
below.

**Recurring job wiring** — `MEGA_ENGINE_RETENTION_JOB_TYPE =
"mega-engine.retention-sweep"`, `registerRetentionSweepHandler()`
(registers the job handler — a thin wrapper calling
`runRetentionSweep()`), and `registerRetentionSweepSchedule()` (the
boot-time registrar: registers the handler, then — guarded by
`hasActiveJobForCorrelation()`, the same boot-time dedupe pattern
`workflow/schedule-triggers.ts` already uses for its own recurring jobs —
schedules one daily cron job at `03:00 UTC` if no prior boot already
did). This is a **singleton** recurring job (there's only ever one
retention sweep, not one per some other entity), so its own job type
string doubles as its `correlationId` for the dedupe check.

**`src/index.ts`** — calls `registerRetentionSweepSchedule()` right
after `startSchedulerWorker()` (must run after the worker is ticking, so
the job it schedules has something to eventually claim it), as a
fire-and-forget call with its own `.catch()` logging — same "best-effort
boot step, don't block the server over it" posture every other
non-critical boot call in that function already has.

**`lib/mega-engine/index.ts`** — barrel now also exports
`RETENTION_WINDOWS_MS`, `runRetentionSweep`, `RetentionSweepResult`,
`MEGA_ENGINE_RETENTION_JOB_TYPE`, `registerRetentionSweepHandler`, and
`registerRetentionSweepSchedule`.

**`routes/admin-mega-engine.ts`** — two new routes, same `requireDev`
tier as E2's existing ones:
- `GET /admin/mega-engine/retention` — returns the configured
  `RETENTION_WINDOWS_MS`, read-only.
- `POST /admin/mega-engine/retention/run` — triggers `runRetentionSweep()`
  out-of-band (an operator who doesn't want to wait for the next 03:00
  UTC tick) and returns its result; logged via `logger.info(...)` with
  `actorId`, same breadcrumb pattern the dead-letter replay/discard
  routes already use.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `eventOutboxTable.publishedAt`, `eventProcessedTable.processedAt`,
  `eventDeadLetterTable.resolvedAt`/`.status`,
  `scheduledJobDeadLetterTable.resolvedAt`/`.status`,
  `scheduledJobAttemptTable.startedAt`, `workflowRunTable.updatedAt`/
  `.status`, and `workflowStepRunTable`/`workflowCheckpointTable`/
  `workflowVariableTable`'s shared `runId` column — all read straight off
  each table's own `pgTable(...)` definition in `lib/db/src/schema/*.ts`,
  not assumed.
- Every `transitionRun(...)` call site in `engine.ts` was read directly
  (not inferred) to confirm only the `COMPLETED` transition sets
  `completedAt` — the reason this file cuts `workflow_run` off by
  `updated_at` instead.
- `registerJobHandler`/`scheduleCron`/`hasActiveJobForCorrelation`'s
  exact signatures were checked against `job-registry.ts`/`job-store.ts`
  directly (not assumed from a sibling call site) before being called
  here the same way `workflow/schedule-triggers.ts` already does.
- No circular import: `mega-engine/retention.ts` imports from
  `../scheduler` (runtime) and `../workflow` (type-only, erased at
  compile time) — neither imports back from `../mega-engine`, confirmed
  by grep, same check E1's own CHANGES doc already ran for
  `engine-health.ts`.
- `"0 3 * * *"` — checked against `cron-parser.ts`'s own supported
  grammar (standard 5-field numeric, no aliases needed here) before
  using it.
- `/api` mount prefix and the two new routes' full paths
  (`/api/admin/mega-engine/retention`,
  `/api/admin/mega-engine/retention/run`) follow the same
  `app.use("/api", ...)` confirmation E2's own CHANGES doc already did;
  no new route-collision risk (`retention` is a distinct path segment
  from the existing `dead-letters/:engine` param route).

## Still open (Part E is now fully covered by spec, but not everything adjacent is)
- `scheduled_job` retention (the job row itself, as opposed to its
  attempt log) — §60 has no entry for it, so this phase deliberately
  leaves it alone; a real decision here (does a completed one-time job's
  row matter for business/audit reasons the way `workflow_run` does, or
  is it closer to `scheduled_job_attempt`'s "operational log" character?)
  needs a product call this phase doesn't make on its own.
- The four fixed windows in `RETENTION_WINDOWS_MS` aren't wired to any
  config surface — §53 has no `RETENTION_*` entry to wire them to yet;
  changing a window today means editing the constant and redeploying.
- No admin **UI** consumes the two new `/retention` routes (same gap E2
  already flagged for its own dead-letter routes — still just an HTTP
  surface, no frontend console screen).
- With §57-E's own list now fully built (health, metrics, admin
  inspection, replay, dead-letter tools, cleanup, retention), what's left
  outstanding is everything already carried forward from E1/E2's own
  "Still open" sections and untouched by E3: admin-UI screens generally,
  workflow run inspection, latency metrics, `traceId` propagation, §40
  Audit Integration, and Workflow → Event Bus reverse-direction
  publishing.
