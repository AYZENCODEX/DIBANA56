# AYZEN Mega Engine — Phase F1: Workflow Run Reliability (§65 "F: Reliability/security" — run inspection, cancel, replay)

## Scope — and a naming correction
The blueprint actually defines TWO different lettered phase lists, and
this session's earlier CHANGES docs (E1/E2/E3) followed the wrong one.
§57 ("V1 Implementation Order") uses A–E, with E = "Operations"
(health/metrics/admin inspection/replay/dead-letter tools/cleanup/
retention) — that's the list E1–E3 actually built, start to finish, and
those three phases are correctly scoped against it. §65 ("Recommended
Phase Placement") uses a DIFFERENT, longer list for the same Mega Engine
work: A Event Bus foundation, B Scheduler foundation, C Workflow
foundation, D Cross-engine integration, **E Domain integrations**, **F
Reliability/security**, G Observability/admin, H Production hardening.
Under §65's own list, what E1–E3 actually built is closer to §65's `G:
Observability/admin` than its `E`. "Phase F" — this phase — is §65's `F:
Reliability/security`, confirmed by finding that exact line in §65 after
the ambiguity earlier in this conversation.

§65 gives Phase F a one-line label, not a bullet list the way §57-E has
one. The concrete slice this phase (F1) builds comes from cross-
referencing §58's own Workflow/Security test requirements — which DO
give a specific list — against what's actually implemented:

```
§58 Workflow tests:  ... retry, timeout, waiting, resume, cancellation,
                      compensation, idempotency, restart recovery
§58 Security tests:  PEP denial, stale authorization, cross-organization
                      access, privilege changes during waiting, event
                      replay, workflow replay, admin-only operations
```

`event replay` (Part A) and dead-letter replay generally (Parts A/B1,
exposed in E2) already exist. **`workflow replay` and `cancellation`
did not** — `run-store.ts` has had a `cancelRun()` function since Part
C1, but nothing ever called it outside the engine's own internals, and
there was no run-level replay of any kind, nor any way to even list
`workflow_run` rows (E2's own "Still open" list flagged this gap
directly: *"Workflow run inspection ... isn't part of this phase."*).
F1 closes both: listing/inspecting runs (the prerequisite for either
cancel or replay to be usable by anyone who isn't already staring at the
database), cancelling one that's still in flight, and replaying one that
finished badly.

## What was built

**`lib/workflow/run-store.ts`** — new `listRuns(filter?, limit = 50)`:
optional `status`/`definitionId`/`correlationId` filters, newest-first
(`ORDER BY created_at DESC`), capped by `limit`. Every prior caller of
this file already knew the one `id` it wanted (a job handler resuming a
specific run); an admin console browsing "what's stuck" needs to
filter/page instead — this is the read-side `getRun()` never needed
until an operator, not code, is the caller.

**New file `lib/workflow/replay.ts`** — `replayRun(runId, env?)`:
- Only replays a run in one of the four *unsuccessful* terminal statuses
  — `FAILED`/`TIMED_OUT`/`CANCELLED`/`DEAD_LETTER`. `COMPLETED`/
  `COMPENSATED` are refused (`RunNotReplayableError`) — replaying a run
  that already succeeded isn't recovery, it's re-running a business
  process that already had its real-world effect once, risking exactly
  the double-effect problem §54's Concurrency Controls list exists to
  prevent. Non-terminal statuses are refused the same way — nothing
  about "still in progress" should ever reach for a replay tool.
- Unlike event-bus/scheduler dead-letter replay (re-insert one row into
  a queue), a workflow run is a whole multi-step process — so this
  reduces to `startRun()` (same `definitionId`+`definitionVersion` the
  original run used, not necessarily whatever's currently ACTIVE; same
  `context`/`correlationId` carried forward; `causationId` pointing at
  the original run, matching the "new record caused by the original"
  convention both dead-letter `replayDeadLetter()`s already use) followed
  by `executeRun()` — exactly what `workflow/schedule-triggers.ts`'s own
  trigger-job handler already does to start any fresh run, reused here
  rather than reimplemented.
- Runs `executeRun()` inline (`await`ed, not fire-and-forget) — same
  choice `schedule-triggers.ts` already makes; `executeRun()` returns as
  soon as the run finishes OR parks into `WAITING`, so this doesn't block
  on however long the whole process eventually takes, only on however
  far it gets on its first pass.

**`lib/workflow/index.ts`** — barrel now also exports `listRuns`,
`replayRun`, `RunNotFoundError`, `RunNotReplayableError`.

**`routes/admin-mega-engine.ts`** — four new routes, same `requireDev`
tier as every other route in this file:
- `GET /admin/mega-engine/workflow/runs` — list/filter
  (`?status=`/`?definitionId=`/`?correlationId=`/`?limit=`, capped at
  200, default 50).
- `GET /admin/mega-engine/workflow/runs/:id` — one run + its full step
  history (`getStepRuns()`), `404` if the run doesn't exist.
- `POST /admin/mega-engine/workflow/runs/:id/cancel` — thin wrapper over
  the existing `cancelRun()`. Its own cancellable-status guard
  (`PENDING`/`RUNNING`/`WAITING` only) makes an already-terminal or
  missing run a silent no-op (`cancelled: false`), not an error — same
  "only mutate it if it's still safe to" posture the E2 dead-letter
  discard routes already rely on.
- `POST /admin/mega-engine/workflow/runs/:id/replay` — calls
  `replayRun()`; `RunNotFoundError` → 404, `RunNotReplayableError` (or
  anything else `startRun()` can throw, e.g. a deleted definition) →
  400 with the thrown message, same "surface it, don't guess" posture
  the E2 dead-letter replay route already uses.

All four (and every existing route in this file) get an audit-breadcrumb
`logger.info(...)` call with `actorId: req.user?.userId` on any state
change (`cancel`/`replay`), same pattern the E2 dead-letter routes
already established.

## Verified by hand (no `tsc` — same constraint every phase in this
session has had; `node_modules` isn't installed)
- Read every `transitionRun(...)` call site in `engine.ts` (again, same
  check E3 already ran for a different reason) to confirm
  `FAILED`/`TIMED_OUT`/`CANCELLED`/`DEAD_LETTER` really are all reachable
  terminal outcomes distinct from `COMPLETED`/`COMPENSATED` — the basis
  for `replay.ts`'s `REPLAYABLE_STATUSES` list.
- `state-machine.ts`'s `RUN_TRANSITIONS` confirms all four replayable
  statuses, and both excluded successful ones, are genuinely terminal
  (`.length === 0` — no outgoing transitions), so nothing about a
  replayable run could still be "in progress" underneath the status
  check.
- `StartWorkflowRunParams`'s exact shape
  (`definitionId`/`definitionVersion?`/`context?`/`correlationId?`/
  `causationId?`) was checked against `types.ts` directly before
  `replayRun()`'s call to `startRun()` was written to match it field for
  field.
- `workflowRunTable`'s columns (`status`, `definitionId`,
  `correlationId`, `createdAt`) — checked against `schema/workflow.ts`
  directly for `listRuns()`'s filter/order clauses.
- No circular import: `workflow/replay.ts` imports only from
  `./run-store` and `./engine`, both already-established internal
  dependencies of the same barrel; nothing new added to the module
  graph.
- `/api` mount prefix and all four new routes' full paths — same
  `app.use("/api", ...)` check E2/E3's own CHANGES docs already ran;
  `/workflow/runs` (no trailing segment) and `/workflow/runs/:id` (one
  trailing segment) don't collide in Express's route matching.

## Still open (Phase F's remaining scope — and everything else)
- This is F1, not all of Phase F — §65 gives "Reliability/security" no
  bullet list the way §57-E has one, so there's no single spec to check
  this phase complete against the way E1–E3 could be checked against
  §57-E's seven items. Candidates for a further F-phase, drawn from
  §58's own Security test list and not touched here: **stale
  authorization** / **privilege changes during waiting** (does a
  `WAITING` run re-check authorization on resume, or only at each new
  step dispatch — `engine.ts`'s existing `authorizeWorkflowAction()`
  call site would need to be read closely to answer this with
  certainty, not assumed); **cross-organization access** (none of this
  phase's new admin routes have any organization-scoping concept — by
  design, since `requireDev` is a global-admin gate with no per-org
  boundary, but that assumption is worth stating explicitly rather than
  leaving implicit); **PEP denial** test coverage generally.
- No admin UI for any of this (same gap every phase since E2 has
  flagged for its own new routes).
- `scheduled_job` retention, config-wired retention windows, §40 Audit
  Integration, latency metrics, `traceId` propagation, and Workflow →
  Event Bus reverse publishing — all still open, carried forward
  unchanged from E1/E2/E3's own lists.
