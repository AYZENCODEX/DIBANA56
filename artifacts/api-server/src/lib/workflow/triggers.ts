/**
 * lib/workflow/triggers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part D1: Event Bus ↔ Workflow
 * (§23 "Event trigger" — the first of Part D's integration list, §57-D).
 *
 * The other four §23 trigger kinds are already wired by earlier parts:
 * "api" is just a route calling startRun()+executeRun() directly (Part
 * D's job elsewhere, not this file), "schedule"/"delayed" are Part B's
 * scheduler concern (a cron/delayed job whose handler starts a run —
 * not yet registered as of D1, tracked separately), and "manual" is
 * whatever admin/user action a future route performs. This file is
 * specifically the "event" kind: a workflow_definition whose trigger is
 * `{ kind: "event", eventType }` should start a new run every time that
 * eventType is published on the Event Bus.
 *
 * ── Why this is boot-time registration, not live/reactive ─────────────────
 * event-bus/subscriptions.ts's subscribe() is an in-memory, code-shaped
 * registry (see that file's own header) — there is no mechanism for a
 * DB row changing (a new workflow_definition published, one deprecated)
 * to push a live update into it. registerWorkflowEventTriggers() below
 * is therefore a snapshot, read once at boot, same posture
 * scheduler-handler.ts's registerWorkflowResumeHandler() already
 * documents for itself: publishing a NEW event-triggered definition, or
 * changing an existing one's eventType, needs the app restarted (or this
 * function called again) to take effect. Good enough for V1 — §56
 * explicitly rules out a "live visual workflow editor" for the same
 * reason: definitions are expected to change by deploy/admin-action, not
 * by the second.
 *
 * ── One event-bus consumer per distinct eventType, fanning out to N workflows ──
 * event-bus/subscriptions.ts allows several (eventType, consumer) pairs
 * per eventType already (§1's own diagram: Workflow/Notify/Audit all
 * hang off the same bus) — but two DIFFERENT workflow definitions
 * sharing the same trigger eventType would otherwise need two
 * *different* consumer names on the *same* eventType (subscribe()'s
 * dedupe key is (eventType, consumer), not eventType alone). Rather than
 * minting one consumer name per workflow, this file registers exactly
 * ONE consumer per eventType ("workflow-trigger:<eventType>") whose
 * handler fans out to every event-triggered workflow_id that shares it.
 * This keeps the idempotency ledger (event-bus/idempotency.ts's
 * hasProcessed()/markProcessed(), keyed on (event id, consumer)) at one
 * row per (event, eventType) rather than one per (event, workflow) —
 * a workflow's OWN redelivery-safety is instead §26's job (every run this
 * handler starts gets fresh idempotency keys per step, same as any other
 * run) plus the guard below against starting the same run twice for one
 * event id.
 */
import type { EventEnvelope } from "../event-bus";
import { subscribe } from "../event-bus";
import { logger } from "../logger";
import { listActiveEventTriggeredDefinitions } from "./definition-store";
import { executeRun } from "./engine";
import type { WorkflowRuntimeEnv } from "./engine";
import { startRun } from "./run-store";

/**
 * §26-adjacent guard, specific to this file: the Event Bus is
 * at-least-once (§9) — the SAME envelope id can reach this consumer's
 * handler more than once. Workflow runs have no "start idempotency key"
 * of their own (run-store.ts's startRun() always mints a fresh run id),
 * so without this a redelivered event would start a second, duplicate
 * run for the same business event. Keyed on (eventId, workflowId) rather
 * than eventId alone, since one event can legitimately fan out to
 * several DIFFERENT workflows. Process-local and unbounded-but-small in
 * practice (event-bus redelivery windows are short — see
 * event-bus/retry.ts's own backoff ceiling) — this Set is now only a
 * same-process fast path, not the sole guard: Part H1 (migration 114)
 * added exactly the durable, cross-restart version this comment used to
 * ask for — a UNIQUE(definition_id, causation_id) partial index on
 * `workflow_run` — and run-store.ts's startRun() now catches that
 * constraint's violation and returns the already-existing run instead
 * of throwing. So a restart that clears this Set mid-redelivery-window,
 * or two process instances racing on the same redelivered envelope, can
 * no longer create a duplicate run; this Set only saves the extra DB
 * round-trip for a same-process redelivery.
 */
const startedForEvent = new Set<string>();

function alreadyStarted(eventId: string, workflowId: string): boolean {
  const key = `${eventId}:${workflowId}`;
  if (startedForEvent.has(key)) return true;
  startedForEvent.add(key);
  return false;
}

/**
 * Call once at boot (after the app's real WorkflowRuntimeEnv — policy
 * engine + subject resolver — is assembled, same ordering
 * scheduler-handler.ts's registerWorkflowResumeHandler() already needs;
 * pass `{}` if this deployment runs no event-triggered workflow whose
 * actions call `ctx.authorize()`). Loads every ACTIVE event-triggered
 * definition and subscribes exactly one event-bus consumer per distinct
 * eventType — see this file's header for why one, not one-per-workflow.
 */
export async function registerWorkflowEventTriggers(env: WorkflowRuntimeEnv = {}): Promise<void> {
  const definitions = await listActiveEventTriggeredDefinitions();

  const workflowIdsByEventType = new Map<string, string[]>();
  for (const def of definitions) {
    if (def.trigger.kind !== "event") continue; // listActiveEventTriggeredDefinitions() already filters to this, but keeps the type narrowed below without a cast
    const list = workflowIdsByEventType.get(def.trigger.eventType) ?? [];
    list.push(def.id);
    workflowIdsByEventType.set(def.trigger.eventType, list);
  }

  for (const [eventType, workflowIds] of workflowIdsByEventType) {
    subscribe(eventType, `workflow-trigger:${eventType}`, async (envelope: EventEnvelope) => {
      for (const workflowId of workflowIds) {
        if (alreadyStarted(envelope.id, workflowId)) continue;

        try {
          // §19 — only the safe, narrow context fields; the event's
          // payload becomes the run's `input`, exactly the shape
          // WorkflowContext.input already documents itself as (caller-
          // supplied, untrusted-until-validated by whatever step reads
          // it — same posture as an API-triggered run's body).
          const { id: runId } = await startRun({
            definitionId: workflowId,
            context: {
              userId: envelope.actor?.userId,
              organizationId: envelope.actor?.organizationId,
              correlationId: envelope.correlationId,
              input: (envelope.payload && typeof envelope.payload === "object" ? envelope.payload : { value: envelope.payload }) as Record<string, unknown>,
            },
            correlationId: envelope.correlationId,
            traceId: envelope.traceId,
            // §26/§39 — this run's own causationId points back at the
            // event that started it, the same traceability §39 asks
            // every workflow/job/event to carry.
            causationId: envelope.id,
          });
          await executeRun(runId, env);
        } catch (err) {
          // §14 — an event is a fact, not a guaranteed-successful
          // trigger. One workflow failing to even START must not stop
          // its siblings on the same eventType, and must not throw back
          // into the Event Bus dispatcher (a thrown consumer error here
          // would otherwise retry/dead-letter the EVENT over a problem
          // that is really the WORKFLOW's — already-observable via that
          // run's own FAILED/DEAD_LETTER status once it does start).
          logger.error({ err, eventType, eventId: envelope.id, workflowId }, "Failed to start/execute event-triggered workflow run");
        }
      }
    });
  }

  logger.info({ eventTypes: Array.from(workflowIdsByEventType.keys()) }, "Workflow event triggers registered");
}
