import { Router, type Response } from "express";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import {
  configurationEngine, featureFlagEngine, queueEngine, rateLimitEngine, cacheEngine,
  permissionGraphEngine, rulesEngine, subEngineAudit,
} from "../lib/sub-engines";
import { EngineError } from "../lib/sub-engines/common";

const router = Router();
const admin = requireAdmin;

function actor(req: { user?: { userId: number } }): number | null {
  return req.user?.userId ?? null;
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof EngineError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  res.status(500).json({ error: "Sub-engine request failed", code: "SUB_ENGINE_ERROR" });
}

router.get("/sub-engines/config", requireAuth, (req, res) => {
  try {
    const scope = { environment: typeof req.query.environment === "string" ? req.query.environment : undefined };
    const keys = configurationEngine.definitionsList().map((definition) => ({ ...definition, value: configurationEngine.get(definition.key, scope) }));
    res.json(keys);
  } catch (error) { handleError(error, res); }
});

router.patch("/admin/sub-engines/config/:key", admin, (req, res) => {
  try {
    const value = configurationEngine.set(req.params.key, req.body.value, { environment: req.body.environment, organizationId: req.body.organizationId, userId: req.body.userId }, actor(req));
    res.json(value);
  } catch (error) { handleError(error, res); }
});

router.get("/sub-engines/flags", requireAuth, (_req, res) => res.json(featureFlagEngine.list()));
router.get("/sub-engines/flags/:key/evaluate", requireAuth, (req, res) => {
  const enabled = featureFlagEngine.evaluate(req.params.key, { userId: req.user?.userId, cohort: typeof req.query.cohort === "string" ? req.query.cohort : undefined });
  res.json({ key: req.params.key, enabled });
});
router.put("/admin/sub-engines/flags/:key", admin, (req, res) => {
  try { res.json(featureFlagEngine.upsert({ ...req.body, key: req.params.key }, actor(req))); } catch (error) { handleError(error, res); }
});

router.get("/admin/sub-engines/queue/metrics", admin, (req, res) => res.json(queueEngine.metrics(typeof req.query.queue === "string" ? req.query.queue : undefined)));
router.post("/admin/sub-engines/queue/jobs", admin, (req, res) => {
  try { res.status(201).json(queueEngine.enqueue({ ...req.body, maxAttempts: req.body.maxAttempts ?? configurationEngine.get<number>("queue.default_max_attempts") }, actor(req))); } catch (error) { handleError(error, res); }
});
router.put("/admin/sub-engines/queue/:queue/config", admin, (req, res) => {
  try { queueEngine.configure(req.params.queue, { maxConcurrency: Number(req.body.maxConcurrency) }, actor(req)); res.status(204).send(); } catch (error) { handleError(error, res); }
});

router.post("/sub-engines/rate-limit/:key/check", requireAuth, (req, res) => {
  try { res.json(rateLimitEngine.check(req.params.key, { ...req.body, userId: req.user?.userId })); } catch (error) { handleError(error, res); }
});
router.put("/admin/sub-engines/rate-limit/:key", admin, (req, res) => {
  try { rateLimitEngine.upsert({ ...req.body, key: req.params.key }, actor(req)); res.status(204).send(); } catch (error) { handleError(error, res); }
});

router.get("/sub-engines/cache/stats", requireAuth, (_req, res) => res.json(cacheEngine.stats()));
router.post("/admin/sub-engines/permissions/grants", admin, (req, res) => {
  try { permissionGraphEngine.grant(req.body, actor(req)); res.status(201).json({ ok: true }); } catch (error) { handleError(error, res); }
});
router.post("/sub-engines/permissions/check", requireAuth, (req, res) => {
  try {
    const result = permissionGraphEngine.check({ ...req.body, subject: req.body.subject ?? `user:${req.user?.userId}`, organizationId: req.body.organizationId });
    res.json(result);
  } catch (error) { handleError(error, res); }
});
router.post("/admin/sub-engines/rules", admin, (req, res) => {
  try { res.status(201).json(rulesEngine.publish(req.body, actor(req))); } catch (error) { handleError(error, res); }
});
router.post("/sub-engines/rules/evaluate", requireAuth, (req, res) => {
  try { res.json(rulesEngine.evaluate({ ...req.body.context, userId: req.user?.userId, organizationId: req.body.organizationId }, { organizationId: req.body.organizationId, dryRun: Boolean(req.body.dryRun) })); } catch (error) { handleError(error, res); }
});
router.get("/admin/sub-engines/audit", admin, (_req, res) => res.json(subEngineAudit.list()));

export default router;