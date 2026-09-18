import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// ─── GET /watchlist ────────────────────────────────────────────────────────────
router.get("/watchlist", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT w.id as watchlist_id, w.created_at as added_at,
              p.id, p.name, p.description, p.status, p.project_type,
              p.chain, p.xp_name, p.logo_url,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as task_count,
              (SELECT COUNT(*) FROM user_projects up WHERE up.project_id = p.id AND up.user_id = $1) as is_joined
       FROM user_watchlist w
       JOIN projects p ON p.id = w.project_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /watchlist/:projectId ────────────────────────────────────────────────
router.post("/watchlist/:projectId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = Number(req.params.projectId);
  if (!projectId) { res.status(400).json({ error: "Invalid project" }); return; }

  // Check limit
  const countR = await pool.query(
    "SELECT COUNT(*) FROM user_watchlist WHERE user_id=$1", [userId]
  );
  if (Number(countR.rows[0].count) >= 50) {
    res.status(400).json({ error: "Watchlist full (max 50 projects)" }); return;
  }

  try {
    await pool.query(
      `INSERT INTO user_watchlist (user_id, project_id) VALUES ($1,$2)
       ON CONFLICT (user_id, project_id) DO NOTHING`,
      [userId, projectId]
    );
    res.status(201).json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /watchlist/:projectId ─────────────────────────────────────────────
router.delete("/watchlist/:projectId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = Number(req.params.projectId);
  try {
    await pool.query(
      "DELETE FROM user_watchlist WHERE user_id=$1 AND project_id=$2",
      [userId, projectId]
    );
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /watchlist/ids — just the ids for quick lookup ───────────────────────
router.get("/watchlist/ids", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      "SELECT project_id FROM user_watchlist WHERE user_id=$1",
      [userId]
    );
    res.json(r.rows.map(r => r.project_id));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
