import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router = Router();

// ─── 22. POST /marketplace/listings/:id/report — report a listing ────────────
router.post("/marketplace/listings/:id/report", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  const { reason, details } = req.body;
  if (!reason) { res.status(400).json({ error: "reason is required" }); return; }
  try {
    const listingR = await pool.query("SELECT id FROM marketplace_listings WHERE id=$1", [listingId]);
    if (listingR.rows.length === 0) { res.status(404).json({ error: "Listing not found" }); return; }
    const r = await pool.query(
      `INSERT INTO marketplace_reports (listing_id, reporter_id, reason, details, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',NOW()) RETURNING *`,
      [listingId, userId, reason, details || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 23. GET /admin/marketplace/reports — moderation queue ───────────────────
router.get("/admin/marketplace/reports", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { status = "pending" } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT mr.*, ml.title as listing_title, u.username as reporter_username
       FROM marketplace_reports mr
       LEFT JOIN marketplace_listings ml ON ml.id = mr.listing_id
       LEFT JOIN users u ON u.id = mr.reporter_id
       WHERE mr.status = $1
       ORDER BY mr.created_at ASC`,
      [status]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 24. PATCH /admin/marketplace/reports/:id — resolve a report ─────────────
// action: "dismiss" | "remove_listing"
router.patch("/admin/marketplace/reports/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { action, admin_note } = req.body;
  if (!["dismiss", "remove_listing"].includes(action)) { res.status(400).json({ error: "action must be 'dismiss' or 'remove_listing'" }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reportR = await client.query("SELECT * FROM marketplace_reports WHERE id=$1 AND status='pending' FOR UPDATE", [id]);
    if (reportR.rows.length === 0) { await client.query("ROLLBACK"); res.status(404).json({ error: "Pending report not found" }); return; }
    const report = reportR.rows[0];
    if (action === "remove_listing" && report.listing_id) {
      await client.query("UPDATE marketplace_listings SET status='removed', updated_at=NOW() WHERE id=$1", [report.listing_id]);
    }
    await client.query(
      "UPDATE marketplace_reports SET status='resolved', admin_note=$1, resolved_at=NOW() WHERE id=$2",
      [admin_note || action, id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, action });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── 25. GET /marketplace/reports/my — user's own submitted reports ──────────
router.get("/marketplace/reports/my", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mr.*, ml.title as listing_title FROM marketplace_reports mr
       LEFT JOIN marketplace_listings ml ON ml.id = mr.listing_id
       WHERE mr.reporter_id = $1 ORDER BY mr.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 26. POST /marketplace/sellers/:id/report — report a seller/user directly ─
router.post("/marketplace/sellers/:id/report", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const sellerId = Number(req.params.id);
  const { reason, details } = req.body;
  if (!reason) { res.status(400).json({ error: "reason is required" }); return; }
  if (sellerId === userId) { res.status(400).json({ error: "Cannot report yourself" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO marketplace_reports (reported_user_id, reporter_id, reason, details, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',NOW()) RETURNING *`,
      [sellerId, userId, reason, details || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
