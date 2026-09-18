# AYZEN Mega Engine — Phase H1: Durable Cross-Restart Run Dedupe (§65 "H: Production hardening")

## Scope
§65 ("Recommended Phase Placement") gives Phase H a one-line label,
"Production hardening" — no bullet list the way §57-E has one, the same
gap F1's own header already flagged for Phase F before drawing its scope
from §58's own test list instead. Phase H has no equivalent §-numbered
list to draw from either, so this phase's scope is instead the single
item, across this whole session's carried-forward "Still open" sections,
that names its own concrete fix in advance rather than just describing a
gap: `lib/workflow/triggers.ts`'s header, unchanged since Part D1,
documents its in-memory `startedForEvent` redelivery guard and then
says, word for word, what a durable version would look like — *"a
durable, cross-restart version of this guard is exactly what a
`workflow_run` row keyed on `(definition_id, causation_id)` with a
unique constraint would give for free."* That is squarely a "production
hardening" concern in the ordinary sense of the phrase: the existing
guard is correct for a single, continuously-running process, but silently
stops protecting against duplicate runs the moment that process restarts
mid-redelivery-window or the deployment runs more than one instance —
exactly the two conditions "production," as opposed to a dev sandbox,
actually introduces. `schedule-triggers.ts`'s sibling guard
(`scheduledForEvent`, the "delayed" trigger kind, Part D2) carries the
identical TODO pointed at the same fix, but reduces to a *different*
table (`scheduled_job`) with no equivalent column to key a matching
constraint off — see "Still open" below for why that half is
deliberately not attempted here by analogy.

## What was built

**`migrations/114_ayzen_mega_engine_workflow_run_causation_unique_phase_h1.sql`**
— a single idempotent `CREATE UNIQUE INDEX IF NOT EXISTS` on
`workflow_run (definition_id, causation_id)`, scoped `WHERE causation_id
IS NOT NULL` (a plain, non-partial unique index would also technically
work, since Postgres already treats `NULL <> NULL` for uniqueness — but
the partial form makes the intent explicit and keeps the index from
indexing the many NULL-`causation_id` rows a "manual"/"api"/"schedule"
-triggered run produces for no purpose).

**`lib/db/src/schema/workflow.ts`** — a documentation-only comment on
`workflowRunTable.causationId` pointing at migration 114's constraint.
Deliberately NOT mirrored via the Drizzle builder's own index chain: no
other table in this schema directory uses a partial index (confirmed by
grep), and this phase doesn't want to be the first to guess at the
`drizzle-orm` `.where()` builder's exact shape with no `tsc` available
in this session to check it against. The constraint is enforced by
Postgres regardless of whether Drizzle's own metadata describes it.

**`lib/workflow/run-store.ts`**'s `startRun()` — the insert into
`workflowRunTable` is now wrapped in a `try/catch`. On a `23505`/
"duplicate key" error (same detection pattern `event-bus/idempotency.ts`'s
`markProcessed()` and `event-bus/dead-letter.ts`/`scheduler/dead-letter.ts`
already use), and only when `params.causationId` was actually supplied
(the only condition under which this partial index could ever fire),
`startRun()` looks up the already-existing run by `(definitionId,
causationId)` — via the bare `db` pool, not whatever `tx` the caller may
have supplied, since a failed insert inside a caller's own transaction
already aborted it — and returns that run's `id` instead of throwing.
Any other error, or a unique-violation with no `causationId`, still
throws unmodified. No step-run row is inserted and no `workflow.started`
event is (re-)published on this path — those only happen for the run
that actually won the insert race; the caller that loses the race just
learns which run id already represents "this workflow, caused by this
event."

**`lib/workflow/triggers.ts`** — header comment updated to describe the
new two-layer guarantee: the process-local `startedForEvent` Set is now
documented as a same-process fast path only (saves a DB round-trip for a
same-process redelivery), with the real, cross-restart/cross-instance
guarantee now sitting in `startRun()`/migration 114 underneath it. No
behavioral change to this file itself — `alreadyStarted()` is untouched;
it's `startRun()` one layer down that changed.

**`lib/workflow/schedule-triggers.ts`** — header comment on
`scheduledForEvent` updated to explain, explicitly, why this file's
identical-looking TODO is NOT closed by this same migration: this
guard's target is a `scheduled_job` row (not `workflow_run`), and
`scheduled_job` has no `causation_id` column — only `correlation_id`,
which is already populated here with the ANCHOR EVENT's own
`correlationId` (`scheduleDelayed()`'s own call site,
`{ correlationId: envelope.correlationId }`). Reusing `correlation_id`
as a durable dedupe key by analogy would be actively wrong: several
different anchor events sharing one causal chain would share that same
`correlationId`, so a constraint keyed on it would wrongly treat two
genuinely distinct anchor events as duplicates of each other and drop a
delayed job that should have been scheduled.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- `and`/`eq` — both already real named imports of `run-store.ts` from
  `drizzle-orm` (used elsewhere in this same file, e.g. `listRuns()`),
  so the new `.where(and(eq(...), eq(...)))` call in the catch block
  doesn't need a new import.
- `workflowRunTable.definitionId`/`workflowRunTable.causationId` — both
  real columns of `workflow.ts`'s `workflowRunTable` (`definition_id
  TEXT NOT NULL`, `causation_id TEXT`), matching the two columns
  migration 114's index actually covers.
- `params.causationId` — a real, already-existing optional field of
  `StartWorkflowRunParams` (`lib/workflow/types.ts`), not a new field
  invented for this phase; `startRun()` was already reading it (passed
  straight to the original `values({ ..., causationId: params.causationId,
  ... })` call this phase wraps in `try`) before this change.
- Migration SQL: `CREATE UNIQUE INDEX IF NOT EXISTS ... ON workflow_run
  (definition_id, causation_id) WHERE causation_id IS NOT NULL` is
  standard, valid Postgres partial-index syntax; `IF NOT EXISTS` on
  `CREATE INDEX` (not just `CREATE TABLE`) matches this migration
  directory's own existing idempotency convention (every other
  migration file uses the same pattern for its own indexes).
- No circular import: `run-store.ts` already imported everything this
  change uses (`db`, `and`, `eq`, `workflowRunTable`) before this phase;
  no new import statement was added to the file at all.
- Confirmed by grep across `lib/db/src/schema/`: no existing table in
  this schema directory uses a partial (`.where()`-qualified) Drizzle
  index builder — the decision to leave migration 114's constraint
  SQL-only, documented but not mirrored, matches that directory's
  existing precedent of tolerating SQL-only constraints (e.g.
  `finance_ledger_entries.receipt_token`'s own unique index/column
  split) rather than inventing a first-of-its-kind builder call with no
  way to check it compiles in this session.

## Still open (carried forward, untouched by H1)
- **`schedule-triggers.ts`'s `scheduledForEvent` guard** (the "delayed"
  trigger kind) still has no durable backstop — see "What was built"
  above for why H1's fix doesn't transfer by analogy. A real fix needs
  its own schema decision (most likely a new `causation_id` column on
  `scheduled_job`, mirroring what `workflow_run` already had from
  migration 113) — a future H-phase's call to make deliberately, not
  this one's to guess at (Rule 17).
- **The `tx`-supplied caller edge case**: if a future caller ever passes
  its own transaction handle into `startRun()` and that call races on
  `(definitionId, causationId)`, the failed insert aborts THAT caller's
  transaction (not just `startRun()`'s own recovery path, which
  correctly uses a fresh connection) — the caller's surrounding
  transaction will fail on `COMMIT` and needs to retry the whole
  operation. Neither of this phase's two actual callers
  (`triggers.ts`/`schedule-triggers.ts`) pass a `tx`, so this doesn't
  arise for the scenario H1 was scoped to fix, and it is not a condition
  this phase newly introduces (without the constraint, that same caller
  would previously have silently created a duplicate run instead of
  hitting an aborted transaction) — but it's worth a named caveat for
  whichever future phase adds a `tx`-supplied `startRun()` call site.
- `workflow.timed_out`/other `WorkflowRunStatus` values as bus events,
  `traceId` propagation, §40 Audit Integration, admin-UI screens
  generally, and every other item carried forward untouched through
  E1–E3/F1/F2/G1/G2's own "Still open" sections — none of those are
  touched by this phase either; H1 is scoped to exactly the one item
  described above.
- Production hardening more broadly (§65's label covers more than just
  this one dedupe guard — e.g. graceful shutdown/drain, engine-wide
  startup config validation, `engine-bootstrap.ts`/`engine-config.ts`
  from §3's package layout, neither of which exist yet in this codebase)
  is NOT fully closed out by H1 alone, the same way E1 alone didn't
  close out all of §57-E — this is one slice of Phase H, not the whole
  phase.
