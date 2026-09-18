import { Router } from "express";
import { db } from "@workspace/db";
import { sql, SQL } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

const ACTION_LABELS: Record<string, string> = {
  task_submitted: "Task Submitted",
  task_approved: "Task Approved",
  task_rejected: "Task Rejected",
  task_auto_approved: "Task Auto-Approved",
  project_joined: "Joined Project",
  login: "Logged In",
  password_changed: "Password Changed",
  vault_created: "Vault Entity Created",
  vault_deleted: "Vault Entity Deleted",
  credit_purchased: "Credits Purchased",
  subscription_upgraded: "Subscription Upgraded",
};

router.get("/history", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;

  const { limit = "50", offset = "0", action } = req.query as Record<string, string>;
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Math.max(Number(offset) || 0, 0);

  const conditions: SQL[] = [sql`user_id = ${userId}`];
  if (action) conditions.push(sql`action = ${action}`);
  const whereSql = sql.join(conditions, sql` AND `);

  try {
    const result = await db.execute(sql`
      SELECT * FROM user_activity
      WHERE ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `);
    const countResult = await db.execute(sql`
      SELECT COUNT(*) as total FROM user_activity WHERE ${whereSql}
    `);
    const total = Number((countResult.rows[0] as any)?.total ?? 0);

    res.json({
      items: (result.rows as any[]).map(r => ({
        id: r.id,
        action: r.action,
        label: ACTION_LABELS[r.action] ?? r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityName: r.entity_name,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return {}; } })() : {},
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      })),
      total,
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/history/chart", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  try {
    const r = await db.execute(sql`
      SELECT
         TO_CHAR(DATE_TRUNC('week', created_at), 'Mon DD') as week,
         COUNT(*) FILTER (WHERE action IN ('task_approved','task_auto_approved')) as approved,
         COUNT(*) FILTER (WHERE action = 'task_submitted') as submitted,
         COUNT(*) as total
       FROM user_activity
       WHERE user_id = ${userId} AND created_at >= NOW() - INTERVAL '10 weeks'
       GROUP BY DATE_TRUNC('week', created_at)
       ORDER BY DATE_TRUNC('week', created_at) ASC
    `);
    res.json(r.rows);
  } catch { res.json([]); }
});

router.get("/admin/history", requireAdmin, async (req, res): Promise<void> => {
  const { limit = "30", page = "1", userId, action: filterAction } = req.query as Record<string, string>;
  const lim = Math.min(Number(limit) || 30, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const conditions: SQL[] = [];
  if (userId) conditions.push(sql`ua.user_id = ${Number(userId)}`);
  if (filterAction) conditions.push(sql`ua.action ILIKE ${"%" + filterAction + "%"}`);
  const whereSql = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  try {
    const result = await db.execute(sql`
      SELECT ua.*, u.username, u.email FROM user_activity ua
       LEFT JOIN users u ON u.id = ua.user_id
       ${whereSql}
       ORDER BY ua.created_at DESC
       LIMIT ${lim} OFFSET ${offset}
    `);
    const countResult = await db.execute(sql`
      SELECT COUNT(*) as total FROM user_activity ua ${whereSql}
    `);
    const total = Number((countResult.rows[0] as any)?.total ?? 0);
    res.json({
      entries: (result.rows as any[]).map(r => ({
        id: r.id, user_id: r.user_id, username: r.username, email: r.email,
        action: r.action, label: ACTION_LABELS[r.action] ?? r.action,
        entity_type: r.entity_type, entity_id: r.entity_id, entity_name: r.entity_name,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      })),
      total, page: Number(page), limit: lim,
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
