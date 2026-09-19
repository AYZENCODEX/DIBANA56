import { Router, type Response } from "express";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import {
  apiDefenseEngine, secretsSecurityEngine, sioraOperations, sioraRuntime, threatIntelligenceEngine,
} from "../lib/siora";
import { EngineError } from "../lib/sub-engines/common";
import { getCurrentTraceContext } from "../lib/trace-context";

const router = Router();

function handleError(error: unknown, res: Response): void {
  if (error instanceof EngineError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  res.status(400).json({ error: error instanceof Error ? error.message : "SIORA request failed", code: "SIORA_REQUEST_INVALID" });
}

router.post("/siora/evaluate", requireAuth, async (req, res) => {
  try {
    const evaluation = await sioraRuntime.dispatch({
      kind: req.body.kind ?? "custom",
      name: req.body.name ?? "api.action",
      context: {
        actor: { userId: req.user?.userId, role: req.user?.role, authType: req.user?.authType },
        request: { method: req.method, path: req.path, endpoint: req.path, ip: req.ip, userAgent: req.get("user-agent") ?? undefined, ...req.body.context?.request },
        ...req.body.context,
      },
      data: req.body.data ?? {},
      trace: getCurrentTraceContext() ?? { traceId: "unknown" },
    });
    res.json(evaluation);
  } catch (error) { handleError(error, res); }
});

router.get("/siora/engines", requireAdmin, (_req, res) => res.json(sioraRuntime.listEngines()));
router.get("/siora/health", requireAdmin, (_req, res) => res.json(sioraRuntime.health()));
router.get("/siora/events", requireAdmin, (req, res) => res.json(sioraRuntime.recentEvents(Number(req.query.limit) || 50)));
router.get("/siora/signals", requireAdmin, (req, res) => res.json(sioraRuntime.recentSignals(Number(req.query.limit) || 100)));
router.get("/siora/evaluations", requireAdmin, (req, res) => res.json(sioraRuntime.recentEvaluations(Number(req.query.limit) || 50)));

router.patch("/admin/siora/engines/:name", requireAdmin, (req, res) => {
  try { res.json(sioraRuntime.configure(req.params.name, { enabled: req.body.enabled, timeoutMs: req.body.timeoutMs, failClosed: req.body.failClosed })); }
  catch (error) { handleError(error, res); }
});

router.put("/admin/siora/indicators/:type/:value", requireAdmin, (req, res) => {
  try {
    const indicator = threatIntelligenceEngine.upsert({
      type: req.params.type as "ip" | "domain" | "url" | "user_agent" | "identifier",
      value: req.params.value,
      severity: req.body.severity ?? "medium",
      confidence: req.body.confidence ?? "medium",
      source: req.body.source ?? "admin",
      expiresAt: req.body.expiresAt,
      allowed: req.body.allowed,
    });
    res.status(201).json(indicator);
  } catch (error) { handleError(error, res); }
});

router.get("/admin/siora/indicators", requireAdmin, (_req, res) => res.json(threatIntelligenceEngine.list()));
router.get("/admin/siora/incidents", requireAdmin, (_req, res) => res.json(sioraOperations.listIncidents()));
router.get("/admin/siora/response-actions", requireAdmin, (_req, res) => res.json(sioraOperations.listActions()));
router.patch("/admin/siora/response-actions/:id", requireAdmin, (req, res) => {
  try {
    const status = req.body.status;
    if (status !== "completed" && status !== "failed") {
      res.status(400).json({ error: "status must be completed or failed", code: "SIORA_ACTION_STATUS_INVALID" });
      return;
    }
    res.json(sioraOperations.transitionAction(req.params.id, status));
  } catch (error) { handleError(error, res); }
});
router.post("/admin/siora/incidents", requireAdmin, (req, res) => {
  try {
    res.status(201).json(sioraOperations.createIncident({
      severity: req.body.severity ?? "medium",
      title: req.body.title ?? "SIORA incident",
      reasonCodes: Array.isArray(req.body.reasonCodes) ? req.body.reasonCodes : [],
      traceId: getCurrentTraceContext()?.traceId,
    }));
  } catch (error) { handleError(error, res); }
});
router.patch("/admin/siora/incidents/:id", requireAdmin, (req, res) => {
  try { res.json(sioraOperations.updateIncident(req.params.id, req.body.status)); }
  catch (error) { handleError(error, res); }
});
router.get("/admin/siora/endpoints", requireAdmin, (_req, res) => res.json(apiDefenseEngine.listEndpoints()));
router.put("/admin/siora/endpoints/{*path}", requireAdmin, (req, res) => {
  try {
    const path = `/${req.params.path}`;
    res.status(201).json(apiDefenseEngine.registerEndpoint(path, {
      sensitivity: req.body.sensitivity ?? "medium",
      write: Boolean(req.body.write),
      abuseCost: Number(req.body.abuseCost ?? 20),
      authRequired: req.body.authRequired !== false,
    }));
  } catch (error) { handleError(error, res); }
});
router.post("/admin/siora/secrets", requireAdmin, (req, res) => {
  try {
    if (!req.body.id || !req.body.type || !req.body.owner || !req.body.purpose) {
      res.status(400).json({ error: "id, type, owner and purpose are required", code: "SIORA_SECRET_METADATA_INVALID" });
      return;
    }
    res.status(201).json(secretsSecurityEngine.register({
      id: String(req.body.id),
      type: String(req.body.type),
      owner: String(req.body.owner),
      purpose: String(req.body.purpose),
      expiresAt: req.body.expiresAt,
      rotationState: req.body.rotationState,
    }));
  } catch (error) { handleError(error, res); }
});
router.get("/admin/siora/secrets", requireAdmin, (_req, res) => res.json(secretsSecurityEngine.list()));

export default router;