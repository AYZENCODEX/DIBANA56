# AYZEN Mega Engine — Phase H3: `scheduled_job` Causation + Durable Delayed-Trigger Dedupe (§65 "H: Production hardening")

## Scope
Closes the specific item H1's own "Still open" section named verbatim:
*"`schedule-triggers.ts`'s `scheduledForEvent` guard (the 'delayed'
trigger kind) still has no durable backstop... A real fix needs its own
schema decision (most likely a new `causation_id` column on
`scheduled_job`, mirroring what `workflow_run` already had from
migration 113)."* H2 carried the same item forward untouched. This
phase is that schema decision plus its two call sites.

## What was built

**`migrations/115_ayzen_mega_engine_scheduled_job_causation_phase_h3.sql`**
— adds `scheduled_job.causation_id` (nullable text; NULL for jobs with
no single causing event — recurring/cron schedules, `"schedule"`-trigger
jobs, scheduler-internal wakeups like `workflow.resume`), plus a partial
unique index `scheduled_job_delayed_trigger_causation_idx` on
`(causation_id, payload->>'workflowId')`, scoped to
`job_type = 'workflow.trigger.delayed'`. Deliberately **not**
`UNIQUE(job_type, causation_id)` — H1's `workflow_run` index could use
`(definition_id, causation_id)` because `workflow_run` has a real
`definition_id` column, but `scheduled_job` has no `workflow_id` column;
the target workflow only lives inside `payload.workflowId` (JSONB), and
every delayed-trigger job shares one `job_type`. A plain
`(job_type, causation_id)` index would silently drop the second job when
one anchor event legitimately fans out to two different target
workflows (§23's fan-out). The expression index over
`payload ->> 'workflowId'` is a narrow, explicitly-scoped exception to
this schema directory's usual JSONB-is-app-validated-only posture —
scoped by its own `WHERE job_type = '...'` clause to exactly one job
type, so it constrains nothing about any other job's payload shape.

**`lib/db/src/schema/scheduler.ts`** — Drizzle mirror: `causationId: text("causation_id")`
added to `scheduledJobTable`. The partial index itself is enforced in
raw SQL only (migration 115), not mirrored via the builder's own
`.where()` chain — same "no other table in this directory uses a
partial index yet, don't guess at the builder shape" posture already
used for `workflow_run`'s sibling constraint.

**`lib/scheduler/types.ts`** — `causationId?: string` added to both
`ScheduledJob` (read side) and `ScheduleJobParams` (write side).
`ScheduleCronParams`/`ScheduleRecurringParams` intentionally do **not**
get this field — a recurring/cron schedule isn't "caused by" a single
event the way a one-time delayed job is.

**`lib/scheduler/job-store.ts`** — `scheduleJob()` now writes
`causationId` through to the insert; `rowToJob()` reads it back;
`scheduleDelayed()`'s options bag gained `causationId?: string`.
Deliberately does **not** catch the new unique-violation and resolve it
to "the" existing job's id, unlike `run-store.ts`'s `startRun()` (H1).
That recovery pattern needs the violated constraint's key to be
unambiguous from this function's own generic columns alone — true for
`workflow_run`'s `(definition_id, causation_id)` (both real columns),
not true here: migration 115's constraint is keyed on
`(causation_id, payload->>'workflowId')`, and a `job-store.ts`-level
`(jobType, causationId)` lookup can't tell which of potentially several
same-`(jobType, causationId)` rows (one per fanned-out workflow) is the
one the caller meant, without `job-store.ts` reaching into a payload
shape it has no business knowing (every other job type's payload is
whatever its own handler module defines). The 23505 propagates
unmodified to the caller.

**`lib/workflow/schedule-triggers.ts`** — the caller referenced above.
`registerWorkflowDelayedTriggers()`'s `scheduleDelayed()` call now
supplies `causationId: envelope.id`, and its surrounding `catch` block
recognizes a 23505 (or a `"duplicate key"` message, matching the
`isUniqueViolation` pattern already used in `run-store.ts`,
`event-bus/idempotency.ts`, `event-bus/dead-letter.ts`, and
`scheduler/dead-letter.ts`) as the expected, durable twin of the
in-memory `alreadyScheduled()` guard firing across a restart — logged at
`info` as an intentional skip, not escalated to the pre-existing `error`
log used for genuine scheduling failures. No re-select of the winning
row's id: unlike `startRun()`'s callers, nothing here needs the specific
job id back — only that a job for `(event, workflow)` exists — so the
duplicate-handling this call site needs is exactly "swallow it, log it
as expected, move on," per this file's own updated header.

## Still open (carried forward, untouched by H3)
- **Step-level `WorkflowStepDefinition.timeoutMs`** and **mid-step
  cancellation** — H2's own still-open items, untouched here.
- **The `tx`-supplied caller edge case** (H1's own still-open item) —
  unchanged; neither of this phase's two touched call sites pass a `tx`.
- `traceId` propagation, §40 Audit Integration, admin-UI screens
  generally, `workflow.timed_out`/other `WorkflowRunStatus` values as
  bus events — all still carried forward untouched.
- Production hardening more broadly (graceful shutdown/drain, startup
  config validation, `engine-bootstrap.ts`/`engine-config.ts` from §3's
  package layout) — still doesn't exist in this codebase.
- No admin-facing surface change: an operator still can't see "this
  delayed-trigger job was a deduped redelivery" anywhere except the
  `info`-level log line itself.
