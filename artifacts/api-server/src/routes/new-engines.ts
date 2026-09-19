import { Router, type Response } from "express";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { EngineError } from "../lib/sub-engines/common";
import {
  consentEngine, dataLineageEngine, knowledgeGraphEngine, provenanceEngine, schemaRegistryEngine,
  searchIndexEngine, timeSeriesEngine,
} from "../lib/new-engines";

const router = Router();
const access = (req: { user?: { userId: number; organizationId?: number | null; role?: string } }) => ({
  userId: req.user?.userId,
  organizationId: req.user?.organizationId,
  isAdmin: req.user?.role === "admin" || req.user?.role === "developer",
});
function handleError(error: unknown, res: Response): void {
  if (error instanceof EngineError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  res.status(400).json({ error: error instanceof Error ? error.message : "New engine request failed", code: "NEW_ENGINE_REQUEST_INVALID" });
}

router.get("/new-engines/search", requireAuth, (req, res) => res.json(searchIndexEngine.query({ text: String(req.query.text ?? ""), type: typeof req.query.type === "string" ? req.query.type : undefined, tags: typeof req.query.tags === "string" ? req.query.tags.split(",") : undefined, limit: Number(req.query.limit), cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined, mode: req.query.mode as "full_text" | "semantic" | "hybrid" | undefined }, access(req))));
router.get("/new-engines/health", requireAuth, (_req, res) => res.json({
  status: "ok",
  engines: {
    search: searchIndexEngine.stats(),
    knowledgeGraph: knowledgeGraphEngine.stats(),
    schemas: schemaRegistryEngine.list().length,
    lineage: dataLineageEngine.list(),
  },
}));
router.put("/admin/new-engines/search/documents/:id", requireAdmin, (req, res) => { try { res.status(201).json(searchIndexEngine.upsert({ ...req.body, id: req.params.id })); } catch (error) { handleError(error, res); } });
router.delete("/admin/new-engines/search/documents/:id", requireAdmin, (req, res) => res.json({ removed: searchIndexEngine.remove(req.params.id) }));
router.post("/admin/new-engines/search/rebuilds", requireAdmin, (_req, res) => res.status(202).json(searchIndexEngine.startRebuild()));
router.get("/admin/new-engines/search/rebuilds/:id", requireAdmin, (req, res) => { try { res.json(searchIndexEngine.rebuildStatus(req.params.id)); } catch (error) { handleError(error, res); } });

router.get("/new-engines/graph/entities/:id", requireAuth, (req, res) => res.json(knowledgeGraphEngine.getEntity(req.params.id, access(req)) ?? null));
router.post("/admin/new-engines/graph/entities", requireAdmin, (req, res) => { try { res.status(201).json(knowledgeGraphEngine.upsertEntity(req.body)); } catch (error) { handleError(error, res); } });
router.post("/admin/new-engines/graph/relationships", requireAdmin, (req, res) => { try { res.status(201).json(knowledgeGraphEngine.upsertRelationship(req.body)); } catch (error) { handleError(error, res); } });
router.get("/new-engines/graph/entities/:id/traverse", requireAuth, (req, res) => res.json(knowledgeGraphEngine.traverse(req.params.id, access(req), { maxDepth: typeof req.query.maxDepth === "string" ? Number(req.query.maxDepth) : undefined, relationshipType: typeof req.query.relationshipType === "string" ? req.query.relationshipType : undefined })));

router.get("/new-engines/schemas", requireAuth, (_req, res) => res.json(schemaRegistryEngine.list()));
router.post("/admin/new-engines/schemas", requireAdmin, (req, res) => { try { res.status(201).json(schemaRegistryEngine.register(req.body)); } catch (error) { handleError(error, res); } });
router.post("/new-engines/schemas/:name/validate", requireAuth, (req, res) => res.json(schemaRegistryEngine.validate(req.params.name, req.body.value, Number(req.body.version))));

router.post("/admin/new-engines/lineage/nodes", requireAdmin, (req, res) => { try { res.status(201).json(dataLineageEngine.registerNode(req.body)); } catch (error) { handleError(error, res); } });
router.post("/admin/new-engines/lineage/flows", requireAdmin, (req, res) => { try { res.status(201).json(dataLineageEngine.recordFlow(req.body)); } catch (error) { handleError(error, res); } });
router.get("/new-engines/lineage/:id/impact", requireAuth, (req, res) => res.json(dataLineageEngine.impact(req.params.id, access(req), req.query.direction === "upstream" ? "upstream" : "downstream")));

router.post("/new-engines/provenance", requireAuth, (req, res) => { try { res.status(201).json(provenanceEngine.record({ ...req.body, actorUserId: req.user?.userId, organizationId: req.body.organizationId ?? req.user?.organizationId })); } catch (error) { handleError(error, res); } });
router.get("/new-engines/provenance/:subjectType/:subjectId", requireAuth, (req, res) => res.json({ history: provenanceEngine.history(req.params.subjectType, req.params.subjectId), verification: provenanceEngine.verify(req.params.subjectType, req.params.subjectId) }));

router.post("/new-engines/timeseries", requireAuth, (req, res) => { try { res.status(201).json(timeSeriesEngine.append({ ...req.body, organizationId: req.body.organizationId ?? req.user?.organizationId })); } catch (error) { handleError(error, res); } });
router.get("/new-engines/timeseries/:series", requireAuth, (req, res) => res.json(timeSeriesEngine.query(req.params.series, String(req.query.from), String(req.query.to), access(req), Number(req.query.bucketMs))));
router.post("/admin/new-engines/timeseries/retention", requireAdmin, (req, res) => { try { res.json({ removed: timeSeriesEngine.enforceRetention(String(req.body.before)) }); } catch (error) { handleError(error, res); } });

router.get("/new-engines/consent/definitions", requireAuth, (_req, res) => res.json(consentEngine.listDefinitions()));
router.post("/admin/new-engines/consent/definitions", requireAdmin, (req, res) => { try { res.status(201).json(consentEngine.define(req.body)); } catch (error) { handleError(error, res); } });
router.post("/new-engines/consent/:key/grant", requireAuth, (req, res) => { try { res.status(201).json(consentEngine.grant({ key: req.params.key, subjectUserId: req.user!.userId, organizationId: req.body.organizationId ?? req.user?.organizationId, source: req.body.source, version: req.body.version })); } catch (error) { handleError(error, res); } });
router.post("/new-engines/consent/:key/withdraw", requireAuth, (req, res) => { try { res.json(consentEngine.withdraw(req.params.key, req.user!.userId, req.body.organizationId ?? req.user?.organizationId)); } catch (error) { handleError(error, res); } });
router.get("/new-engines/consent/:key", requireAuth, (req, res) => res.json({ effective: consentEngine.effective(req.params.key, req.user!.userId, req.user?.organizationId) ?? null, history: consentEngine.history(req.params.key, req.user!.userId, req.user?.organizationId) }));

export default router;