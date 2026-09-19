import { Router, type Response } from "express";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import {
  dataGovernanceEngine, disasterRecoveryEngine, eventReplayEngine, fileBlobEngine,
  workflowDesignerEngine, dataPipelineEngine, EngineError,
} from "../lib/sub-engines";
import { scheduleBackupVerification, schedulePipelineRun } from "../lib/sub-engines/integration";

const router = Router();
const actor = (req: { user?: { userId: number } }): number | null => req.user?.userId ?? null;
const fail = (error: unknown, res: Response): void => {
  if (error instanceof EngineError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  res.status(500).json({ error: "Advanced sub-engine request failed", code: "SUB_ENGINE_ERROR" });
};

router.post("/sub-engines/blobs", requireAuth, (req, res) => {
  try {
    const data = Buffer.from(String(req.body.dataBase64 ?? ""), "base64");
    res.status(201).json(fileBlobEngine.put({ ...req.body, data, scope: { organizationId: Number(req.body.organizationId), userId: req.user?.userId, resourceId: req.body.resourceId }, actorUserId: actor(req) }));
  } catch (error) { fail(error, res); }
});
router.get("/sub-engines/blobs", requireAuth, (req, res) => {
  try { res.json(fileBlobEngine.list({ organizationId: Number(req.query.organizationId), userId: req.user?.userId })); } catch (error) { fail(error, res); }
});
router.delete("/sub-engines/blobs/:id", requireAuth, (req, res) => {
  try { fileBlobEngine.delete(req.params.id, { organizationId: Number(req.body.organizationId), userId: req.user?.userId }, actor(req)); res.status(204).send(); } catch (error) { fail(error, res); }
});

router.post("/sub-engines/pipelines", requireAdmin, (req, res) => {
  try {
    res.status(201).json(dataPipelineEngine.register({ ...req.body, organizationId: req.body.organizationId ?? req.user?.organizationId }, actor(req)));
  } catch (error) { fail(error, res); }
});
router.post("/sub-engines/pipelines/:id/run", requireAuth, async (req, res) => {
  try {
    const result = req.body?.async === false
      ? await dataPipelineEngine.start(req.params.id, req.body.input, actor(req))
      : await schedulePipelineRun({ pipelineId: req.params.id, input: req.body.input }, { actorUserId: actor(req) });
    res.status(202).json(result);
  } catch (error) { fail(error, res); }
});
router.get("/sub-engines/pipelines/runs/:id", requireAuth, (req, res) => {
  res.json(dataPipelineEngine.get(req.params.id) ?? null);
});

router.post("/admin/sub-engines/governance", requireAdmin, (req, res) => {
  try { res.status(201).json(dataGovernanceEngine.register(req.body, actor(req))); } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/governance/:id/holds", requireAdmin, (req, res) => {
  try { res.status(201).json(dataGovernanceEngine.addHold(req.params.id, req.body.kind, String(req.body.reason ?? ""), actor(req))); } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/governance/:id/delete", requireAdmin, (req, res) => {
  try { res.json(dataGovernanceEngine.delete(req.params.id, actor(req))); } catch (error) { fail(error, res); }
});

router.post("/admin/sub-engines/replay", requireAdmin, async (req, res) => {
  try { res.json(await eventReplayEngine.replay({ ...req.body, actorUserId: actor(req), from: req.body.from ? new Date(req.body.from) : undefined, to: req.body.to ? new Date(req.body.to) : undefined })); } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/replay/:id/cancel", requireAdmin, (req, res) => {
  try { eventReplayEngine.cancel(req.params.id, actor(req)); res.status(204).send(); } catch (error) { fail(error, res); }
});

router.post("/admin/sub-engines/workflow-drafts", requireAdmin, (req, res) => {
  try { res.status(201).json(workflowDesignerEngine.saveDraft(req.body.definition, req.body.organizationId, actor(req))); } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/workflow-drafts/:id/publish", requireAdmin, (req, res) => {
  try { res.json(workflowDesignerEngine.publish(req.params.id, actor(req))); } catch (error) { fail(error, res); }
});
router.get("/sub-engines/workflows/:id", requireAuth, (req, res) => res.json(workflowDesignerEngine.get(req.params.id, req.query.version ? Number(req.query.version) : undefined) ?? null));

router.post("/admin/sub-engines/dr/backups", requireAdmin, (req, res) => {
  try { res.status(201).json(disasterRecoveryEngine.catalog({ ...req.body, actorUserId: actor(req) })); } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/dr/backups/:id/verify", requireAdmin, (req, res) => {
  try {
    if (req.body?.async) {
      void scheduleBackupVerification({ backupId: req.params.id }, { actorUserId: actor(req) })
        .then((job) => res.status(202).json(job))
        .catch((error) => fail(error, res));
      return;
    }
    res.json(disasterRecoveryEngine.verify(req.params.id, actor(req)));
  } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/dr/backups/:id/plans", requireAdmin, (req, res) => {
  try { res.status(201).json(disasterRecoveryEngine.planRestore(req.params.id, req.body.dependencies ?? [], Boolean(req.body.drill), actor(req))); } catch (error) { fail(error, res); }
});
router.post("/admin/sub-engines/dr/plans/:id/drill", requireAdmin, (req, res) => {
  try { res.json(disasterRecoveryEngine.runDrill(req.params.id, actor(req))); } catch (error) { fail(error, res); }
});

export default router;