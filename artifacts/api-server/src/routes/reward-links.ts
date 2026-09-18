import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

// ── GET /reward-links — list published links for users ───────────────────────
router.get("/reward-links", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const result = await db.execute(sql.raw(
    `SELECT rl.*,
       (SELECT COUNT(*) FROM link_completions WHERE link_id = rl.id) as completion_count,
       (SELECT COUNT(*) FROM link_completions WHERE link_id = rl.id AND user_id = ${userId}) as user_completed
     FROM reward_links rl
     WHERE rl.is_published = true
     ORDER BY rl.created_at DESC`
  ));
  res.json(result.rows);
});

// ── GET /admin/reward-links — all links (admin) ───────────────────────────────
router.get("/admin/reward-links", requireAdmin, async (req, res): Promise<void> => {
    const result = await db.execute(sql.raw(
    `SELECT rl.*,
       (SELECT COUNT(*) FROM link_completions WHERE link_id = rl.id) as completion_count,
       u.username as created_by_username
     FROM reward_links rl
     LEFT JOIN users u ON u.id = rl.created_by
     ORDER BY rl.created_at DESC`
  ));
  res.json(result.rows);
});

// ── POST /admin/reward-links — create link (admin) ────────────────────────────
router.post("/admin/reward-links", requireAdmin, async (req, res): Promise<void> => {
    const { userId } = getRequestUser(req)!;
  const { title, description, url, reward_amount, view_duration_seconds, max_completions } = req.body;
  if (!title || !url) { res.status(400).json({ error: "title and url required" }); return; }
  const result = await db.execute(sql.raw(
    `INSERT INTO reward_links (title, description, url, reward_amount, view_duration_seconds, max_completions, created_by)
     VALUES ('${title.replace(/'/g, "''")}', ${description ? `'${description.replace(/'/g, "''")}'` : "NULL"},
       '${url.replace(/'/g, "''")}', ${parseFloat(reward_amount ?? "0")},
       ${parseInt(view_duration_seconds ?? "10", 10)}, ${parseInt(max_completions ?? "0", 10)}, ${userId})
     RETURNING *`
  ));
  res.status(201).json(result.rows[0]);
});

// ── PATCH /admin/reward-links/:id — update link ───────────────────────────────
router.patch("/admin/reward-links/:id", requireAdmin, async (req, res): Promise<void> => {
    const linkId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { title, description, url, reward_amount, is_published, view_duration_seconds, max_completions } = req.body;
  const sets: string[] = [];
  if (title !== undefined) sets.push(`title = '${title.replace(/'/g, "''")}'`);
  if (description !== undefined) sets.push(`description = '${description.replace(/'/g, "''")}'`);
  if (url !== undefined) sets.push(`url = '${url.replace(/'/g, "''")}'`);
  if (reward_amount !== undefined) sets.push(`reward_amount = ${parseFloat(reward_amount)}`);
  if (is_published !== undefined) sets.push(`is_published = ${is_published ? "true" : "false"}`);
  if (view_duration_seconds !== undefined) sets.push(`view_duration_seconds = ${parseInt(view_duration_seconds, 10)}`);
  if (max_completions !== undefined) sets.push(`max_completions = ${parseInt(max_completions, 10)}`);
  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }
  const result = await db.execute(sql.raw(
    `UPDATE reward_links SET ${sets.join(", ")} WHERE id = ${linkId} RETURNING *`
  ));
  res.json(result.rows[0]);
});

// ── DELETE /admin/reward-links/:id ────────────────────────────────────────────
router.delete("/admin/reward-links/:id", requireAdmin, async (req, res): Promise<void> => {
    const linkId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql.raw(`DELETE FROM link_completions WHERE link_id = ${linkId}`));
  await db.execute(sql.raw(`DELETE FROM reward_links WHERE id = ${linkId}`));
  res.json({ ok: true });
});

// ── POST /reward-links/:id/complete — mark completed + give reward ────────────
router.post("/reward-links/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const linkId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const link = await db.execute(sql.raw(
    `SELECT * FROM reward_links WHERE id = ${linkId} AND is_published = true`
  ));
  if (!link.rows.length) { res.status(404).json({ error: "Link not found" }); return; }
  const linkData = link.rows[0] as any;
  const alreadyDone = await db.execute(sql.raw(
    `SELECT 1 FROM link_completions WHERE user_id = ${userId} AND link_id = ${linkId}`
  ));
  if (alreadyDone.rows.length) { res.status(409).json({ error: "Already completed" }); return; }
  await db.execute(sql.raw(
    `INSERT INTO link_completions (user_id, link_id) VALUES (${userId}, ${linkId})`
  ));
  const rewardAmount = parseFloat(linkData.reward_amount) || 0;
  if (rewardAmount > 0) {
    await db.execute(sql.raw(
      `INSERT INTO credits (user_id, amount, azn_amount, source, description)
       VALUES (${userId}, ${rewardAmount}, ${rewardAmount}, 'reward_link', 'Link to Earn: ${linkData.title.replace(/'/g, "''")}')
       ON CONFLICT DO NOTHING`
    )).catch(() => {});
    await db.execute(sql.raw(
      `UPDATE users SET total_roi = total_roi + ${rewardAmount} WHERE id = ${userId}`
    )).catch(() => {});
  }
  res.json({ ok: true, reward: rewardAmount });
});

export default router;
