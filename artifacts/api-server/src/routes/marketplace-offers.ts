import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { marketplaceListingResource } from "./marketplace";
import { notifyVerveOfferReceived } from "../lib/notification-bus";

// Route Integration Roadmap — Season E, Phase E6.
// `GET /marketplace/listings/:id/offers` (below) was raw-SQL-scoped only
// (`ml.seller_id = $2` in the JOIN) with no PEP wiring — `marketplace.ts`
// already has exactly this table/owner-column shape wired
// (`marketplaceListingResource`, now exported for this reuse), so no new
// builder is written here. Pre-existing behavior for a non-owner or
// nonexistent listing id was a 200 with an empty array (the JOIN just
// matches nothing) — `onDeny` reproduces that exactly, per the Guide's
// "silent no-op" deny shape, not a 404 (that would be new behavior).
function requireMarketplaceListingOffersOwnership(action: string) {
  return requireOwnership(action, marketplaceListingResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.json([]); },
  });
}

const router = Router();
const PLATFORM_FEE_PCT = 5;

// `marketplace_offers` has two owner columns (`buyer_id`, `seller_id`),
// but unlike `marketplace_orders` in `marketplace.ts` there's no route here
// that lets either party act — each route below checks exactly one
// specific column, consistently: accept/reject/counter are seller-only,
// delete (withdraw) is buyer-only. So this doesn't need the
// party-resource OR-trick, just two separate single-owner builders.
const MARKETPLACE_OFFER_OWNER_SENTINEL_NONE = -1;
const marketplaceOfferSellerResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_offer", id: req.params.id, ownerId: MARKETPLACE_OFFER_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT seller_id FROM marketplace_offers WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_offer", id, ownerId: rows[0]?.seller_id ?? MARKETPLACE_OFFER_OWNER_SENTINEL_NONE };
};
const marketplaceOfferBuyerResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_offer", id: req.params.id, ownerId: MARKETPLACE_OFFER_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT buyer_id FROM marketplace_offers WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_offer", id, ownerId: rows[0]?.buyer_id ?? MARKETPLACE_OFFER_OWNER_SENTINEL_NONE };
};
function requireMarketplaceOfferOwnership(resource: ResourceRefBuilder, action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, resource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

// ─── 8. POST /marketplace/listings/:id/offers — buyer makes an offer ─────────
router.post("/marketplace/listings/:id/offers", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  const { offer_price_azn, message } = req.body;
  const price = Number(offer_price_azn);
  if (!price || price <= 0) { res.status(400).json({ error: "offer_price_azn must be a positive number" }); return; }
  try {
    const listingR = await pool.query("SELECT * FROM marketplace_listings WHERE id=$1 AND status='active'", [listingId]);
    if (listingR.rows.length === 0) { res.status(404).json({ error: "Listing not found or no longer active" }); return; }
    const listing = listingR.rows[0];
    if (listing.seller_id === userId) { res.status(400).json({ error: "Cannot make an offer on your own listing" }); return; }
    const r = await pool.query(
      `INSERT INTO marketplace_offers (listing_id, buyer_id, seller_id, offer_price_azn, message, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW(),NOW()) RETURNING *`,
      [listingId, userId, listing.seller_id, price, message || null]
    );
    // Phase 7 — Notification Bus. This route previously created the offer
    // row and stopped there — the seller had no way to find out short of
    // polling "My Listings" themselves. This is the "Verve offer received"
    // event master plan §6 names by name.
    const buyerR = await pool.query("SELECT username FROM users WHERE id=$1", [userId]);
    notifyVerveOfferReceived(listing.seller_id, listing.title, price, buyerR.rows[0]?.username ?? "Someone").catch(() => {});
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 9. GET /marketplace/listings/:id/offers — seller views offers on own listing ─
router.get("/marketplace/listings/:id/offers", requireAuth, requireMarketplaceListingOffersOwnership("marketplace_listing.offers.list"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  try {
    const r = await pool.query(
      `SELECT mo.*, u.username as buyer_username
       FROM marketplace_offers mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users u ON u.id = mo.buyer_id
       WHERE mo.listing_id = $1 AND ml.seller_id = $2
       ORDER BY mo.created_at DESC`,
      [listingId, userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 10. GET /marketplace/offers/my — buyer's sent offers ────────────────────
router.get("/marketplace/offers/my", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.image_url, su.username as seller_username
       FROM marketplace_offers mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.buyer_id = $1 ORDER BY mo.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 11. GET /marketplace/offers/received — seller's received offers ─────────
router.get("/marketplace/offers/received", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.image_url, bu.username as buyer_username
       FROM marketplace_offers mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       WHERE mo.seller_id = $1 ORDER BY mo.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 12. POST /marketplace/offers/:id/accept — seller accepts, creates an order ─
router.post("/marketplace/offers/:id/accept", requireAuth, requireMarketplaceOfferOwnership(marketplaceOfferSellerResource, "marketplace_offer.accept", { error: "Offer not found, not yours, or already resolved" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const offerR = await client.query(
      "SELECT * FROM marketplace_offers WHERE id=$1 AND seller_id=$2 AND status='pending' FOR UPDATE",
      [id, userId]
    );
    if (offerR.rows.length === 0) { await client.query("ROLLBACK"); res.status(404).json({ error: "Offer not found, not yours, or already resolved" }); return; }
    const offer = offerR.rows[0];

    const credR = await client.query("SELECT azn_balance FROM credits WHERE user_id=$1 FOR UPDATE", [offer.buyer_id]);
    const buyerAzn = credR.rows[0]?.azn_balance ?? 0;
    if (buyerAzn < offer.offer_price_azn) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Buyer no longer has enough AZN balance for this offer" }); return;
    }

    const orderR = await client.query(
      `INSERT INTO marketplace_orders (listing_id, buyer_id, seller_id, price_azn, fee_pct, status, message, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,NOW(),NOW()) RETURNING *`,
      [offer.listing_id, offer.buyer_id, offer.seller_id, offer.offer_price_azn, PLATFORM_FEE_PCT, `Accepted offer #${offer.id}`]
    );
    await client.query("UPDATE credits SET azn_balance = azn_balance - $1, updated_at=NOW() WHERE user_id=$2", [offer.offer_price_azn, offer.buyer_id]);
    await client.query("UPDATE marketplace_offers SET status='accepted', updated_at=NOW() WHERE id=$1", [id]);
    await client.query(
      "UPDATE marketplace_offers SET status='rejected', updated_at=NOW() WHERE listing_id=$1 AND id<>$2 AND status='pending'",
      [offer.listing_id, id]
    );

    await client.query("COMMIT");
    res.json({ order: orderR.rows[0], message: "Offer accepted. Order placed, pending admin approval." });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── 13. POST /marketplace/offers/:id/reject — seller rejects ────────────────
router.post("/marketplace/offers/:id/reject", requireAuth, requireMarketplaceOfferOwnership(marketplaceOfferSellerResource, "marketplace_offer.reject", { error: "Offer not found, not yours, or already resolved" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_offers SET status='rejected', updated_at=NOW() WHERE id=$1 AND seller_id=$2 AND status='pending' RETURNING *",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Offer not found, not yours, or already resolved" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 14. POST /marketplace/offers/:id/counter — seller counters with a new price ─
router.post("/marketplace/offers/:id/counter", requireAuth, requireMarketplaceOfferOwnership(marketplaceOfferSellerResource, "marketplace_offer.counter", { error: "Offer not found, not yours, or already resolved" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { counter_price_azn, message } = req.body;
  const price = Number(counter_price_azn);
  if (!price || price <= 0) { res.status(400).json({ error: "counter_price_azn must be a positive number" }); return; }
  try {
    const r = await pool.query(
      `UPDATE marketplace_offers SET status='countered', counter_price_azn=$1, counter_message=$2, updated_at=NOW()
       WHERE id=$3 AND seller_id=$4 AND status='pending' RETURNING *`,
      [price, message || null, id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Offer not found, not yours, or already resolved" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 15. DELETE /marketplace/offers/:id — buyer withdraws own offer ──────────
router.delete("/marketplace/offers/:id", requireAuth, requireMarketplaceOfferOwnership(marketplaceOfferBuyerResource, "marketplace_offer.delete", { error: "Offer not found, not yours, or cannot be withdrawn" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_offers SET status='withdrawn', updated_at=NOW() WHERE id=$1 AND buyer_id=$2 AND status IN ('pending','countered') RETURNING id",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Offer not found, not yours, or cannot be withdrawn" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
