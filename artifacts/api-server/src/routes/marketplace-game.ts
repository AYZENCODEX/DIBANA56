import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { getMarketConfig } from "../lib/market-config";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule, createRoleOverrideRule } from "../lib/policy/resource";
import { authorize } from "../lib/policy/pep";

const router = Router();

// ─── Route Integration Roadmap — Season C, Phase C5 (mechanical sweep, batch 5) ──
// Same "seller OR admin" shape as `marketplace-azn.ts` (this batch) — see
// that file's own header for the full rationale (Phase C1's
// `support.ts`/`tasks.ts` pattern, no `ResourceRefBuilder` needed since the
// listing is already fetched for the 404 check).
const gameListingOwnerOrAdminEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
gameListingOwnerOrAdminEngine.registerRule("resource-ownership", createResourceOwnershipRule());
gameListingOwnerOrAdminEngine.registerRule("role-override", createRoleOverrideRule(["admin"]));

async function ensureWallet(userId: number): Promise<number> {
  await pool.query(
    `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
     VALUES ($1, 'game', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
    [userId]
  );
  const r = await pool.query(
    "SELECT balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='game'",
    [userId]
  );
  return Number(r.rows[0]?.balance ?? 0);
}

function parseListing(row: any) {
  return {
    ...row,
    photos: row.photos ? JSON.parse(row.photos) : [],
    details: row.details ? JSON.parse(row.details) : {},
  };
}

// ── GET /marketplace/game/listings ───────────────────────────────────────────
router.get("/marketplace/game/listings", requireAuth, async (req, res): Promise<void> => {
  const { limit = 50, offset = 0, platform, game_name, min_price, max_price } = req.query as any;
  try {
    let q = `
      SELECT gl.*, u.username AS seller_username
      FROM game_market_listings gl
      LEFT JOIN users u ON u.id = gl.seller_id
      WHERE gl.status = 'active'
    `;
    const params: any[] = [];
    if (platform) { params.push(platform); q += ` AND gl.platform = $${params.length}`; }
    if (game_name) { params.push(`%${game_name}%`); q += ` AND gl.game_name ILIKE $${params.length}`; }
    if (min_price) { params.push(Number(min_price)); q += ` AND gl.price >= $${params.length}`; }
    if (max_price) { params.push(Number(max_price)); q += ` AND gl.price <= $${params.length}`; }
    q += ` ORDER BY gl.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const r = await pool.query(q, params);
    const cnt = await pool.query("SELECT COUNT(*) FROM game_market_listings WHERE status='active'");
    const { feePct } = await getMarketConfig("game");
    res.json({ listings: r.rows.map(parseListing), total: Number(cnt.rows[0].count), fee_pct: feePct });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /marketplace/game/listings — create a sell order ───────────────────
router.post("/marketplace/game/listings", requireAuth, async (req, res): Promise<void> => {
  const sellerId = req.user!.userId;
  const { game_name, title, description, price, platform = "pc", photos = [], details = {} } = req.body;
  if (!game_name || !String(game_name).trim()) { res.status(400).json({ error: "game_name required" }); return; }
  if (!title || !String(title).trim()) { res.status(400).json({ error: "title required" }); return; }
  if (!price || Number(price) <= 0) { res.status(400).json({ error: "valid price required" }); return; }
  if (!Array.isArray(photos)) { res.status(400).json({ error: "photos must be an array" }); return; }
  const { enabled } = await getMarketConfig("game");
  if (!enabled) { res.status(403).json({ error: "Game Market is currently disabled" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO game_market_listings
         (seller_id, game_name, title, description, price, platform, photos, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        sellerId,
        String(game_name).trim(),
        String(title).trim(),
        description ? String(description).trim() : null,
        Number(price),
        platform,
        JSON.stringify(photos),
        JSON.stringify(details ?? {}),
      ]
    );
    res.json(parseListing(r.rows[0]));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /marketplace/game/buy ───────────────────────────────────────────────
router.post("/marketplace/game/buy", requireAuth, async (req, res): Promise<void> => {
  const buyerId = req.user!.userId;
  const { listing_id } = req.body;
  if (!listing_id) { res.status(400).json({ error: "listing_id required" }); return; }
  try {
    const listR = await pool.query(
      "SELECT * FROM game_market_listings WHERE id=$1 AND status='active'",
      [listing_id]
    );
    if (!listR.rows[0]) { res.status(404).json({ error: "Listing not found or already sold" }); return; }
    const listing = listR.rows[0];
    if (listing.seller_id === buyerId) { res.status(400).json({ error: "Cannot buy your own listing" }); return; }
    const balance = await ensureWallet(buyerId);
    if (balance < Number(listing.price)) { res.status(400).json({ error: "Insufficient game wallet balance" }); return; }
    const { feePct } = await getMarketConfig("game");
    const fee = Number(listing.price) * (feePct / 100);
    const net = Number(listing.price) - fee;
    // Single dedicated connection for the whole transaction — see
    // routes/marketplace.ts / routes/wallets.ts for the same pattern.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Guarded by WHERE balance >= $1 — the pre-check above is just a
      // fast-fail, not the authoritative guard against a concurrent buy
      // driving the balance negative.
      const debit = await client.query(
        "UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='game' AND balance >= $1",
        [Number(listing.price), buyerId]
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Insufficient game wallet balance" }); return;
      }
      await client.query(
        `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
         VALUES ($1, 'game', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
        [listing.seller_id]
      );
      await client.query(
        "UPDATE marketplace_wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='game'",
        [net, listing.seller_id]
      );
      const soldResult = await client.query(
        "UPDATE game_market_listings SET status='sold', buyer_id=$1, sold_at=NOW() WHERE id=$2 AND status='active' RETURNING id",
        [buyerId, listing_id]
      );
      if (soldResult.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Listing was already sold or cancelled" }); return;
      }
      await client.query(
        `INSERT INTO marketplace_transactions (market_type,listing_id,buyer_id,seller_id,amount,fee,net_amount)
         VALUES ('game',$1,$2,$3,$4,$5,$6)`,
        [listing_id, buyerId, listing.seller_id, Number(listing.price), fee, net]
      );
      await client.query("COMMIT");
      res.json({ ok: true, title: listing.title, price: Number(listing.price), fee, net });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /marketplace/game/listings/:id ────────────────────────────────────
router.delete("/marketplace/game/listings/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const r = await pool.query("SELECT * FROM game_market_listings WHERE id=$1 AND status='active'", [id]);
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const listing = r.rows[0];
    // Phase C5: PDP-routed "owner OR admin" check, direct replacement —
    // reuses `listing.seller_id`, already fetched above; no new query.
    const ownership = await authorize({
      req,
      engine: gameListingOwnerOrAdminEngine,
      action: "marketplace.game_listing.cancel",
      resource: { type: "marketplace.game_listing", id, ownerId: listing.seller_id },
    });
    if (ownership.decision.effect !== "ALLOW") { res.status(403).json({ error: "Forbidden" }); return; }
    await pool.query("UPDATE game_market_listings SET status='cancelled' WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /marketplace/game/stats ───────────────────────────────────────────────
router.get("/marketplace/game/stats", requireAuth, async (_req, res): Promise<void> => {
  try {
    const [active, volume] = await Promise.all([
      pool.query("SELECT COUNT(*) as cnt, MIN(price) as floor, AVG(price) as avg_price FROM game_market_listings WHERE status='active'"),
      pool.query("SELECT SUM(amount) as vol, COUNT(*) as sales FROM marketplace_transactions WHERE market_type='game'"),
    ]);
    const { feePct } = await getMarketConfig("game");
    res.json({
      active_listings: Number(active.rows[0].cnt),
      floor_price: Number(active.rows[0].floor ?? 0),
      avg_price: Number(active.rows[0].avg_price ?? 0),
      total_volume: Number(volume.rows[0].vol ?? 0),
      total_sales: Number(volume.rows[0].sales),
      fee_pct: feePct,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
