import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

// ── GET /ad-tasks — list active ad tasks for user ─────────────────────────────
router.get("/ad-tasks", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const result = await db.execute(sql.raw(
    `SELECT at.*,
       (SELECT COUNT(*) FROM ad_completions WHERE ad_task_id = at.id AND user_id = ${userId}) as user_completed
     FROM ad_tasks at
     WHERE at.is_active = true
     ORDER BY at.created_at DESC`
  ));
  res.json(result.rows);
});

// ── GET /admin/ad-tasks — all ad tasks (admin) ────────────────────────────────
router.get("/admin/ad-tasks", requireAdmin, async (req, res): Promise<void> => {
    const result = await db.execute(sql.raw(
    `SELECT at.*,
       (SELECT COUNT(*) FROM ad_completions WHERE ad_task_id = at.id) as total_completions
     FROM ad_tasks at ORDER BY at.created_at DESC`
  ));
  res.json(result.rows);
});

// ── POST /admin/ad-tasks — create ad task (admin) ────────────────────────────
router.post("/admin/ad-tasks", requireAdmin, async (req, res): Promise<void> => {
    const { title, description, ad_url, ad_image_url, reward_amount, view_duration_seconds } = req.body;
  if (!title || !ad_url) { res.status(400).json({ error: "title and ad_url required" }); return; }
  const result = await db.execute(sql.raw(
    `INSERT INTO ad_tasks (title, description, ad_url, ad_image_url, reward_amount, view_duration_seconds)
     VALUES ('${title.replace(/'/g, "''")}', ${description ? `'${description.replace(/'/g, "''")}'` : "NULL"},
       '${ad_url.replace(/'/g, "''")}', ${ad_image_url ? `'${ad_image_url.replace(/'/g, "''")}'` : "NULL"},
       ${parseFloat(reward_amount ?? "0")}, ${parseInt(view_duration_seconds ?? "15", 10)})
     RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── PATCH /admin/ad-tasks/:id — update ad task ───────────────────────────────
router.patch("/admin/ad-tasks/:id", requireAdmin, async (req, res): Promise<void> => {
    const adId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { title, description, ad_url, ad_image_url, reward_amount, view_duration_seconds, is_active } = req.body;
  const sets: string[] = [];
  if (title !== undefined) sets.push(`title = '${title.replace(/'/g, "''")}'`);
  if (description !== undefined) sets.push(`description = '${description.replace(/'/g, "''")}'`);
  if (ad_url !== undefined) sets.push(`ad_url = '${ad_url.replace(/'/g, "''")}'`);
  if (ad_image_url !== undefined) sets.push(`ad_image_url = '${ad_image_url.replace(/'/g, "''")}'`);
  if (reward_amount !== undefined) sets.push(`reward_amount = ${parseFloat(reward_amount)}`);
  if (view_duration_seconds !== undefined) sets.push(`view_duration_seconds = ${parseInt(view_duration_seconds, 10)}`);
  if (is_active !== undefined) sets.push(`is_active = ${is_active ? "true" : "false"}`);
  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const result = await db.execute(sql.raw(
    `UPDATE ad_tasks SET ${sets.join(", ")} WHERE id = ${adId} RETURNING *`
  ));
  res.json(result.rows[0]);
});

// ── DELETE /admin/ad-tasks/:id ────────────────────────────────────────────────
router.delete("/admin/ad-tasks/:id", requireAdmin, async (req, res): Promise<void> => {
    const adId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM ad_completions WHERE ad_task_id = ${adId}`));
  await db.execute(sql.raw(`DELETE FROM ad_tasks WHERE id = ${adId}`));
  res.json({ ok: true });
});

// ── POST /ad-tasks/:id/complete — mark viewed + give reward ───────────────────
router.post("/ad-tasks/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const adId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const ad = await db.execute(sql.raw(
    `SELECT * FROM ad_tasks WHERE id = ${adId} AND is_active = true`
  ));
  if (!ad.rows.length) { res.status(404).json({ error: "Ad task not found" }); return; }
  const adData = ad.rows[0] as any;
  const alreadyDone = await db.execute(sql.raw(
    `SELECT 1 FROM ad_completions WHERE user_id = ${userId} AND ad_task_id = ${adId}`
  ));
  if (alreadyDone.rows.length) { res.status(409).json({ error: "Already completed" }); return; }
  await db.execute(sql.raw(
    `INSERT INTO ad_completions (user_id, ad_task_id) VALUES (${userId}, ${adId})`
  ));
  const rewardAmount = parseFloat(adData.reward_amount) || 0;
  if (rewardAmount > 0) {
    await db.execute(sql.raw(
      `INSERT INTO credits (user_id, amount, azn_amount, source, description)
       VALUES (${userId}, ${rewardAmount}, ${rewardAmount}, 'ad_task', 'Ad to Earn: ${adData.title.replace(/'/g, "''")}')
       ON CONFLICT DO NOTHING`
    )).catch(() => {});
    await db.execute(sql.raw(
      `UPDATE users SET total_roi = total_roi + ${rewardAmount} WHERE id = ${userId}`
    )).catch(() => {});
  }
  res.json({ ok: true, reward: rewardAmount });
});

export default router;
