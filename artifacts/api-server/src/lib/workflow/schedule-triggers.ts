/**
 * lib/workflow/schedule-triggers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part D2: Workflow ↔ Scheduler
 * (§23 "Schedule" + "Delayed" trigger kinds — the second item of Part
 * D's integration list, §57-D, right after D1's Event Bus ↔ Workflow).
 *
 * triggers.ts's own header called these two out as "Part B's scheduler
 * concern (a cron/delayed job whose handler starts a run — not yet
 * registered as of D1, tracked separately)". This file is that tracked-
 * separately piece. Same boot-time-snapshot posture as D1's
 * registerWorkflowEventTriggers(): a workflow_definition row changing
 * doesn't push a live update into either the scheduler's job table or
 * the event bus's in-memory subscription registry, so both registrars
 * below are meant to be called once at boot (or again, deliberately,
 * after a new/changed definition is published) — see triggers.ts's own
 * header for the full "why boot-time, not reactive" reasoning, which
 * applies here unchanged.
 *
 * ── Schedule trigger (§23 "every 30 minutes") ─────────────────────────────
 * Reduces directly to scheduler/job-store.ts's own scheduleCron(): one
 * recurring job per schedule-triggered definition, whose handler is a
 * *fixed* dispatcher (WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE) that starts a
 * fresh run of whichever `workflowId` is in the job's own payload — the
 * same "one handler, N payload-carried targets" shape triggers.ts uses
 * for "one event-bus consumer, N fanned-out workflows", just inverted
 * (there it's one dispatch fanning out to many; here each recurring job
 * IS already scoped to exactly one workflow, so no fan-out loop is
 * needed — a cron job's `correlationId` carries the workflowId 1:1).
 *
 * Re-registering on every boot needs an explicit dedupe guard that D1's
 * event-trigger registrar didn't: subscribe() is naturally idempotent
 * per (eventType, consumer) (see subscriptions.ts), but scheduleCron()
 * is NOT idempotent — it inserts a brand-new row every call. Without
 * scheduler/job-store.ts's hasActiveJobForCorrelation() guard below, a
 * process restarted daily would accumulate a new duplicate recurring
 * job every single day for the same workflow.
 *
 * ── Delayed trigger (§23 "run 24 hours after event") ──────────────────────
 * Genuinely a composite of D1 + this file's own schedule half: it LISTENS
 * for `relativeToEventType` on the Event Bus (same subscribe()-per-
 * eventType, fan-out-to-N-workflows shape as triggers.ts) and, on each
 * matching event, schedules a ONE-TIME job `afterMs` out (scheduler/
 * job-store.ts's scheduleDelayed()) rather than starting the run
 * immediately — the run itself only actually starts later, when that
 * delayed job comes due, via the exact same WORKFLOW_DELAYED_TRIGGER_JOB_TYPE
 * handler pattern the schedule half uses. The triggering event's
 * userId/organizationId/correlationId ride along in the job's payload so
 * the eventually-started run's WorkflowContext still reflects who/what
 * caused it (§19), same fields triggers.ts already copies for the
 * immediate "event" trigger kind.
 *
 * A `{ kind: "delayed" }` trigger with no `relativeToEventType` has no
 * anchor to measure `afterMs` from — §23's own example ("24 hours AFTER
 * EVENT") presumes one. Rather than guessing an anchor (boot time? first
 * observation?), this registrar logs and skips those definitions, the
 * same fail-closed-and-say-so posture scheduler-handler.ts's own header
 * documents for a WorkflowRuntimeEnv that can't authorize anything yet.
 */
import type { EventEnvelope } from "../event-bus";
import { subscribe } from "../event-bus";
import { logger } from "../logger";
import {
  hasActiveJobForCorrelation, registerJobHandler, scheduleCron, scheduleDelayed,
  type ScheduledJob,
} from "../scheduler";
import { listActiveDelayedTriggeredDefinitions, listActiveScheduleTriggeredDefinitions } from "./definition-store";
import { executeRun } from "./engine";
import type { WorkflowRuntimeEnv } from "./engine";
import { startRun } from "./run-store";
import type { WorkflowContext } from "./types";

export const WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE = "workflow.trigger.schedule";
export const WORKFLOW_DELAYED_TRIGGER_JOB_TYPE = "workflow.trigger.delayed";

/** Payload shape both job types share — a schedule-trigger job carries no context of its own (it wasn't caused by anything but the clock), a delayed-trigger job carries whatever the anchor event contributed. */
export interface WorkflowTriggerJobPayload {
  workflowId: string;
  context?: WorkflowContext;
  causationId?: string;
}

/**
 * §26-adjacent guard, same shape as triggers.ts's own `startedForEvent`
 * set (see that file's header for the full reasoning) — keyed on
 * (eventId, workflowId) so a redelivered anchor event doesn't schedule a
 * second delayed job for the same (event, workflow) pair within THIS
 * process's lifetime. Process-local only — the durable, cross-restart
 * backstop is Part H3 (migration 115)'s
 * scheduled_job_delayed_trigger_causation_idx, a partial UNIQUE index on
 * `scheduled_job (causation_id, payload->>'workflowId')` scoped to
 * job_type = 'workflow.trigger.delayed'. That migration's own header
 * explains why the key is (causation_id, payload->>'workflowId') and not
 * (job_type, causation_id) alone (one anchor event can legitimately fan
 * out to several different target workflows sharing this job_type), and
 * why job-store.ts's scheduleJob()/scheduleDelayed() deliberately do NOT
 * catch that violation themselves the way run-store.ts's startRun() (H1)
 * catches workflow_run's sibling constraint: job-store.ts's own columns
 * can't disambiguate which of several same-(jobType, causationId) rows a
 * generic `(jobType, causationId)` lookup would even mean, without
 * reaching into a payload shape that isn't job-store.ts's to know. This
 * file IS the place that knows: it supplies both halves of the key
 * itself (`causationId: envelope.id`, `payload.workflowId`), so the
 * catch block in the loop below is where the 23505 from that index gets
 * recognized and treated as the benign "already scheduled" outcome it
 * actually is, rather than a real scheduling failure. Nothing here reads
 * the winning row's id back — neither this file nor
 * registerWorkflowTriggerJobHandlers()'s dispatch handler above needs
 * the specific job id, only that a job for (event, workflow) exists —
 * so there is no run-store.ts-style re-select; the duplicate-handling
 * this function needs is entirely "swallow it, log it as expected,
 * move on".
 */
const scheduledForEvent = new Set<string>();

function alreadyScheduled(eventId: string, workflowId: string): boolean {
  const key = `${eventId}:${workflowId}`;
  if (scheduledForEvent.has(key)) return true;
  scheduledForEvent.add(key);
  return false;
}

/**
 * Registers the ONE handler both the schedule and the delayed trigger's
 * jobs dispatch to at due-time — starting a fresh run of `payload.workflowId`
 * (carrying `payload.context`/`payload.causationId` through, when
 * present). Split out as its own function (rather than folded into the
 * two registrar functions below) so it can be called exactly once
 * regardless of whether the deployment uses schedule triggers, delayed
 * triggers, or both — registerJobHandler() itself is safe to call twice
 * (a later call just overwrites, same posture scheduler-handler.ts's
 * registerWorkflowResumeHandler() already documents), but there is no
 * reason to invite that when a caller enables both.
 */
export function registerWorkflowTriggerJobHandlers(env: WorkflowRuntimeEnv = {}): void {
  const handler = async (job: ScheduledJob<WorkflowTriggerJobPayload>): Promise<void> => {
    const workflowId = job.payload?.workflowId;
    if (!workflowId) throw new Error(`workflow trigger job ${job.id} has no workflowId in its payload`);

    const { id: runId } = await startRun({
      definitionId: workflowId,
      context: job.payload?.context,
      correlationId: job.payload?.context?.correlationId,
      causationId: job.payload?.causationId,
    });
    await executeRun(runId, env);
  };

  registerJobHandler<WorkflowTriggerJobPayload>(WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE, handler, {
    defaultMaxAttempts: 3,
    owner: "workflow",
    description: '§23 Schedule trigger — starts a fresh run of the recurring job\'s target workflow.',
  });
  registerJobHandler<WorkflowTriggerJobPayload>(WORKFLOW_DELAYED_TRIGGER_JOB_TYPE, handler, {
    defaultMaxAttempts: 3,
    owner: "workflow",
    description: '§23 Delayed trigger — starts a fresh run of the target workflow once its anchor event\'s afterMs delay has elapsed.',
  });
}

/**
 * Call once at boot (after registerWorkflowTriggerJobHandlers() and
 * after the app's real WorkflowRuntimeEnv is assembled — same ordering
 * D1's registerWorkflowEventTriggers() needs, see its own header). Loads
 * every ACTIVE `{ kind: "schedule" }` definition and makes sure exactly
 * one recurring cron job exists for it, skipping ones a previous boot
 * already created (hasActiveJobForCorrelation() — see this file's own
 * header for why that guard is necessary here but wasn't for D1).
 */
export async function registerWorkflowScheduleTriggers(env: WorkflowRuntimeEnv = {}): Promise<void> {
  registerWorkflowTriggerJobHandlers(env);

  const definitions = await listActiveScheduleTriggeredDefinitions();
  let created = 0;

  for (const def of definitions) {
    if (def.trigger.kind !== "schedule") continue; // listActiveScheduleTriggeredDefinitions() already filters to this, keeps the type narrowed below without a cast
    if (await hasActiveJobForCorrelation(WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE, def.id)) continue;

    await scheduleCron<WorkflowTriggerJobPayload>({
      jobType: WORKFLOW_SCHEDULE_TRIGGER_JOB_TYPE,
      cron: def.trigger.cron,
      timezone: def.trigger.timezone,
      payload: { workflowId: def.id },
      correlationId: def.id,
    });
    created += 1;
  }

  logger.info({ definitions: definitions.length, created }, "Workflow schedule triggers registered");
}

/**
 * Call once at boot, same ordering as registerWorkflowScheduleTriggers()
 * (and safe to call alongside it — registerWorkflowTriggerJobHandlers()
 * inside each is idempotent). Loads every ACTIVE `{ kind: "delayed" }`
 * definition; ones with a `relativeToEventType` get exactly one
 * event-bus consumer per distinct eventType (same one-consumer-fans-out-
 * to-N-workflows shape as triggers.ts's event registrar); ones without
 * are logged and skipped (see this file's header for why).
 */
export async function registerWorkflowDelayedTriggers(env: WorkflowRuntimeEnv = {}): Promise<void> {
  registerWorkflowTriggerJobHandlers(env);

  const definitions = await listActiveDelayedTriggeredDefinitions();

  const workflowIdsByEventType = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const def of definitions) {
    if (def.trigger.kind !== "delayed") continue; // listActiveDelayedTriggeredDefinitions() already filters to this, keeps the type narrowed below without a cast
    if (!def.trigger.relativeToEventType) {
      skipped.push(def.id);
      continue;
    }
    const list = workflowIdsByEventType.get(def.trigger.relativeToEventType) ?? [];
    list.push(def.id);
    workflowIdsByEventType.set(def.trigger.relativeToEventType, list);
  }

  if (skipped.length) {
    logger.warn({ workflowIds: skipped }, 'Workflow "delayed" trigger has no relativeToEventType — skipping (no anchor to measure afterMs from)');
  }

  for (const [eventType, workflowIds] of workflowIdsByEventType) {
    subscribe(eventType, `workflow-delayed-trigger:${eventType}`, async (envelope: EventEnvelope) => {
      for (const workflowId of workflowIds) {
        if (alreadyScheduled(envelope.id, workflowId)) continue;

        const def = definitions.find((d) => d.id === workflowId);
        if (!def || def.trigger.kind !== "delayed") continue; // can't happen given how workflowIdsByEventType was built, but keeps this block self-contained/typed without a cast

        try {
          await scheduleDelayed<WorkflowTriggerJobPayload>(
            WORKFLOW_DELAYED_TRIGGER_JOB_TYPE,
            def.trigger.afterMs,
            {
              workflowId,
              // §19 — same safe/narrow field set triggers.ts's immediate
              // "event" trigger copies from the envelope; `input` carries
              // the anchor event's payload through to whatever step of
              // the eventually-started run reads it.
              context: {
                userId: envelope.actor?.userId,
                organizationId: envelope.actor?.organizationId,
                correlationId: envelope.correlationId,
                input: (envelope.payload && typeof envelope.payload === "object" ? envelope.payload : { value: envelope.payload }) as Record<string, unknown>,
              },
              causationId: envelope.id,
            },
            { correlationId: envelope.correlationId },
          );
        } catch (err) {
          // Part H3 — recognize migration 115's partial unique index
          // (causation_id, payload->>'workflowId') firing on exactly
          // this (event, workflow) pair as the durable, cross-restart
          // twin of the in-memory `alreadyScheduled()` guard above, not
          // a real failure. This is the ONE call site that supplied
          // both halves of that index's key (causationId: envelope.id,
          // payload.workflowId: workflowId) — see this file's own
          // header for why job-store.ts leaves this recovery to its
          // callers instead of doing it generically. Anything else
          // (any other error code/message) falls through to the
          // pre-existing §14 failure-isolation logging unchanged.
          const isDuplicateDelayedTrigger =
            (err as { code?: string })?.code === "23505" ||
            /duplicate key/i.test(String((err as { message?: string })?.message ?? ""));
          if (isDuplicateDelayedTrigger) {
            logger.info(
              { eventType, eventId: envelope.id, workflowId },
              "Delayed-trigger job already scheduled for this (event, workflow) pair — skipping duplicate (Part H3 durable guard)",
            );
            continue;
          }

          // §14 — same "one workflow's problem must not become the
          // EVENT's problem" posture triggers.ts's own catch block
          // documents; here the "start" being attempted is really just
          // "schedule a job", but the failure-isolation reasoning is
          // identical.
          logger.error({ err, eventType, eventId: envelope.id, workflowId }, "Failed to schedule delayed-trigger job for workflow run");
        }
      }
    });
  }

  logger.info({ eventTypes: Array.from(workflowIdsByEventType.keys()), skipped: skipped.length }, "Workflow delayed triggers registered");
}
