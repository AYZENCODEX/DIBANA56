import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();

// ─── 44. GET /marketplace/listings/:id/similar — related listings ────────────
router.get("/marketplace/listings/:id/similar", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const baseR = await pool.query("SELECT listing_type, price_azn FROM marketplace_listings WHERE id=$1", [id]);
    if (baseR.rows.length === 0) { res.status(404).json({ error: "Listing not found" }); return; }
    const base = baseR.rows[0];
    const r = await pool.query(
      `SELECT * FROM marketplace_listings
       WHERE id <> $1 AND status='active' AND listing_type=$2
       ORDER BY ABS(price_azn - $3) ASC LIMIT 10`,
      [id, base.listing_type, base.price_azn]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 45. GET /marketplace/trending — most-viewed active listings recently ────
router.get("/marketplace/trending", async (req, res): Promise<void> => {
  const { limit = 10 } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT * FROM marketplace_listings
       WHERE status='active' AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY view_count DESC, created_at DESC LIMIT $1`,
      [Number(limit)]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 46. GET /marketplace/categories — distinct listing types + counts ───────
router.get("/marketplace/categories", async (_req, res): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT listing_type, COUNT(*)::int as count
       FROM marketplace_listings WHERE status='active'
       GROUP BY listing_type ORDER BY count DESC`
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 47. GET /marketplace/listings/featured — public featured listings shelf ─
router.get("/marketplace/listings/featured", async (req, res): Promise<void> => {
  const { limit = 12 } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT ml.*, u.username as seller_username
       FROM marketplace_listings ml LEFT JOIN users u ON u.id = ml.seller_id
       WHERE ml.status='active' AND ml.is_featured=TRUE
         AND (ml.featured_until IS NULL OR ml.featured_until > NOW())
       ORDER BY ml.created_at DESC LIMIT $1`,
      [Number(limit)]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
