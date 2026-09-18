import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// `earn_links` has one owner column (`user_id`) — plain single-owner
// shape. Both gated routes below always responded `{ ok: true }`
// unconditionally, win or miss, no rows-affected check at all — a
// quiet no-op for a non-owned/nonexistent id, same class as C15's
// local-accounts DELETE.
const EARN_LINK_OWNER_SENTINEL_NONE = -1;
const earnLinkResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (Number.isNaN(id)) return { type: "earn_link", id: req.params.id, ownerId: EARN_LINK_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql.raw(`SELECT user_id FROM earn_links WHERE id = ${id} LIMIT 1`));
  const row = result.rows[0] as any;
  return { type: "earn_link", id, ownerId: row?.user_id ?? EARN_LINK_OWNER_SENTINEL_NONE };
};
function requireEarnLinkOwnership(action: string) {
  return requireOwnership(action, earnLinkResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.json({ ok: true }); },
  });
}

function randomCode(n = 8): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

router.get("/earn-links", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  try {
    const r = await db.execute(sql.raw(
      `SELECT * FROM earn_links WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`
    ));
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post("/earn-links", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const { title, targetUrl, aznPerClick = 0.005 } = req.body;
  if (!targetUrl?.trim()) { res.status(400).json({ error: "targetUrl required" }); return; }
  try {
    let code = randomCode();
    const r = await db.execute(sql.raw(
      `INSERT INTO earn_links (user_id, title, target_url, code, azn_per_click)
       VALUES (${userId}, '${(title || "My Link").replace(/'/g, "''")}', '${targetUrl.trim().replace(/'/g, "''")}', '${code}', ${Math.max(0, Number(aznPerClick))})
       RETURNING *`
    ));
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.patch("/earn-links/:id", requireAuth, requireEarnLinkOwnership("earn_link.update"), async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { isActive } = req.body;
  try {
    await db.execute(sql.raw(
      `UPDATE earn_links SET is_active = ${!!isActive} WHERE id = ${id} AND user_id = ${userId}`
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.delete("/earn-links/:id", requireAuth, requireEarnLinkOwnership("earn_link.delete"), async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    await db.execute(sql.raw(`DELETE FROM earn_links WHERE id = ${id} AND user_id = ${userId}`));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get("/r/:code", requirePublicAudit("earn_link.redirect", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const code = (Array.isArray(req.params.code) ? req.params.code[0] : req.params.code ?? "").trim();
  try {
    const r = await db.execute(sql.raw(
      `SELECT * FROM earn_links WHERE code = '${code.replace(/'/g, "''")}' AND is_active = true LIMIT 1`
    ));
    const link = r.rows[0] as any;
    if (!link) { res.status(404).send("Link not found"); return; }

    const azn = Number(link.azn_per_click ?? 0.005);
    await db.execute(sql.raw(
      `UPDATE earn_links SET click_count = click_count + 1, earned_azn = earned_azn + ${azn} WHERE id = ${link.id}`
    )).catch(() => {});

    if (azn > 0 && link.user_id) {
      await db.execute(sql.raw(
        `INSERT INTO credits (user_id, balance, azn_balance, total_purchased, total_spent, created_at, updated_at)
         VALUES (${link.user_id}, 0, ${azn}, 0, 0, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + ${azn}, updated_at = NOW()`
      )).catch(() => {});
    }

    res.redirect(302, link.target_url);
  } catch { res.status(500).send("Server error"); }
});

export default router;
