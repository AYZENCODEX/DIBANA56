import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// `marketplace_alerts` has one owner column (`user_id`) — plain
// single-owner shape, same as everywhere else in this series.
const MARKETPLACE_ALERT_OWNER_SENTINEL_NONE = -1;
const marketplaceAlertResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_alert", id: req.params.id, ownerId: MARKETPLACE_ALERT_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT user_id FROM marketplace_alerts WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_alert", id, ownerId: rows[0]?.user_id ?? MARKETPLACE_ALERT_OWNER_SENTINEL_NONE };
};
function requireMarketplaceAlertOwnership(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, marketplaceAlertResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

// ─── 38. POST /marketplace/alerts — create a price/keyword alert ─────────────
router.post("/marketplace/alerts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { keyword, listing_type, max_price_azn, platform } = req.body;
  if (!keyword && !listing_type) { res.status(400).json({ error: "At least a keyword or listing_type is required" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO marketplace_alerts (user_id, keyword, listing_type, max_price_azn, platform, is_active, created_at)
       VALUES ($1,$2,$3,$4,$5,TRUE,NOW()) RETURNING *`,
      [userId, keyword || null, listing_type || null, max_price_azn ? Number(max_price_azn) : null, platform || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 39. GET /marketplace/alerts — user's own alerts ──────────────────────────
router.get("/marketplace/alerts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query("SELECT * FROM marketplace_alerts WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 40. PATCH /marketplace/alerts/:id — update or toggle an alert ───────────
router.patch("/marketplace/alerts/:id", requireAuth, requireMarketplaceAlertOwnership("marketplace_alert.update", { error: "Alert not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { keyword, max_price_azn, platform, is_active } = req.body;
  const sets: string[] = []; const params: any[] = [];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (keyword !== undefined) push("keyword", keyword);
  if (max_price_azn !== undefined) push("max_price_azn", max_price_azn === null ? null : Number(max_price_azn));
  if (platform !== undefined) push("platform", platform);
  if (is_active !== undefined) push("is_active", !!is_active);
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  try {
    params.push(id, userId);
    const r = await pool.query(
      `UPDATE marketplace_alerts SET ${sets.join(", ")} WHERE id=$${params.length - 1} AND user_id=$${params.length} RETURNING *`,
      params
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Alert not found or not yours" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 41. DELETE /marketplace/alerts/:id — delete an alert ────────────────────
router.delete("/marketplace/alerts/:id", requireAuth, requireMarketplaceAlertOwnership("marketplace_alert.delete", { error: "Alert not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query("DELETE FROM marketplace_alerts WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId]);
    if (r.rows.length === 0) { res.status(404).json({ error: "Alert not found or not yours" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 42. POST /marketplace/saved-searches — save a filter combination ────────
router.post("/marketplace/saved-searches", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { name, filters } = req.body;
  if (!name || !filters) { res.status(400).json({ error: "name and filters are required" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO marketplace_saved_searches (user_id, name, filters, created_at)
       VALUES ($1,$2,$3,NOW()) RETURNING *`,
      [userId, name, JSON.stringify(filters)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 43. GET /marketplace/saved-searches — list user's saved searches ────────
router.get("/marketplace/saved-searches", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query("SELECT * FROM marketplace_saved_searches WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
