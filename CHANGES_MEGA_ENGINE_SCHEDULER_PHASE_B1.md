# AYZEN Mega Engine — Phase 8 Blueprint, Part B1: Scheduler Core

Implements the first half of `AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md`
§57's **Part B — Scheduler**, split in two the same way this repo already
splits large phases (`CHANGES_ROUTE_INTEGRATION_PHASE_C1..C35`,
`..._D1..D8`, `..._E1..E6`):

- **B1 (this change)** — Job model, Job store, Claim/lease, Worker,
  one-time + delayed jobs (§28, §29's One-time/Delayed, §30, §33, §34).
- **B2 (not in this change)** — Recurring jobs, cron parsing, timezone
  handling, misfire policy (§29's Recurring/Cron, §31, §32).

B1 is a fully working scheduler for "run this once, at this time" and
"run this once, N minutes from now" — exactly §51's example workflow
("30-Minute Reminder") only needs a delayed job, not a recurring one.
Recurring/cron jobs are deliberately not implemented yet, not silently
half-implemented: `scheduleJob()`'s TypeScript API only accepts a fixed
`runAt`, even though the underlying table already has `cron`/`timezone`
columns (see the migration's comment on why) — no route or caller can
accidentally schedule a "sort of recurring" job that misfire handling
isn't built to cope with.

## Where it lives

Same shape as `lib/event-bus/` (see `CHANGES_MEGA_ENGINE_EVENT_BUS_PHASE_A.md`):

```
artifacts/api-server/src/lib/scheduler/
  types.ts          ScheduledJob, JobStatus, JobHandler, ScheduleJobParams
  job-registry.ts   registerJobHandler / getJobHandlerDefinition — §34
  job-store.ts       scheduleJob / scheduleDelayed / getJob / cancelJob — §28/§29
  worker.ts           claim/lease/execute loop — §30/§33, cron-scheduled every 5s
  retry.ts             bounded exponential backoff (per-job maxAttempts)
  dead-letter.ts         moveToDeadLetter / replayDeadLetter / discardDeadLetter
  index.ts                barrel export
```

New DB objects (`migrations/111_ayzen_mega_engine_scheduler_phase_b1.sql`,
mirrored in `lib/db/src/schema/scheduler.ts`), matching §37's "Scheduler
tables" list exactly: `scheduled_job`, `scheduled_job_attempt` (one row
per execution attempt — the audit trail; `scheduled_job.attempts` stays
the fast counter the claim/backoff path checks), `scheduled_job_dead_letter`.
Same manual, idempotent, run-once-in-Supabase convention as every other
new-table migration in this directory — not added to
`lib/schema-migrations.ts`'s auto-run array.

## How it works

**Schedule** — `scheduleJob({ jobType, runAt, payload, correlationId, maxAttempts }, tx)`
takes the same optional transaction handle `event-bus/publisher.ts`'s
`publishEvent()` does, for the same reason: a job is very often scheduled
as a direct consequence of a business write or an event handler
(§35's own example — an invite triggers a 30-minute reminder job) and
should land in the same commit. `scheduleDelayed(jobType, delayMs, payload)`
is the "N minutes from now" convenience wrapper.

**Claim/execute** — `startSchedulerWorker()` (wired into `index.ts`'s boot
sequence, right after `startEventBusDispatcher()`) runs a `node-cron` tick
every 5s. Each tick: `FOR UPDATE SKIP LOCKED`-claims due
`SCHEDULED`/`RETRYING` rows (same idiom as the Event Bus dispatcher and
`mail-send-queue.ts`), sets an absolute lease expiry (`locked_until`, §30),
runs the registered handler, then — in one transaction — records an
attempt-history row, advances the job to `COMPLETED`/`RETRYING`/`DEAD_LETTER`,
and publishes a matching event (see below).

**Lease expiry, not a fixed stuck-timeout** — unlike `event_outbox`'s
"locked past N seconds" stale-lock sweep, `scheduled_job.locked_until` is
an absolute instant set at claim time (§30's actual lease model). A row
still `RUNNING` past that instant is a worker that died mid-execution;
recovering it **does** count as a failed attempt (bumps `attempts`,
subject to the same backoff/dead-letter path a thrown error would take) —
deliberately different from the Event Bus's stale-lock sweep, which does
not bump `attempt_count`. The reasoning (also in `worker.ts`'s header): a
scheduler lease is long (5 min, covering genuine crash/restart gaps)
specifically so that "silently retry forever without counting it" can't
wedge a permanently-broken job type out of ever reaching dead letter.

**Unknown job types** (§34: "must fail safely and become observable") —
`scheduleJob()` only warns if `jobType` has no registered handler yet
(module import order isn't guaranteed at boot, so this can't be a hard
reject the way an unregistered *event* type is at publish time); the
actual controlled failure happens in the worker, once the job comes due —
straight to dead letter, same as the Event Bus's unregistered-type path.

## §35 integration: Scheduler ↔ Event Bus

Every job's outcome also publishes an event — `scheduler.job.completed`,
`scheduler.job.failed` (`willRetry: true`), or `scheduler.job.deadlettered`
— self-registered in `worker.ts` via Phase A's `registerEvent()`/`publishEvent()`,
in the **same transaction** as the job's own status update (so "job says
COMPLETED" and "the completion event exists" can never disagree — the
exact guarantee §7/§8's transactional outbox exists to provide, now
composed across two engines instead of one). This is the concrete shape
of §35's diagram (`Event Bus -> schedule delayed action -> Scheduler ->
execute at due time -> Worker -> Domain Service -> Event Bus`) for the
"job finished" half; nothing yet *schedules* a job in reaction to an
event (that's a specific domain module's Part D/E wiring, e.g. reacting
to `organization.member.invited` the way §35's own reminder example
does — not part of B1's inert-infrastructure scope, same posture Phase A
took for its own default-registered event types).

## What a domain module does to use this (nothing else in this change calls it yet)

```ts
import { registerJobHandler, scheduleDelayed } from "../scheduler";

registerJobHandler("notification.reminder", async (job) => {
  // job.payload is typed T if you passed a generic to registerJobHandler<T>(...)
}, { defaultMaxAttempts: 5, owner: "notifications" });

// Inside an existing db.transaction(async (tx) => { ...business writes... }):
await scheduleDelayed("notification.reminder", 30 * 60_000, { userId, orgId }, { correlationId: inviteEventId }, tx);
```

No existing route or service schedules a job in this change — per §2's
"do not rewrite working route handlers" and §65's phase placement, B1
lands as new, inert-until-called infrastructure, same posture Phase A
took.

## Definition of Done — Scheduler (§63), B1's scope only

- [x] delayed jobs
- [x] one-time jobs (recurring/cron — B2)
- [x] worker leasing
- [x] retry
- [x] cancellation (`cancelJob` — only for jobs not yet claimed)
- [x] persistent state
- [ ] recurring jobs, cron, misfire handling — B2, not in this change.
- [ ] Workflow, cross-engine integration beyond §35's completion events, domain integrations, operations tooling — later phases (§57 C–E).
