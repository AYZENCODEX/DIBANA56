import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();
const PLATFORM_FEE_PCT = 5;

// `marketplace_bundles` has one owner column (`seller_id`) — same plain
// single-owner shape as `marketplace_listings` in `marketplace.ts`. Only
// `DELETE /:id` needs a gate (the other three routes are create/browse/buy,
// none of which are "is this MY existing row" checks). The handler's own
// `status='active'` condition stays exactly where it is — PEP only takes
// the ownership half, same treatment as `marketplace.ts`'s listing PATCH.
const MARKETPLACE_BUNDLE_OWNER_SENTINEL_NONE = -1;
const marketplaceBundleResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_bundle", id: req.params.id, ownerId: MARKETPLACE_BUNDLE_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT seller_id FROM marketplace_bundles WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_bundle", id, ownerId: rows[0]?.seller_id ?? MARKETPLACE_BUNDLE_OWNER_SENTINEL_NONE };
};
function requireMarketplaceBundleOwnership(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, marketplaceBundleResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

// ─── 33. POST /marketplace/bundles — create a bundle of own active listings ──
router.post("/marketplace/bundles", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { title, description, listing_ids, bundle_price_azn } = req.body;
  const ids: number[] = Array.isArray(listing_ids) ? listing_ids.map(Number) : [];
  const price = Number(bundle_price_azn);
  if (!title || ids.length < 2 || !price || price <= 0) {
    res.status(400).json({ error: "title, at least 2 listing_ids, and a positive bundle_price_azn are required" }); return;
  }
  try {
    const ownR = await pool.query(
      "SELECT id FROM marketplace_listings WHERE id = ANY($1) AND seller_id=$2 AND status='active'",
      [ids, userId]
    );
    if (ownR.rows.length !== ids.length) { res.status(400).json({ error: "All listings must be your own active listings" }); return; }
    const r = await pool.query(
      `INSERT INTO marketplace_bundles (seller_id, title, description, listing_ids, bundle_price_azn, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',NOW(),NOW()) RETURNING *`,
      [userId, title, description || null, ids, price]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 34. GET /marketplace/bundles — browse active bundles ────────────────────
router.get("/marketplace/bundles", async (req, res): Promise<void> => {
  const { limit = 50, offset = 0 } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT mb.*, u.username as seller_username
       FROM marketplace_bundles mb LEFT JOIN users u ON u.id = mb.seller_id
       WHERE mb.status = 'active'
       ORDER BY mb.created_at DESC LIMIT $1 OFFSET $2`,
      [Number(limit), Number(offset)]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 35. GET /marketplace/bundles/:id — bundle detail with its listings ──────
router.get("/marketplace/bundles/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const bR = await pool.query(
      `SELECT mb.*, u.username as seller_username FROM marketplace_bundles mb
       LEFT JOIN users u ON u.id = mb.seller_id WHERE mb.id=$1`,
      [id]
    );
    if (bR.rows.length === 0) { res.status(404).json({ error: "Bundle not found" }); return; }
    const bundle = bR.rows[0];
    const listingsR = await pool.query("SELECT * FROM marketplace_listings WHERE id = ANY($1)", [bundle.listing_ids]);
    res.json({ ...bundle, listings: listingsR.rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 36. POST /marketplace/bundles/:id/buy — buy the whole bundle at once ────
router.post("/marketplace/bundles/:id/buy", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bR = await client.query("SELECT * FROM marketplace_bundles WHERE id=$1 AND status='active' FOR UPDATE", [id]);
    if (bR.rows.length === 0) { await client.query("ROLLBACK"); res.status(404).json({ error: "Bundle not found or no longer active" }); return; }
    const bundle = bR.rows[0];
    if (bundle.seller_id === userId) { await client.query("ROLLBACK"); res.status(400).json({ error: "Cannot buy your own bundle" }); return; }

    const listingsR = await client.query(
      "SELECT * FROM marketplace_listings WHERE id = ANY($1) AND status='active' FOR UPDATE",
      [bundle.listing_ids]
    );
    if (listingsR.rows.length !== bundle.listing_ids.length) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "One or more listings in this bundle are no longer available" }); return;
    }

    const credR = await client.query("SELECT azn_balance FROM credits WHERE user_id=$1 FOR UPDATE", [userId]);
    const buyerAzn = credR.rows[0]?.azn_balance ?? 0;
    if (buyerAzn < bundle.bundle_price_azn) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Insufficient AZN balance. Need ${bundle.bundle_price_azn} AZN` }); return;
    }

    const perItemPrice = Number((bundle.bundle_price_azn / bundle.listing_ids.length).toFixed(4));
    const orders: any[] = [];
    for (const listing of listingsR.rows) {
      const orderR = await client.query(
        `INSERT INTO marketplace_orders (listing_id, buyer_id, seller_id, price_azn, fee_pct, status, message, bundle_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,NOW(),NOW()) RETURNING *`,
        [listing.id, userId, bundle.seller_id, perItemPrice, PLATFORM_FEE_PCT, `Bundle purchase: ${bundle.title}`, bundle.id]
      );
      orders.push(orderR.rows[0]);
    }
    await client.query("UPDATE credits SET azn_balance = azn_balance - $1, updated_at=NOW() WHERE user_id=$2", [bundle.bundle_price_azn, userId]);
    await client.query("UPDATE marketplace_bundles SET status='sold', updated_at=NOW() WHERE id=$1", [id]);

    await client.query("COMMIT");
    res.status(201).json({ orders, total_azn: bundle.bundle_price_azn, message: "Bundle order placed. Pending admin approval." });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── 37. DELETE /marketplace/bundles/:id — cancel own bundle ─────────────────
router.delete("/marketplace/bundles/:id", requireAuth, requireMarketplaceBundleOwnership("marketplace_bundle.delete", { error: "Bundle not found, not yours, or already resolved" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_bundles SET status='cancelled', updated_at=NOW() WHERE id=$1 AND seller_id=$2 AND status='active' RETURNING id",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Bundle not found, not yours, or already resolved" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
