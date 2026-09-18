import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

const PLATFORM_FEE_PCT = 5; // kept in sync with marketplace.ts default

// `marketplace_cart_items` rows carry their own `id` and a plain `user_id`
// owner column — this is the same "client-supplied :id + hand-rolled
// WHERE id=$1 AND user_id=$2" shape as `local_accounts.ts` (Phase C15),
// not the `favorite`-style self-scoped-by-value exclusion from Phase
// C16: `:id` here names a specific existing row another user's cart could
// also contain an id collision with, so it's a genuine ownership gate,
// not a toggle-membership operation.
const MARKETPLACE_CART_ITEM_OWNER_SENTINEL_NONE = -1;
const marketplaceCartItemResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_cart_item", id: req.params.id, ownerId: MARKETPLACE_CART_ITEM_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT user_id FROM marketplace_cart_items WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_cart_item", id, ownerId: rows[0]?.user_id ?? MARKETPLACE_CART_ITEM_OWNER_SENTINEL_NONE };
};
function requireMarketplaceCartItemOwnership(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, marketplaceCartItemResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

// Resolve the price a cart item should be charged: per-platform price if the
// listing has one set for that platform, otherwise the listing's base price.
async function resolvePrice(listingId: number, platform: string | null): Promise<number | null> {
  if (platform) {
    const p = await pool.query(
      "SELECT price_azn FROM marketplace_listing_platform_pricing WHERE listing_id=$1 AND platform=$2",
      [listingId, platform]
    );
    if (p.rows[0]) return Number(p.rows[0].price_azn);
  }
  const l = await pool.query("SELECT price_azn FROM marketplace_listings WHERE id=$1", [listingId]);
  return l.rows[0] ? Number(l.rows[0].price_azn) : null;
}

// ─── GET /marketplace/cart — current user's cart with listing details ────────
router.get("/marketplace/cart", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mc.id, mc.listing_id, mc.platform, mc.price_azn, mc.added_at,
              ml.title, ml.description, ml.listing_type, ml.image_url, ml.status as listing_status,
              ml.seller_id, u.username as seller_username
       FROM marketplace_cart_items mc
       JOIN marketplace_listings ml ON ml.id = mc.listing_id
       LEFT JOIN users u ON u.id = ml.seller_id
       WHERE mc.user_id = $1 AND mc.saved = FALSE
       ORDER BY mc.added_at DESC`,
      [userId]
    );
    const subtotal = r.rows.reduce((sum, row) => sum + Number(row.price_azn), 0);
    const feeAzn = Number(((subtotal * PLATFORM_FEE_PCT) / 100).toFixed(4));
    res.json({
      items: r.rows,
      count: r.rows.length,
      subtotal_azn: subtotal,
      fee_pct: PLATFORM_FEE_PCT,
      fee_azn: feeAzn,
      total_azn: Number((subtotal + feeAzn).toFixed(4)),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/cart/count — lightweight badge count ───────────────────
router.get("/marketplace/cart/count", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query("SELECT COUNT(*)::int as count FROM marketplace_cart_items WHERE user_id=$1 AND saved=FALSE", [userId]);
    res.json({ count: r.rows[0].count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/cart — add a listing (optionally a specific platform) ─
router.post("/marketplace/cart", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { listing_id, platform } = req.body;
  const listingId = Number(listing_id);
  if (!listingId) { res.status(400).json({ error: "listing_id is required" }); return; }

  try {
    const listingR = await pool.query("SELECT * FROM marketplace_listings WHERE id=$1 AND status='active'", [listingId]);
    if (listingR.rows.length === 0) { res.status(404).json({ error: "Listing not found or no longer active" }); return; }
    const listing = listingR.rows[0];
    if (listing.seller_id === userId) { res.status(400).json({ error: "Cannot add your own listing to cart" }); return; }

    const price = await resolvePrice(listingId, platform || null);
    if (price === null) { res.status(404).json({ error: "Listing not found" }); return; }

    const r = await pool.query(
      `INSERT INTO marketplace_cart_items (user_id, listing_id, platform, price_azn, added_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id, listing_id, platform) DO UPDATE SET price_azn = $4
       RETURNING *`,
      [userId, listingId, platform || null, price]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /marketplace/cart/:id — remove a single cart item ────────────────
router.delete("/marketplace/cart/:id", requireAuth, requireMarketplaceCartItemOwnership("marketplace_cart_item.delete", { error: "Cart item not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "DELETE FROM marketplace_cart_items WHERE id=$1 AND user_id=$2 RETURNING id",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Cart item not found" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /marketplace/cart — clear the whole cart ──────────────────────────
router.delete("/marketplace/cart", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    await pool.query("DELETE FROM marketplace_cart_items WHERE user_id=$1 AND saved=FALSE", [userId]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/cart/validate — flag stale items before checkout ──────
// A cart item is invalid if the listing was sold/cancelled/expired, or its
// price has moved since it was added.
router.get("/marketplace/cart/validate", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mc.id, mc.listing_id, mc.platform, mc.price_azn as cart_price_azn,
              ml.status as listing_status, ml.price_azn as current_price_azn,
              ml.listing_expires_at, ml.seller_id, ml.title
       FROM marketplace_cart_items mc
       JOIN marketplace_listings ml ON ml.id = mc.listing_id
       WHERE mc.user_id = $1 AND mc.saved = FALSE`,
      [userId]
    );
    const issues: any[] = [];
    for (const row of r.rows) {
      const expired = row.listing_expires_at && new Date(row.listing_expires_at) <= new Date();
      if (row.listing_status !== "active" || expired) {
        issues.push({ cart_item_id: row.id, listing_id: row.listing_id, title: row.title, reason: expired ? "expired" : `listing_${row.listing_status}` });
        continue;
      }
      if (row.seller_id === userId) {
        issues.push({ cart_item_id: row.id, listing_id: row.listing_id, title: row.title, reason: "own_listing" });
        continue;
      }
      const livePrice = row.platform
        ? Number((await pool.query("SELECT price_azn FROM marketplace_listing_platform_pricing WHERE listing_id=$1 AND platform=$2", [row.listing_id, row.platform])).rows[0]?.price_azn ?? row.current_price_azn)
        : Number(row.current_price_azn);
      if (livePrice !== Number(row.cart_price_azn)) {
        issues.push({ cart_item_id: row.id, listing_id: row.listing_id, title: row.title, reason: "price_changed", old_price_azn: Number(row.cart_price_azn), new_price_azn: livePrice });
      }
    }
    res.json({ valid: issues.length === 0, issues });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/cart/checkout — place buy orders for every cart item ──
// Same escrow pattern as the single-listing /marketplace/listings/:id/buy —
// each cart line becomes its own pending marketplace_orders row (so admin
// approval / dispute / refund flows work unchanged), all deducted from the
// buyer's AZN balance atomically, then the cart is cleared.
router.post("/marketplace/cart/checkout", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { message } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cartR = await client.query(
      `SELECT mc.id as cart_item_id, mc.listing_id, mc.platform, mc.price_azn,
              ml.status as listing_status, ml.seller_id, ml.listing_expires_at, ml.title
       FROM marketplace_cart_items mc
       JOIN marketplace_listings ml ON ml.id = mc.listing_id
       WHERE mc.user_id = $1 AND mc.saved = FALSE
       FOR UPDATE OF ml`,
      [userId]
    );

    if (cartR.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Cart is empty" }); return;
    }

    const badItems: any[] = [];
    for (const row of cartR.rows) {
      const expired = row.listing_expires_at && new Date(row.listing_expires_at) <= new Date();
      if (row.listing_status !== "active" || expired) badItems.push({ listing_id: row.listing_id, title: row.title, reason: expired ? "expired" : `listing_${row.listing_status}` });
      if (row.seller_id === userId) badItems.push({ listing_id: row.listing_id, title: row.title, reason: "own_listing" });
    }
    if (badItems.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Some cart items are no longer purchasable", issues: badItems }); return;
    }

    const total = cartR.rows.reduce((sum, row) => sum + Number(row.price_azn), 0);
    const credR = await client.query("SELECT azn_balance FROM credits WHERE user_id=$1 FOR UPDATE", [userId]);
    const buyerAzn = credR.rows[0]?.azn_balance ?? 0;
    if (buyerAzn < total) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Insufficient AZN balance. Need ${total} AZN, have ${Number(buyerAzn).toFixed(2)} AZN` }); return;
    }

    const orders: any[] = [];
    for (const row of cartR.rows) {
      const orderR = await client.query(
        `INSERT INTO marketplace_orders
          (listing_id, buyer_id, seller_id, price_azn, fee_pct, status, message, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,NOW(),NOW()) RETURNING *`,
        [row.listing_id, userId, row.seller_id, row.price_azn, PLATFORM_FEE_PCT, message || null]
      );
      orders.push(orderR.rows[0]);
    }

    await client.query("UPDATE credits SET azn_balance = azn_balance - $1, updated_at=NOW() WHERE user_id=$2", [total, userId]);
    await client.query("DELETE FROM marketplace_cart_items WHERE user_id=$1 AND saved=FALSE", [userId]);

    await client.query("COMMIT");
    res.status(201).json({ orders, total_azn: total, message: `${orders.length} order(s) placed. Pending admin approval.` });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── 48. POST /marketplace/cart/:id/save-for-later — move a cart item to saved ─
router.post("/marketplace/cart/:id/save-for-later", requireAuth, requireMarketplaceCartItemOwnership("marketplace_cart_item.save_for_later", { error: "Cart item not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_cart_items SET saved=TRUE WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Cart item not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 49. POST /marketplace/cart/saved/:id/move-to-cart — move a saved item back ─
router.post("/marketplace/cart/saved/:id/move-to-cart", requireAuth, requireMarketplaceCartItemOwnership("marketplace_cart_item.move_to_cart", { error: "Saved item not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_cart_items SET saved=FALSE WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Saved item not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
