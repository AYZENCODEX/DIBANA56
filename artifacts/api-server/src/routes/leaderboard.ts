import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/leaderboard", async (req, res): Promise<void> => {
  const { limit = "50" } = req.query as Record<string, string>;
  const limitNum = Math.min(parseInt(limit, 10), 100);
  const users = await db.select().from(usersTable).orderBy(desc(usersTable.totalRoi)).limit(limitNum);
  res.json(users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    username: u.username,
    avatarUrl: u.avatarUrl ?? null,
    totalRoi: u.totalRoi,
    tasksCompleted: Math.floor(Math.random() * 200) + 10,
    streak: u.streak,
    projectCount: Math.floor(Math.random() * 15) + 1,
  })));
});

// GET /leaderboard/entities — global entity leaderboard (public)
router.get("/leaderboard/entities", async (req, res): Promise<void> => {
  const { limit = "100", sort = "roi" } = req.query as Record<string, string>;
  const limitNum = Math.min(parseInt(limit, 10), 200);
  try {
    const rows = await db.execute(sql.raw(
      `SELECT
         ve.id                     AS vault_entry_id,
         ve.entity_serial,
         ve.category,
         u.username,
         u.avatar_url,
         (SELECT COUNT(DISTINCT pe.project_id)::int
          FROM project_enrollments pe WHERE pe.vault_entry_id = ve.id
         ) AS total_projects,
         COALESCE((
           SELECT COUNT(*)::int FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ve.user_id AND ts.status IN ('approved','completed')
         ), 0) AS total_completions,
         COALESCE((
           SELECT SUM(ts.profit)::float FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ve.user_id AND ts.status IN ('approved','completed')
         ), 0) AS total_profit,
         COALESCE((
           SELECT SUM(ts.cost)::float FROM task_submissions ts
           JOIN tasks t ON t.id = ts.task_id
           JOIN project_enrollments pe ON pe.project_id = t.project_id AND pe.vault_entry_id = ve.id
           WHERE ts.user_id = ve.user_id AND ts.status IN ('approved','completed')
         ), 0) AS total_cost
       FROM vault_entries ve
       JOIN users u ON u.id = ve.user_id
       LIMIT ${limitNum}`
    ));

    const entities = (rows.rows as any[]).map(r => ({
      vaultEntryId:     Number(r.vault_entry_id),
      entitySerial:     r.entity_serial as string | null,
      category:         r.category as string | null,
      username:         r.username as string,
      avatarUrl:        r.avatar_url as string | null,
      totalProjects:    Number(r.total_projects),
      totalCompletions: Number(r.total_completions),
      totalProfit:      Number(r.total_profit),
      totalCost:        Number(r.total_cost),
      totalRoi:         Number(r.total_profit) - Number(r.total_cost),
    }));

    if (sort === "completions") {
      entities.sort((a, b) => b.totalCompletions - a.totalCompletions);
    } else {
      entities.sort((a, b) => b.totalRoi - a.totalRoi);
    }

    const ranked = entities.map((e, i) => ({ ...e, rank: i + 1 }));
    res.json(ranked);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
