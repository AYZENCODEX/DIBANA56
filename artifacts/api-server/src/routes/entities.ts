import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import { vaultEntryResource } from "./vault-entity-links";

const router = Router();

// C21 — `vault_entries` peripheral surface. `vault.ts`'s own CRUD is still
// reserved for Season B/Phase B2, but these routes live in this file, not
// `vault.ts`, so they're outside that reservation. Reuses
// vault-entity-links.ts's (C8) `vaultEntryResource` instead of a second
// copy — same table/owner column. Each route below keeps its own
// pre-existing deny body via its own `onDeny`, so this stays a thin local
// wrapper rather than vault-entity-links.ts's own fixed-body helper.
function requireVaultEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, vaultEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

// ── GET /entities/:id/summary — entity across all projects ───────────────────
router.get("/entities/:id/summary", requireAuth, requireVaultEntryOwnership("vault_entry.summary.read", (_req, res) => { res.status(404).json({ error: "Entity not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const entityResult = await db.execute(sql.raw(
    `SELECT * FROM vault_entries WHERE id = ${entityId} AND user_id = ${userId}`
  ));
  if (!entityResult.rows.length) { res.status(404).json({ error: "Entity not found" }); return; }
  const entity = entityResult.rows[0] as any;

  const roiResult = await db.execute(sql.raw(
    `SELECT epr.vault_entry_id as entity_id, epr.project_id, epr.total_cost, epr.total_profit, epr.roi,
            p.name as project_name, p.type as project_type, p.status as project_status
     FROM entity_project_roi epr
     JOIN projects p ON p.id = epr.project_id
     WHERE epr.vault_entry_id = ${entityId}
     ORDER BY epr.roi DESC`
  )).catch(() => ({ rows: [] }));

  const rows = (roiResult as any).rows as any[];
  const totalRoi = rows.reduce((s: number, r: any) => s + (parseFloat(r.roi) || 0), 0);
  const totalCost = rows.reduce((s: number, r: any) => s + (parseFloat(r.total_cost) || 0), 0);
  const totalProfit = rows.reduce((s: number, r: any) => s + (parseFloat(r.total_profit) || 0), 0);

  const enrollResult = await db.execute(sql.raw(
    `SELECT pe.*, p.name as project_name, p.category
     FROM project_enrollments pe
     JOIN projects p ON p.id = pe.project_id
     WHERE pe.vault_entry_id = ${entityId}
     ORDER BY pe.enrolled_at DESC`
  )).catch(() => ({ rows: [] }));

  res.json({
    entity,
    roi: {
      total: totalRoi,
      totalCost,
      totalProfit,
      projectCount: rows.length,
      projects: rows,
    },
    enrollments: (enrollResult as any).rows,
  });
});

// ── GET /entities/:id/health — evaluate health rules for an entity ──────────
router.get("/entities/:id/health", requireAuth, requireVaultEntryOwnership("vault_entry.health.read", (_req, res) => { res.status(404).json({ error: "Entity not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const [entityResult, rulesResult] = await Promise.all([
    db.execute(sql.raw(`SELECT * FROM vault_entries WHERE id = ${entityId} AND user_id = ${userId}`)),
    db.execute(sql.raw(`SELECT * FROM health_rules WHERE is_active = true ORDER BY severity ASC`)),
  ]);

  if (!entityResult.rows.length) { res.status(404).json({ error: "Entity not found" }); return; }
  const entity = entityResult.rows[0] as any;
  const rules = rulesResult.rows as any[];

  const flags: { rule: string; severity: string; message: string }[] = [];

  for (const rule of rules) {
    // condition is JSONB: { "check": "missing_2fa", "threshold": 30 }
    let condition: Record<string, any> = {};
    try { condition = typeof rule.condition === "string" ? JSON.parse(rule.condition) : (rule.condition ?? {}); } catch {}
    const check = condition.check as string ?? rule.name?.toLowerCase().replace(/\s+/g, "_");
    const threshold = Number(condition.threshold ?? 30);

    if (check === "missing_2fa") {
      const has2fa = entity.twitter_2fa || entity.discord_2fa || entity.telegram_2fa;
      if (!has2fa) flags.push({ rule: rule.name, severity: rule.severity, message: "No 2FA codes configured" });
    } else if (check === "missing_wallet") {
      const wallets = (() => { try { return JSON.parse(entity.wallet_addresses || "[]"); } catch { return []; } })();
      if (!wallets.length && !entity.encrypted_seed_phrase) flags.push({ rule: rule.name, severity: rule.severity, message: "No wallet addresses linked" });
    } else if (check === "inactive_days") {
      const last = entity.last_activity_at ? new Date(entity.last_activity_at) : new Date(entity.created_at);
      const diffDays = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > threshold) flags.push({ rule: rule.name, severity: rule.severity, message: `Inactive for ${Math.floor(diffDays)} days` });
    } else if (check === "missing_email") {
      if (!entity.email) flags.push({ rule: rule.name, severity: rule.severity, message: "No email configured" });
    }
  }

  const worstSeverity = flags.some(f => f.severity === "critical") ? "critical"
    : flags.some(f => f.severity === "warning") ? "warning" : "healthy";

  const badge = worstSeverity === "critical" ? "🔴" : worstSeverity === "warning" ? "🟡" : "🟢";

  res.json({ entityId, status: worstSeverity, badge, flags, currentStatus: entity.status ?? "active" });
});

// ── GET /entities/health-overview — aggregate health across all entities ─────
router.get("/entities/health-overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;

  const [entitiesResult, rulesResult] = await Promise.all([
    db.execute(sql.raw(`SELECT * FROM vault_entries WHERE user_id = ${userId}`)),
    db.execute(sql.raw(`SELECT * FROM health_rules WHERE is_active = true`)),
  ]);

  const entities = entitiesResult.rows as any[];
  const rules = rulesResult.rows as any[];

  let missing2fa = 0, missingWallet = 0, missingEmail = 0, inactive = 0;

  const inactiveRule = rules.find((r: any) => {
    let c: any = {}; try { c = typeof r.condition === "string" ? JSON.parse(r.condition) : (r.condition ?? {}); } catch {}
    return c.check === "inactive_days";
  });
  const inactiveThreshold = inactiveRule ? Number((typeof inactiveRule.condition === "string"
    ? JSON.parse(inactiveRule.condition) : inactiveRule.condition)?.threshold ?? 30) : 30;

  for (const e of entities) {
    const has2fa = e.twitter_2fa || e.discord_2fa || e.telegram_2fa;
    if (!has2fa) missing2fa++;
    const wallets = (() => { try { return JSON.parse(e.wallet_addresses || "[]"); } catch { return []; } })();
    if (!wallets.length && !e.encrypted_seed_phrase) missingWallet++;
    if (!e.email) missingEmail++;
    const last = e.last_activity_at ? new Date(e.last_activity_at) : new Date(e.created_at);
    const diffDays = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > inactiveThreshold) inactive++;
  }

  res.json({ total: entities.length, missing2fa, missingWallet, missingEmail, inactive });
});

// ── GET /entities/:id/roi — ROI breakdown by project ────────────────────────
router.get("/entities/:id/roi", requireAuth, requireVaultEntryOwnership("vault_entry.roi.read", (_req, res) => { res.status(403).json({ error: "Forbidden" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const entityCheck = await db.execute(sql.raw(
    `SELECT id FROM vault_entries WHERE id = ${entityId} AND user_id = ${userId}`
  ));
  if (!entityCheck.rows.length) { res.status(403).json({ error: "Forbidden" }); return; }

  const result = await db.execute(sql.raw(
    `SELECT epr.vault_entry_id as entity_id, epr.project_id, epr.total_cost, epr.total_profit, epr.roi,
            p.name as project_name
     FROM entity_project_roi epr
     JOIN projects p ON p.id = epr.project_id
     WHERE epr.vault_entry_id = ${entityId}`
  )).catch(() => ({ rows: [] }));
  res.json((result as any).rows);
});

// ── POST /entities/:id/roi — upsert ROI for entity+project ──────────────────
router.post("/entities/:id/roi", requireAuth, requireVaultEntryOwnership("vault_entry.roi.update", (_req, res) => { res.status(403).json({ error: "Forbidden" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { projectId, totalCost = 0, totalProfit = 0 } = req.body;
  if (!projectId) { res.status(400).json({ error: "projectId required" }); return; }

  // Verify ownership
  const check = await db.execute(sql.raw(
    `SELECT id FROM vault_entries WHERE id = ${entityId} AND user_id = ${userId}`
  ));
  if (!check.rows.length) { res.status(403).json({ error: "Forbidden" }); return; }

  const result = await db.execute(sql.raw(
    `INSERT INTO entity_project_roi (user_id, vault_entry_id, project_id, total_cost, total_profit, recorded_at)
     VALUES (${userId}, ${entityId}, ${projectId}, ${Number(totalCost)}, ${Number(totalProfit)}, NOW())
     ON CONFLICT (vault_entry_id, project_id)
     DO UPDATE SET total_cost = ${Number(totalCost)}, total_profit = ${Number(totalProfit)}, recorded_at = NOW()
     RETURNING *`
  ));
  res.json((result as any).rows[0]);
});

// ── PATCH /entities/:id/status — update entity status ───────────────────────
router.patch("/entities/:id/status", requireAuth, requireVaultEntryOwnership("vault_entry.status.update", (_req, res) => { res.status(404).json({ error: "Not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { status } = req.body;
  const allowed = ["active", "warning", "banned", "suspended"];
  if (!allowed.includes(status)) { res.status(400).json({ error: "Invalid status. Allowed: active, warning, banned, suspended" }); return; }

  const result = await db.execute(sql.raw(
    `UPDATE vault_entries SET status = '${status}', last_activity_at = NOW()
     WHERE id = ${entityId} AND user_id = ${userId} RETURNING *`
  ));
  if (!(result as any).rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json((result as any).rows[0]);
});

export default router;
