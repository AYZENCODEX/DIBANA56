import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router = Router();

// ─── 16. POST /admin/marketplace/coupons — create a coupon ───────────────────
router.post("/admin/marketplace/coupons", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { code, discount_type, discount_value, max_uses, min_purchase_azn, expires_at } = req.body;
  if (!code || !["percent", "fixed"].includes(discount_type) || !discount_value) {
    res.status(400).json({ error: "code, discount_type ('percent'|'fixed'), discount_value are required" }); return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO marketplace_coupons
        (code, discount_type, discount_value, max_uses, min_purchase_azn, expires_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) RETURNING *`,
      [code.toUpperCase(), discount_type, Number(discount_value), max_uses ? Number(max_uses) : null,
        min_purchase_azn ? Number(min_purchase_azn) : 0, expires_at || null, userId]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 17. GET /admin/marketplace/coupons — list all coupons ───────────────────
router.get("/admin/marketplace/coupons", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM marketplace_coupons ORDER BY created_at DESC");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 18. PATCH /admin/marketplace/coupons/:id — update or disable a coupon ───
router.patch("/admin/marketplace/coupons/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { discount_value, max_uses, min_purchase_azn, expires_at, is_active } = req.body;
  const sets: string[] = []; const params: any[] = [];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (discount_value !== undefined) push("discount_value", Number(discount_value));
  if (max_uses !== undefined) push("max_uses", max_uses === null ? null : Number(max_uses));
  if (min_purchase_azn !== undefined) push("min_purchase_azn", Number(min_purchase_azn));
  if (expires_at !== undefined) push("expires_at", expires_at);
  if (is_active !== undefined) push("is_active", !!is_active);
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  sets.push("updated_at=NOW()");
  try {
    params.push(id);
    const r = await pool.query(`UPDATE marketplace_coupons SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
    if (r.rows.length === 0) { res.status(404).json({ error: "Coupon not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 19. DELETE /admin/marketplace/coupons/:id — delete a coupon ─────────────
router.delete("/admin/marketplace/coupons/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query("DELETE FROM marketplace_coupons WHERE id=$1 RETURNING id", [id]);
    if (r.rows.length === 0) { res.status(404).json({ error: "Coupon not found" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 20. POST /marketplace/coupons/validate — check a code for the current user ─
router.post("/marketplace/coupons/validate", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { code, subtotal_azn } = req.body;
  if (!code) { res.status(400).json({ error: "code is required" }); return; }
  try {
    const c = await pool.query(
      "SELECT * FROM marketplace_coupons WHERE code=$1 AND is_active=TRUE",
      [String(code).toUpperCase()]
    );
    if (c.rows.length === 0) { res.status(404).json({ error: "Invalid or inactive coupon" }); return; }
    const coupon = c.rows[0];
    if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) { res.status(400).json({ error: "Coupon has expired" }); return; }
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) { res.status(400).json({ error: "Coupon usage limit reached" }); return; }
    const usedR = await pool.query("SELECT id FROM marketplace_coupon_usage WHERE coupon_id=$1 AND user_id=$2", [coupon.id, userId]);
    if (usedR.rows.length > 0) { res.status(400).json({ error: "You have already used this coupon" }); return; }
    const subtotal = Number(subtotal_azn) || 0;
    if (subtotal < Number(coupon.min_purchase_azn)) {
      res.status(400).json({ error: `Minimum purchase of ${coupon.min_purchase_azn} AZN required` }); return;
    }
    const discount = coupon.discount_type === "percent"
      ? Number(((subtotal * coupon.discount_value) / 100).toFixed(4))
      : Math.min(Number(coupon.discount_value), subtotal);
    res.json({ valid: true, coupon: { code: coupon.code, discount_type: coupon.discount_type, discount_value: coupon.discount_value }, discount_azn: discount, total_after_discount_azn: Number((subtotal - discount).toFixed(4)) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 21. POST /marketplace/cart/apply-coupon — preview coupon discount on current cart ─
router.post("/marketplace/cart/apply-coupon", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { code } = req.body;
  if (!code) { res.status(400).json({ error: "code is required" }); return; }
  try {
    const cartR = await pool.query("SELECT COALESCE(SUM(price_azn),0) as subtotal FROM marketplace_cart_items WHERE user_id=$1", [userId]);
    const subtotal = Number(cartR.rows[0].subtotal);
    if (subtotal <= 0) { res.status(400).json({ error: "Cart is empty" }); return; }

    const c = await pool.query("SELECT * FROM marketplace_coupons WHERE code=$1 AND is_active=TRUE", [String(code).toUpperCase()]);
    if (c.rows.length === 0) { res.status(404).json({ error: "Invalid or inactive coupon" }); return; }
    const coupon = c.rows[0];
    if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) { res.status(400).json({ error: "Coupon has expired" }); return; }
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) { res.status(400).json({ error: "Coupon usage limit reached" }); return; }
    const usedR = await pool.query("SELECT id FROM marketplace_coupon_usage WHERE coupon_id=$1 AND user_id=$2", [coupon.id, userId]);
    if (usedR.rows.length > 0) { res.status(400).json({ error: "You have already used this coupon" }); return; }
    if (subtotal < Number(coupon.min_purchase_azn)) { res.status(400).json({ error: `Minimum purchase of ${coupon.min_purchase_azn} AZN required` }); return; }

    const discount = coupon.discount_type === "percent"
      ? Number(((subtotal * coupon.discount_value) / 100).toFixed(4))
      : Math.min(Number(coupon.discount_value), subtotal);
    res.json({ subtotal_azn: subtotal, discount_azn: discount, total_azn: Number((subtotal - discount).toFixed(4)) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
