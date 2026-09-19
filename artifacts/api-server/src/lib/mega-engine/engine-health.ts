/**
 * lib/mega-engine/engine-health.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part E1 (§61 Engine Health
 * Model, feeding on §39's Part A/B/C/E1 metrics). This is the file
 * event-bus/metrics.ts's own header already forward-referenced back in
 * Part A ("read by engine-health.ts (Part D/mega-engine, not this
 * file) once that lands") — it lands here, now that all three
 * subsystems (Event Bus, Scheduler, Workflow) have their own metrics
 * module to read from.
 *
 * §61's own tree:
 *
 *   MEGA ENGINE
 *    ├── Event Bus  { Outbox, Dispatcher, Consumers, DLQ }
 *    ├── Workflow   { Registry, Runner, Checkpoint, Store }
 *    └── Scheduler  { Queue, Workers, Lease, DLQ }
 *
 * Every leaf component below resolves to one of §61's four states
 * (HEALTHY/DEGRADED/UNHEALTHY/DISABLED); a subsystem's own state is the
 * WORST of its leaves', and the engine's overall state is the worst of
 * the three subsystems'. "DISABLED" is not automatically produced by
 * anything below — nothing in this codebase yet has an explicit
 * enable/disable flag per subsystem (§53 Configuration doesn't define
 * one) — it exists in the type for forward-compatibility with whichever
 * future phase adds one, same "shape exists, nothing produces it yet"
 * posture types.ts's own WorkflowRunStatus already has for a few of its
 * members.
 *
 * ── Deliberately coarse (V1, §56) ───────────────────────────────────────────
 * Every threshold below is a fixed constant, not configurable, and every
 * check is a simple count/ratio, not a rate-over-time or a percentile.
 * This is a first pass at *some* signal existing at all (§56: "start
 * simple"), not a real alerting system — a future phase can make
 * thresholds configurable (§53) or swap a count for a proper windowed
 * rate once there's an actual operator using this to decide anything.
 */
import { db, eventOutboxTable, eventDeadLetterTable, scheduledJobTable, scheduledJobDeadLetterTable, workflowRunTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getEventBusMetrics } from "../event-bus";
import { getSchedulerMetrics } from "../scheduler";
import { getWorkflowMetrics } from "../workflow";

export type HealthState = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "DISABLED";

export interface ComponentHealth {
  state: HealthState;
  reasons: string[]; // human-readable; empty when HEALTHY
}

export interface EventBusHealth {
  state: HealthState;
  outbox: ComponentHealth;
  dispatcher: ComponentHealth;
  consumers: ComponentHealth;
  dlq: ComponentHealth;
}

export interface SchedulerSubsystemHealth {
  state: HealthState;
  queue: ComponentHealth;
  workers: ComponentHealth;
  lease: ComponentHealth;
  dlq: ComponentHealth;
}

export interface WorkflowSubsystemHealth {
  state: HealthState;
  registry: ComponentHealth;
  runner: ComponentHealth;
  checkpoint: ComponentHealth;
  store: ComponentHealth;
}

export interface EngineHealth {
  state: HealthState;
  eventBus: EventBusHealth;
  scheduler: SchedulerSubsystemHealth;
  workflow: WorkflowSubsystemHealth;
  checkedAt: string;
}

// ── thresholds (see header — deliberately fixed constants for V1) ─────────
const OUTBOX_OVERDUE_GRACE_MS = 60_000; // a PENDING/FAILED outbox row still not dispatched a full minute past its own next_attempt_at means the dispatcher isn't keeping up
const OUTBOX_DEGRADED_AT = 1;
const OUTBOX_UNHEALTHY_AT = 100;
const DLQ_DEGRADED_AT = 1;
const DLQ_UNHEALTHY_AT = 50;
const QUEUE_OVERDUE_GRACE_MS = 60_000; // same reasoning as OUTBOX_OVERDUE_GRACE_MS, scheduler side
const QUEUE_DEGRADED_AT = 1;
const QUEUE_UNHEALTHY_AT = 100;
const WORKER_STALE_HEARTBEAT_MS = 60_000; // §33 — poll cadence is 5s (worker.ts's default cron), so a heartbeat this old means the loop isn't ticking at all
const STUCK_RUN_GRACE_MS = 5 * 60_000; // operational signal for a RUNNING run with no updatedAt movement; timeout enforcement remains authoritative for configured maxRuntimeMs runs

function worst(...states: HealthState[]): HealthState {
  if (states.includes("UNHEALTHY")) return "UNHEALTHY";
  if (states.includes("DEGRADED")) return "DEGRADED";
  if (states.includes("DISABLED")) return "DISABLED";
  return "HEALTHY";
}

function thresholdState(count: number, degradedAt: number, unhealthyAt: number, reason: (n: number) => string): ComponentHealth {
  if (count >= unhealthyAt) return { state: "UNHEALTHY", reasons: [reason(count)] };
  if (count >= degradedAt) return { state: "DEGRADED", reasons: [reason(count)] };
  return { state: "HEALTHY", reasons: [] };
}

// ── Event Bus ───────────────────────────────────────────────────────────
async function checkOutbox(): Promise<ComponentHealth> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM event_outbox
    WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now() - interval '${sql.raw(String(OUTBOX_OVERDUE_GRACE_MS / 1000))} seconds'
  `);
  const n = Number((result.rows[0] as { n: number })?.n ?? 0);
  return thresholdState(n, OUTBOX_DEGRADED_AT, OUTBOX_UNHEALTHY_AT, (c) => `${c} outbox row(s) overdue past their next_attempt_at by more than ${OUTBOX_OVERDUE_GRACE_MS / 1000}s — dispatcher may not be keeping up`);
}

function checkDispatcher(): ComponentHealth {
  const m = getEventBusMetrics();
  if (m.dispatched === 0) return { state: "HEALTHY", reasons: [] }; // nothing dispatched yet this process — not itself a problem
  const failureRatio = m.handlerFailures / m.dispatched;
  if (failureRatio > 0.5) return { state: "UNHEALTHY", reasons: [`handler failure ratio ${(failureRatio * 100).toFixed(1)}% of ${m.dispatched} dispatched`] };
  if (failureRatio > 0.1) return { state: "DEGRADED", reasons: [`handler failure ratio ${(failureRatio * 100).toFixed(1)}% of ${m.dispatched} dispatched`] };
  return { state: "HEALTHY", reasons: [] };
}

function checkConsumers(): ComponentHealth {
  const m = getEventBusMetrics();
  // §6 — an event published with no registered handler for its type at
  // all is a config/deploy gap, not a transient failure; any nonzero
  // count this process has seen is worth surfacing even at low volume.
  if (m.unknownType > 0) return { state: "DEGRADED", reasons: [`${m.unknownType} event(s) published with no registered consumer since process start`] };
  return { state: "HEALTHY", reasons: [] };
}

async function checkEventBusDlq(): Promise<ComponentHealth> {
  const rows = await db.select({ id: eventDeadLetterTable.id }).from(eventDeadLetterTable).where(sql`${eventDeadLetterTable.status} = 'PENDING'`);
  return thresholdState(rows.length, DLQ_DEGRADED_AT, DLQ_UNHEALTHY_AT, (c) => `${c} event(s) sitting in the dead-letter queue, status PENDING`);
}

export async function getEventBusHealth(): Promise<EventBusHealth> {
  const [outbox, dlq] = await Promise.all([checkOutbox(), checkEventBusDlq()]);
  const dispatcher = checkDispatcher();
  const consumers = checkConsumers();
  return { state: worst(outbox.state, dispatcher.state, consumers.state, dlq.state), outbox, dispatcher, consumers, dlq };
}

// ── Scheduler ───────────────────────────────────────────────────────────
async function checkQueue(): Promise<ComponentHealth> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM scheduled_job
    WHERE status IN ('SCHEDULED', 'RETRYING') AND run_at <= now() - interval '${sql.raw(String(QUEUE_OVERDUE_GRACE_MS / 1000))} seconds'
  `);
  const n = Number((result.rows[0] as { n: number })?.n ?? 0);
  return thresholdState(n, QUEUE_DEGRADED_AT, QUEUE_UNHEALTHY_AT, (c) => `${c} job(s) overdue past their run_at by more than ${QUEUE_OVERDUE_GRACE_MS / 1000}s — worker may not be keeping up`);
}

function checkWorkers(): ComponentHealth {
  const m = getSchedulerMetrics();
  if (!m.workerLastHeartbeatAt) return { state: "DEGRADED", reasons: ["no scheduler worker heartbeat recorded yet this process"] };
  const ageMs = Date.now() - new Date(m.workerLastHeartbeatAt).getTime();
  if (ageMs > WORKER_STALE_HEARTBEAT_MS) return { state: "UNHEALTHY", reasons: [`last worker heartbeat ${Math.round(ageMs / 1000)}s ago — poll loop appears stopped`] };
  if (m.workerFailures > 0) return { state: "DEGRADED", reasons: [`${m.workerFailures} whole-sweep failure(s) since process start`] };
  return { state: "HEALTHY", reasons: [] };
}

async function checkLease(): Promise<ComponentHealth> {
  // §30 — a RUNNING row whose lease has already expired but hasn't been
  // reclaimed yet by the next sweep's recoverExpiredLeases(). A nonzero
  // count here is normal for a brief window between sweeps; only
  // concerning if it's actually large (many workers crashed) — same
  // "grace before alarm" posture as the outbox/queue checks above.
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM scheduled_job WHERE status = 'RUNNING' AND locked_until < now()`);
  const n = Number((result.rows[0] as { n: number })?.n ?? 0);
  return thresholdState(n, 5, 50, (c) => `${c} job(s) with an expired lease not yet reclaimed`);
}

async function checkSchedulerDlq(): Promise<ComponentHealth> {
  const rows = await db.select({ id: scheduledJobDeadLetterTable.id }).from(scheduledJobDeadLetterTable).where(sql`${scheduledJobDeadLetterTable.status} = 'PENDING'`);
  return thresholdState(rows.length, DLQ_DEGRADED_AT, DLQ_UNHEALTHY_AT, (c) => `${c} job(s) sitting in the dead-letter queue, status PENDING`);
}

export async function getSchedulerHealth(): Promise<SchedulerSubsystemHealth> {
  const [queue, lease, dlq] = await Promise.all([checkQueue(), checkLease(), checkSchedulerDlq()]);
  const workers = checkWorkers();
  return { state: worst(queue.state, workers.state, lease.state, dlq.state), queue, workers, lease, dlq };
}

// ── Workflow ────────────────────────────────────────────────────────────
// Registry/Checkpoint/Store don't have their own metrics counters yet
// (unlike Runner, which does via workflow/metrics.ts) — a DB round-trip
// succeeding is the only signal available for them in V1; a thrown query
// below is the one way any of the three comes back UNHEALTHY rather than
// HEALTHY. Coarse on purpose (see this file's header) — refining these
// into real signals (e.g. checkpoint write latency, definition-publish
// failure rate) is future E-phase work, not E1's.
async function checkRegistryAndStore(): Promise<{ registry: ComponentHealth; store: ComponentHealth }> {
  try {
    await db.select({ id: workflowRunTable.id }).from(workflowRunTable).limit(1);
    return { registry: { state: "HEALTHY", reasons: [] }, store: { state: "HEALTHY", reasons: [] } };
  } catch (err) {
    const reason = `workflow store query failed: ${err instanceof Error ? err.message : String(err)}`;
    return { registry: { state: "UNHEALTHY", reasons: [reason] }, store: { state: "UNHEALTHY", reasons: [reason] } };
  }
}

/** Checkpoint health is the same DB-reachable check as Registry/Store above — workflow_checkpoint isn't queried separately here (no dedicated signal exists yet), it shares the Store check's outcome. Kept as its own function/field (rather than folding it into `store`) so §61's own four-leaf shape stays intact for whenever a real signal (e.g. checkpoint write latency) replaces this. */
function checkpointFromStore(store: ComponentHealth): ComponentHealth {
  return store;
}

async function checkRunner(): Promise<ComponentHealth> {
  const m = getWorkflowMetrics();
  const stuckResult = await db.execute(sql`
    SELECT count(*)::int AS n FROM workflow_run
    WHERE status = 'RUNNING' AND updated_at <= now() - interval '${sql.raw(String(STUCK_RUN_GRACE_MS / 1000))} seconds'
  `);
  const stuck = Number((stuckResult.rows[0] as { n: number })?.n ?? 0);

  const reasons: string[] = [];
  let state: HealthState = "HEALTHY";

  // A RUNNING run with no recent updated_at movement is still useful as an
  // operational signal for crashes or handlers that ignore AbortSignal. A
  // run legitimately WAITING (§24) is a different, non-stuck status, so this
  // only counts RUNNING, not WAITING.
  if (stuck > 0) {
    state = worst(state, stuck >= 20 ? "UNHEALTHY" : "DEGRADED");
    reasons.push(`${stuck} run(s) stuck RUNNING with no update in over ${STUCK_RUN_GRACE_MS / 60_000} minute(s) — likely a crashed executeRun() or a handler that ignored its timeout signal`);
  }

  if (m.runsStarted > 0) {
    const failureRatio = m.runsFailed / m.runsStarted;
    if (failureRatio > 0.5) { state = worst(state, "UNHEALTHY"); reasons.push(`run failure ratio ${(failureRatio * 100).toFixed(1)}% of ${m.runsStarted} started`); }
    else if (failureRatio > 0.2) { state = worst(state, "DEGRADED"); reasons.push(`run failure ratio ${(failureRatio * 100).toFixed(1)}% of ${m.runsStarted} started`); }
  }

  return { state, reasons };
}

export async function getWorkflowHealth(): Promise<WorkflowSubsystemHealth> {
  const { registry, store } = await checkRegistryAndStore();
  const runner = await checkRunner();
  const checkpoint = checkpointFromStore(store);
  return { state: worst(registry.state, runner.state, checkpoint.state, store.state), registry, runner, checkpoint, store };
}

// ── Top level ───────────────────────────────────────────────────────────
/** §61's own top-level call — everything else in this file is a helper for this. Safe to call from an admin/health route (Part E's remaining "admin inspection" item, not yet built) or from a periodic self-check job; does several DB round-trips, so not meant to be called on every request of a hot path. */
export async function getEngineHealth(): Promise<EngineHealth> {
  const [eventBus, scheduler, workflow] = await Promise.all([getEventBusHealth(), getSchedulerHealth(), getWorkflowHealth()]);
  return {
    state: worst(eventBus.state, scheduler.state, workflow.state),
    eventBus,
    scheduler,
    workflow,
    checkedAt: new Date().toISOString(),
  };
}
