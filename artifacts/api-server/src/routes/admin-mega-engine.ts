/**
 * routes/admin-mega-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part E2: Admin Inspection
 * (§57-E's "admin inspection" / "replay" / "dead-letter tools" — the
 * three items after "health"/"metrics", which Phase E1
 * (`CHANGES_MEGA_ENGINE_OBSERVABILITY_PHASE_E1.md`) already covered by
 * building `getEngineHealth()`/`getEventBusMetrics()`/
 * `getSchedulerMetrics()`/`getWorkflowMetrics()` — but with no HTTP
 * handler wired to any of them, per that phase's own "Still open" list.
 * This file is that handler. Extended in Part E3
 * (`CHANGES_MEGA_ENGINE_RETENTION_PHASE_E3.md`) with the two
 * `/retention` routes below, the same "expose what the store layer
 * already does" posture the dead-letter routes already have — the
 * retention sweep itself runs on its own daily cron (see
 * `lib/mega-engine/retention.ts`'s `registerRetentionSweepSchedule()`),
 * these routes are only for inspecting the configured windows and
 * triggering an out-of-band run.
 *
 * Every write endpoint below (`replay`/`discard`/`retention/run`) is a
 * thin pass-through to a store-layer function that already existed
 * before this file did — this file adds no new dead-letter or retention
 * *logic*, only exposes what those already do. There is no dead-letter
 * concept on the Workflow side (a run that can't proceed lands in its
 * own `DEAD_LETTER` run status instead — no separate table, nothing to
 * list/replay/discard here beyond what `/runs` already surfaces).
 *
 * `engine` route params below are `"events" | "jobs"` — Event Bus and
 * Scheduler dead letters share the same shape of operation
 * (list/replay/discard by numeric id) but live in two different tables
 * with two different underlying functions, so one param picks which
 * pair of store functions a given request goes through rather than
 * duplicating every route three times.
 *
 * Extended again in Part F1
 * (`CHANGES_MEGA_ENGINE_RELIABILITY_PHASE_F1.md`, §65's "F: Reliability/
 * security") with the `/workflow/runs*` routes below — list/filter runs,
 * inspect one run's step history, cancel a still-in-flight run
 * (`run-store.ts`'s existing `cancelRun()`, never exposed until now),
 * and replay a terminal-but-unsuccessful run as a fresh one
 * (`workflow/replay.ts`'s new `replayRun()` — the Workflow engine's own
 * analogue of the dead-letter replay routes above, since a run isn't a
 * single queued row the way an event/job dead letter is).
 *
 * MOUNTING: through `routes/index.ts` at `/api/admin/mega-engine/*` —
 * same `requireDev`-gated tier as `admin-oidc-rollout.ts`/
 * `admin-policy-console.ts`/etc., mounted right next to them. This is an
 * internal operator console, not a route any non-admin caller ever hits.
 */
import { Router, type IRouter } from "express";
import { requireDev } from "../middlewares/auth";
import { logger } from "../lib/logger";
import {
  getEngineHealth, RETENTION_WINDOWS_MS, runRetentionSweep, getEngineLinks,
  getEngineOperationsSnapshot, getProductionReadinessAudit, writeEngineAudit,
} from "../lib/mega-engine";
import {
  getWorkflowMetrics,
  listRuns, getRun, getStepRuns, cancelRun,
  replayRun, RunNotFoundError, RunNotReplayableError,
  WORKFLOW_RESUME_JOB_TYPE,
  type WorkflowRunStatus,
} from "../lib/workflow";
import {
  getEventBusMetrics,
  listDeadLetters as listEventDeadLetters,
  replayDeadLetter as replayEventDeadLetter,
  discardDeadLetter as discardEventDeadLetter,
} from "../lib/event-bus";
import {
  getSchedulerMetrics,
  listDeadLetters as listJobDeadLetters,
  replayDeadLetter as replayJobDeadLetter,
  discardDeadLetter as discardJobDeadLetter,
  getJobsForCorrelation,
  pauseJob, resumeJob,
} from "../lib/scheduler";

const router: IRouter = Router();

type DeadLetterEngine = "events" | "jobs";

function isDeadLetterEngine(value: string): value is DeadLetterEngine {
  return value === "events" || value === "jobs";
}

/**
 * `id` route params below arrive as strings — both dead-letter tables use
 * a numeric (serial) primary key, not a uuid, unlike most of this
 * codebase's other id columns. A non-numeric id is a 400, not a 404 (the
 * row can't possibly exist), same "reject obviously-malformed input
 * before touching the DB" posture `admin-oidc-rollout.ts`'s `appId`
 * check already uses.
 */
function parseDeadLetterId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ── GET /admin/mega-engine/health — §61 top-level engine health ───────────
router.get("/admin/mega-engine/health", requireDev, async (_req, res): Promise<void> => {
  const health = await getEngineHealth();
  res.json(health);
});

// ── GET /admin/mega-engine/metrics — §39 in-process counters, all three engines ──
router.get("/admin/mega-engine/metrics", requireDev, (_req, res): void => {
  res.json({
    eventBus: getEventBusMetrics(),
    scheduler: getSchedulerMetrics(),
    workflow: getWorkflowMetrics(),
  });
});

// ── GET /admin/mega-engine/operations — live J10 operator snapshot ─────────
router.get("/admin/mega-engine/operations", requireDev, async (_req, res): Promise<void> => {
  res.json(await getEngineOperationsSnapshot());
});

// ── GET /admin/mega-engine/readiness — J15 production readiness audit ───────
router.get("/admin/mega-engine/readiness", requireDev, async (_req, res): Promise<void> => {
  const audit = await getProductionReadinessAudit();
  res.status(audit.ready ? 200 : 503).json(audit);
});

// ── GET /admin/mega-engine/links/:correlationId — cross-engine trace view ──
router.get("/admin/mega-engine/links/:correlationId", requireDev, async (req, res): Promise<void> => {
  const correlationId = req.params.correlationId.trim();
  if (!correlationId || correlationId.length > 256) {
    res.status(400).json({ error: "Invalid correlation id", code: "INVALID_CORRELATION_ID" });
    return;
  }
  res.json(await getEngineLinks(correlationId));
});

// ── GET /admin/mega-engine/dead-letters/:engine — list, optional ?status=/?type= filter ──
router.get("/admin/mega-engine/dead-letters/:engine", requireDev, async (req, res): Promise<void> => {
  const { engine } = req.params;
  if (!isDeadLetterEngine(engine)) {
    res.status(400).json({ error: "Invalid engine", code: "INVALID_ENGINE", solution: "engine must be \"events\" or \"jobs\"." });
    return;
  }

  const statusRaw = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  const status = statusRaw === "PENDING" || statusRaw === "REPLAYED" || statusRaw === "DISCARDED" ? statusRaw : undefined;
  if (statusRaw && !status) {
    res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS", solution: "status must be one of PENDING, REPLAYED, DISCARDED." });
    return;
  }
  const typeRaw = typeof req.query.type === "string" ? req.query.type : undefined;

  const rows = engine === "events"
    ? await listEventDeadLetters({ eventType: typeRaw, status })
    : await listJobDeadLetters({ jobType: typeRaw, status });

  res.json({ engine, deadLetters: rows });
});

// ── POST /admin/mega-engine/dead-letters/:engine/:id/replay ───────────────
router.post("/admin/mega-engine/dead-letters/:engine/:id/replay", requireDev, async (req, res): Promise<void> => {
  const { engine } = req.params;
  if (!isDeadLetterEngine(engine)) {
    res.status(400).json({ error: "Invalid engine", code: "INVALID_ENGINE", solution: "engine must be \"events\" or \"jobs\"." });
    return;
  }
  const id = parseDeadLetterId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid id", code: "INVALID_ID", solution: "id must be a positive integer." });
    return;
  }

  try {
    const result = engine === "events" ? await replayEventDeadLetter(id) : await replayJobDeadLetter(id);
    await writeEngineAudit({
      action: "dead_letter.replayed.admin",
      metadata: { engine, deadLetterId: id, actorUserId: req.user?.userId, result },
    });
    logger.info({ engine, id, actorId: req.user?.userId, result }, "mega_engine.dead_letter.admin_replayed");
    res.json({ engine, id, ...result });
  } catch (err) {
    // Both replayDeadLetter()s throw a plain Error for "not found" /
    // "already resolved" — the only two failure modes either function
    // has (see their own doc comments) — so a 400 with the thrown
    // message is accurate here, not a guess at what went wrong.
    res.status(400).json({ error: "Replay failed", code: "REPLAY_FAILED", solution: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /admin/mega-engine/dead-letters/:engine/:id/discard ──────────────
router.post("/admin/mega-engine/dead-letters/:engine/:id/discard", requireDev, async (req, res): Promise<void> => {
  const { engine } = req.params;
  if (!isDeadLetterEngine(engine)) {
    res.status(400).json({ error: "Invalid engine", code: "INVALID_ENGINE", solution: "engine must be \"events\" or \"jobs\"." });
    return;
  }
  const id = parseDeadLetterId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid id", code: "INVALID_ID", solution: "id must be a positive integer." });
    return;
  }

  // discardDeadLetter()'s own UPDATE ... WHERE status = 'PENDING' guard
  // (see both files) makes this a no-op, not an error, if the row is
  // already REPLAYED/DISCARDED or doesn't exist — same "only mutate it
  // if it's still safe to" posture scheduler/job-store.ts's cancelJob()
  // uses, so there's nothing here to distinguish/report beyond success.
  if (engine === "events") await discardEventDeadLetter(id); else await discardJobDeadLetter(id);
  await writeEngineAudit({
    action: "dead_letter.discarded.admin",
    metadata: { engine, deadLetterId: id, actorUserId: req.user?.userId },
  });
  logger.info({ engine, id, actorId: req.user?.userId }, "mega_engine.dead_letter.admin_discarded");
  res.json({ engine, id, status: "DISCARDED" });
});

const WORKFLOW_RUN_STATUSES: WorkflowRunStatus[] = [
  "PENDING", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "COMPENSATING", "COMPENSATED", "DEAD_LETTER",
];
function isWorkflowRunStatus(value: string): value is WorkflowRunStatus {
  return (WORKFLOW_RUN_STATUSES as string[]).includes(value);
}

// ── GET /admin/mega-engine/workflow/runs — list/filter, newest first ──────
router.get("/admin/mega-engine/workflow/runs", requireDev, async (req, res): Promise<void> => {
  const statusRaw = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  const status = statusRaw && isWorkflowRunStatus(statusRaw) ? statusRaw : undefined;
  if (statusRaw && !status) {
    res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS", solution: `status must be one of ${WORKFLOW_RUN_STATUSES.join(", ")}.` });
    return;
  }
  const definitionId = typeof req.query.definitionId === "string" ? req.query.definitionId : undefined;
  const correlationId = typeof req.query.correlationId === "string" ? req.query.correlationId : undefined;

  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const runs = await listRuns({ status, definitionId, correlationId }, limit);
  res.json({ runs });
});

// ── GET /admin/mega-engine/workflow/runs/:id — one run + its step history ──
router.get("/admin/mega-engine/workflow/runs/:id", requireDev, async (req, res): Promise<void> => {
  const [run, stepRuns] = await Promise.all([getRun(req.params.id), getStepRuns(req.params.id)]);
  if (!run) {
    res.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND" });
    return;
  }
  // Part I3 — closes the gap Phase I2's own CHANGES doc named: an
  // operator inspecting a run had no way to see whether it had a
  // scheduler-side workflow.resume wakeup job, or what became of it
  // (including that it was cancelled alongside the run itself, per I2)
  // without separately querying the scheduler's own job list by hand.
  // `resumeJobs` is plural and newest-first (see
  // getJobsForCorrelation()'s own doc comment) rather than "the current
  // one" — a WAITING run's wakeup job can have been re-scheduled more
  // than once over the run's lifetime (each step-retry backoff parks
  // and re-parks under the same runId correlationId), and showing the
  // full history costs nothing extra here versus picking index 0 for
  // the caller. Empty for a run that's never been WAITING (nothing
  // scheduled yet) — not an error case.
  const resumeJobs = await getJobsForCorrelation(WORKFLOW_RESUME_JOB_TYPE, req.params.id);
  res.json({ run, stepRuns, resumeJobs });
});

// ── POST /admin/mega-engine/workflow/runs/:id/cancel ───────────────────────
router.post("/admin/mega-engine/workflow/runs/:id/cancel", requireDev, async (req, res): Promise<void> => {
  // cancelRun()'s own cancellable-status guard (PENDING/RUNNING/WAITING
  // only, see run-store.ts) makes an already-terminal or missing run a
  // silent no-op rather than an error — same "only mutate it if it's
  // still safe to" posture the dead-letter discard routes above already
  // rely on, so `cancelled: false` here means exactly that, not a fault.
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : undefined;
  const cancelled = await cancelRun(req.params.id, { reason, actorUserId: req.user?.userId });
  if (cancelled) {
    await writeEngineAudit({
      action: "workflow.cancelled.admin",
      metadata: { runId: req.params.id, reason: reason ?? "Cancelled by operator" },
    });
  }
  logger.info({ runId: req.params.id, cancelled, actorId: req.user?.userId }, "mega_engine.workflow_run.admin_cancelled");
  res.json({ runId: req.params.id, cancelled });
});

// ── Scheduler operator controls (J10) ──────────────────────────────────────
router.post("/admin/mega-engine/jobs/:id/pause", requireDev, async (req, res): Promise<void> => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "Paused by operator";
  const paused = await pauseJob(req.params.id, reason);
  if (paused) await writeEngineAudit({ action: "job.paused.admin", metadata: { jobId: req.params.id, reason, actorUserId: req.user?.userId } });
  res.json({ jobId: req.params.id, paused });
});

router.post("/admin/mega-engine/jobs/:id/resume", requireDev, async (req, res): Promise<void> => {
  const resumed = await resumeJob(req.params.id);
  if (resumed) await writeEngineAudit({ action: "job.resumed.admin", metadata: { jobId: req.params.id, actorUserId: req.user?.userId } });
  res.json({ jobId: req.params.id, resumed });
});

// ── POST /admin/mega-engine/workflow/runs/:id/replay — §58 "workflow replay" ──
router.post("/admin/mega-engine/workflow/runs/:id/replay", requireDev, async (req, res): Promise<void> => {
  try {
    const result = await replayRun(req.params.id);
    logger.info({ runId: req.params.id, actorId: req.user?.userId, result }, "mega_engine.workflow_run.admin_replayed");
    res.json({ runId: req.params.id, ...result });
  } catch (err) {
    // RunNotFoundError -> 404; RunNotReplayableError (wrong status) and
    // anything else replayRun()/startRun() can throw (e.g.
    // DefinitionNotFoundError if the original definition was since
    // deleted) -> 400, same "surface the thrown message, don't guess"
    // posture the dead-letter replay route above already uses.
    if (err instanceof RunNotFoundError) {
      res.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND", solution: err.message });
      return;
    }
    const code = err instanceof RunNotReplayableError ? "RUN_NOT_REPLAYABLE" : "REPLAY_FAILED";
    res.status(400).json({ error: "Replay failed", code, solution: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /admin/mega-engine/retention — configured §60 windows (read-only) ──
router.get("/admin/mega-engine/retention", requireDev, (_req, res): void => {
  res.json({ windowsMs: RETENTION_WINDOWS_MS });
});

// ── POST /admin/mega-engine/retention/run — trigger a sweep out-of-band ───
router.post("/admin/mega-engine/retention/run", requireDev, async (req, res): Promise<void> => {
  // Same reasoning replay/discard already log for — an operator-triggered
  // deletion sweep is worth a breadcrumb even though nothing here can
  // itself fail in a way worth a non-500 status (runRetentionSweep()
  // doesn't throw for "nothing to delete", only for an actual DB error,
  // which Express 5 already forwards to the default error handler).
  const result = await runRetentionSweep();
  await writeEngineAudit({
    action: "retention.sweep.admin",
    metadata: { actorUserId: req.user?.userId, result },
  });
  logger.info({ actorId: req.user?.userId, result }, "mega_engine.retention_sweep.admin_triggered");
  res.json(result);
});

export default router;
