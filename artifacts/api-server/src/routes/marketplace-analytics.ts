import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";

const router = Router();

// ─── 27. GET /marketplace/analytics/overview — seller's own sales overview ───
router.get("/marketplace/analytics/overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM marketplace_listings WHERE seller_id=$1 AND status='active') as active_listings,
        (SELECT COUNT(*)::int FROM marketplace_listings WHERE seller_id=$1 AND status='sold') as sold_listings,
        (SELECT COUNT(*)::int FROM marketplace_orders WHERE seller_id=$1 AND status='completed') as completed_sales,
        (SELECT COALESCE(SUM(seller_receives),0) FROM marketplace_orders WHERE seller_id=$1 AND status IN ('approved','completed')) as total_earned_azn,
        (SELECT COALESCE(AVG(rating),0)::float FROM marketplace_reviews WHERE seller_id=$1) as avg_rating,
        (SELECT COUNT(*)::int FROM marketplace_reviews WHERE seller_id=$1) as review_count`,
      [userId]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 28. GET /marketplace/analytics/revenue — seller revenue over time ───────
// PHASE 5: metered action verve.premium_analytics — the seller's basic
// overview (above) stays free, this time-series breakdown is the "premium
// analytics" line from the master plan's §5 metered-actions table.
router.get("/marketplace/analytics/revenue", requireAuth, requireCreditBalance("verve.premium_analytics"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { days = 30 } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT DATE(resolved_at) as date, COALESCE(SUM(seller_receives),0) as revenue_azn, COUNT(*)::int as orders
       FROM marketplace_orders
       WHERE seller_id=$1 AND status IN ('approved','completed') AND resolved_at >= NOW() - ($2 || ' days')::interval
       GROUP BY DATE(resolved_at) ORDER BY date ASC`,
      [userId, String(Number(days))]
    );
    await chargeCredits(userId, "verve.premium_analytics");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 29. GET /marketplace/analytics/top-listings — best performing listings ──
// PHASE 5: metered action verve.premium_analytics (same as /revenue above).
router.get("/marketplace/analytics/top-listings", requireAuth, requireCreditBalance("verve.premium_analytics"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT ml.id, ml.title, ml.view_count,
              COUNT(mo.id) FILTER (WHERE mo.status IN ('approved','completed'))::int as sales_count,
              COALESCE(SUM(mo.seller_receives) FILTER (WHERE mo.status IN ('approved','completed')),0) as revenue_azn
       FROM marketplace_listings ml
       LEFT JOIN marketplace_orders mo ON mo.listing_id = ml.id
       WHERE ml.seller_id = $1
       GROUP BY ml.id ORDER BY revenue_azn DESC LIMIT 10`,
      [userId]
    );
    await chargeCredits(userId, "verve.premium_analytics");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 30. GET /marketplace/listings/:id/views — a listing's view count ────────
router.get("/marketplace/listings/:id/views", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query("SELECT view_count FROM marketplace_listings WHERE id=$1", [id]);
    if (r.rows.length === 0) { res.status(404).json({ error: "Listing not found" }); return; }
    res.json({ listing_id: id, view_count: r.rows[0].view_count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 31. POST /marketplace/listings/:id/view — record a view (public, best-effort) ─
router.post("/marketplace/listings/:id/view", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_listings SET view_count = view_count + 1 WHERE id=$1 RETURNING view_count",
      [id]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Listing not found" }); return; }
    res.json({ view_count: r.rows[0].view_count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 32. GET /admin/marketplace/analytics/platform — platform-wide analytics ─
router.get("/admin/marketplace/analytics/platform", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { days = 30 } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT DATE(resolved_at) as date, COUNT(*)::int as orders,
              COALESCE(SUM(price_azn),0) as volume_azn, COALESCE(SUM(fee_azn),0) as fees_azn
       FROM marketplace_orders
       WHERE status IN ('approved','completed') AND resolved_at >= NOW() - ($1 || ' days')::interval
       GROUP BY DATE(resolved_at) ORDER BY date ASC`,
      [String(Number(days))]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
