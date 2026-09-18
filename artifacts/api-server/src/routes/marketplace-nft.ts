import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();
const FEE_PCT = 3;
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];

async function ensureWallet(userId: number): Promise<number> {
  await pool.query(
    `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
     VALUES ($1, 'nft', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
    [userId]
  );
  const r = await pool.query(
    "SELECT balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='nft'",
    [userId]
  );
  return Number(r.rows[0]?.balance ?? 0);
}

// ── 1. GET /marketplace/nft/listings ─────────────────────────────────────────
router.get("/marketplace/nft/listings", requireAuth, async (req, res): Promise<void> => {
  const { limit = 50, offset = 0, rarity, category, min_price, max_price, sort = "newest" } = req.query as any;
  try {
    let q = `
      SELECT nl.*, u.username AS seller_username
      FROM nft_market_listings nl
      LEFT JOIN users u ON u.id = nl.seller_id
      WHERE nl.status = 'active'
    `;
    const params: any[] = [];
    if (rarity) { params.push(rarity); q += ` AND nl.rarity = $${params.length}`; }
    if (category) { params.push(category); q += ` AND nl.category = $${params.length}`; }
    if (min_price) { params.push(Number(min_price)); q += ` AND nl.price >= $${params.length}`; }
    if (max_price) { params.push(Number(max_price)); q += ` AND nl.price <= $${params.length}`; }
    if (sort === "price_asc") q += " ORDER BY nl.price ASC";
    else if (sort === "price_desc") q += " ORDER BY nl.price DESC";
    else if (sort === "popular") q += " ORDER BY nl.views DESC, nl.likes DESC";
    else q += " ORDER BY nl.created_at DESC";
    q += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const r = await pool.query(q, params);
    const cnt = await pool.query("SELECT COUNT(*) FROM nft_market_listings WHERE status='active'");
    res.json({ listings: r.rows, total: Number(cnt.rows[0].count), fee_pct: FEE_PCT });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 2. POST /marketplace/nft/listings — mint + list ──────────────────────────
router.post("/marketplace/nft/listings", requireAuth, async (req, res): Promise<void> => {
  const sellerId = req.user!.userId;
  const { name, description, image_url, price, category = "collectible", rarity = "common", collection, traits, total_supply = 1 } = req.body;
  if (!name || !price) { res.status(400).json({ error: "name and price required" }); return; }
  if (!RARITIES.includes(rarity)) { res.status(400).json({ error: "Invalid rarity" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO nft_market_listings
         (seller_id, name, description, image_url, price, category, rarity, collection, traits, total_supply, liked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]') RETURNING *`,
      [sellerId, name, description ?? null, image_url ?? null, Number(price), category, rarity, collection ?? null,
       traits ? JSON.stringify(traits) : null, Number(total_supply)]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 3. POST /marketplace/nft/buy ──────────────────────────────────────────────
router.post("/marketplace/nft/buy", requireAuth, async (req, res): Promise<void> => {
  const buyerId = req.user!.userId;
  const { listing_id } = req.body;
  if (!listing_id) { res.status(400).json({ error: "listing_id required" }); return; }
  try {
    const listR = await pool.query("SELECT * FROM nft_market_listings WHERE id=$1 AND status='active'", [listing_id]);
    if (!listR.rows[0]) { res.status(404).json({ error: "NFT not found or already sold" }); return; }
    const nft = listR.rows[0];
    if (nft.seller_id === buyerId) { res.status(400).json({ error: "Cannot buy your own NFT" }); return; }
    const balance = await ensureWallet(buyerId);
    if (balance < Number(nft.price)) { res.status(400).json({ error: "Insufficient balance in NFT wallet" }); return; }
    const fee = Number(nft.price) * (FEE_PCT / 100);
    const net = Number(nft.price) - fee;
    // Single dedicated connection for the whole transaction — see
    // routes/marketplace.ts / routes/wallets.ts for the same pattern.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Guarded by WHERE balance >= $1 — the pre-check above is just a
      // fast-fail, not the authoritative guard against a concurrent buy
      // driving the balance negative.
      const debit = await client.query(
        "UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='nft' AND balance >= $1",
        [Number(nft.price), buyerId]
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Insufficient balance in NFT wallet" }); return;
      }
      await client.query(
        "UPDATE marketplace_wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='nft'",
        [net, nft.seller_id]
      );
      const soldResult = await client.query(
        "UPDATE nft_market_listings SET status='sold', buyer_id=$1, sold_at=NOW() WHERE id=$2 AND status='active' RETURNING id",
        [buyerId, listing_id]
      );
      if (soldResult.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "NFT was already sold or cancelled" }); return;
      }
      await client.query(
        "UPDATE nft_market_listings SET views=views+1 WHERE id=$1", [listing_id]
      );
      await client.query(
        `INSERT INTO marketplace_transactions (market_type,listing_id,buyer_id,seller_id,amount,fee,net_amount)
         VALUES ('nft',$1,$2,$3,$4,$5,$6)`,
        [listing_id, buyerId, nft.seller_id, Number(nft.price), fee, net]
      );
      await client.query("COMMIT");
      res.json({ ok: true, nft_name: nft.name, price: Number(nft.price), fee, net });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 4. POST /marketplace/nft/listings/:id/like ────────────────────────────────
router.post("/marketplace/nft/listings/:id/like", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { id } = req.params;
  try {
    const r = await pool.query("SELECT liked_by FROM nft_market_listings WHERE id=$1", [id]);
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    let liked: number[] = [];
    try { liked = JSON.parse(r.rows[0].liked_by ?? "[]"); } catch {}
    const already = liked.includes(userId);
    if (already) { liked = liked.filter(x => x !== userId); } else { liked.push(userId); }
    await pool.query(
      "UPDATE nft_market_listings SET liked_by=$1, likes=$2 WHERE id=$3",
      [JSON.stringify(liked), liked.length, id]
    );
    res.json({ ok: true, liked: !already, total_likes: liked.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 5. GET /marketplace/nft/stats ─────────────────────────────────────────────
router.get("/marketplace/nft/stats", requireAuth, async (_req, res): Promise<void> => {
  try {
    const [active, volume, rarity] = await Promise.all([
      pool.query("SELECT COUNT(*) as cnt, SUM(price) as floor_sum, MIN(price) as floor FROM nft_market_listings WHERE status='active'"),
      pool.query("SELECT SUM(amount) as vol, COUNT(*) as sales FROM marketplace_transactions WHERE market_type='nft'"),
      pool.query("SELECT rarity, COUNT(*) as cnt FROM nft_market_listings WHERE status='active' GROUP BY rarity"),
    ]);
    res.json({
      active_listings: Number(active.rows[0].cnt),
      floor_price: Number(active.rows[0].floor ?? 0),
      total_volume: Number(volume.rows[0].vol ?? 0),
      total_sales: Number(volume.rows[0].sales),
      rarity_breakdown: rarity.rows,
      fee_pct: FEE_PCT,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
