import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule, createRoleOverrideRule } from "../lib/policy/resource";
import { authorize } from "../lib/policy/pep";

const router = Router();
const FEE_PCT = 2.5;

// ─── Route Integration Roadmap — Season C, Phase C5 (mechanical sweep, batch 5) ──
// Grep for `userId !== `/`!== .*userId` (the same audit every prior batch
// ran) turned up one hit here — `DELETE /marketplace/azn/listings/:id`'s
// "seller, OR an admin, may cancel" check — the exact same shape Phase
// C1's `support.ts`/`tasks.ts` already established
// (`createResourceOwnershipRule()` OR `createRoleOverrideRule(["admin"])`,
// one shared engine). This file (and the rest of this batch —
// `marketplace-game.ts`/`marketplace-usdt.ts`/`marketplace-vault.ts`, all
// four `marketplace-*.ts` files the grep matched other than
// `marketplace-nft.ts`'s false positive — see the batch's own CHANGES doc)
// has no Drizzle table objects at all (raw `pool.query`, unlike
// `support.ts`), so the engine is wired the same way but the
// `ResourceRefBuilder`/DB-lookup machinery `finance.ts`/`teams.ts` needed
// is not — the listing is already fetched by the handler (for the 404
// check, and — sell listings — the wallet-refund logic right after), so
// this is a direct-replacement inline `authorize()` reusing that row's own
// `seller_id`, no new query. Same "already-fetched field, direct
// replacement" shape Phase C3/C4 already used for their own already-loaded
// rows.
const aznListingOwnerOrAdminEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
aznListingOwnerOrAdminEngine.registerRule("resource-ownership", createResourceOwnershipRule());
aznListingOwnerOrAdminEngine.registerRule("role-override", createRoleOverrideRule(["admin"]));

async function ensureWallet(userId: number, type = "azn"): Promise<{ balance: number; locked: number }> {
  await pool.query(
    `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
     VALUES ($1, $2, 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
    [userId, type]
  );
  const r = await pool.query(
    "SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type=$2",
    [userId, type]
  );
  return { balance: Number(r.rows[0]?.balance ?? 0), locked: Number(r.rows[0]?.locked_balance ?? 0) };
}

// ── GET /marketplace/azn/listings ─────────────────────────────────────────────
router.get("/marketplace/azn/listings", requireAuth, async (req, res): Promise<void> => {
  const { limit = 50, offset = 0, order_type } = req.query as any;
  try {
    let q = `
      SELECT al.*, u.username AS seller_username
      FROM azn_listings al
      LEFT JOIN users u ON u.id = al.seller_id
      WHERE al.status = 'active'
    `;
    const params: any[] = [];
    if (order_type) { params.push(order_type); q += ` AND al.order_type = $${params.length}`; }
    q += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const r = await pool.query(q, params);
    const total = await pool.query("SELECT COUNT(*) FROM azn_listings WHERE status='active'");
    res.json({ listings: r.rows, total: Number(total.rows[0].count), fee_pct: FEE_PCT });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /marketplace/azn/listings ────────────────────────────────────────────
// order_type: 'sell' | 'buy'
// payment_method: 'binance' | 'bkash' | 'nagad'
// payment_details: string (account number / UID / wallet address)
router.post("/marketplace/azn/listings", requireAuth, async (req, res): Promise<void> => {
  const sellerId = req.user!.userId;
  const {
    amount,
    price_per_unit,
    order_type = "sell",
    payment_method = "binance",
    payment_details = "",
    min_buy = 0,
  } = req.body;
  if (!amount || !price_per_unit) { res.status(400).json({ error: "amount and price_per_unit required" }); return; }
  if (!["binance", "bkash", "nagad"].includes(payment_method)) {
    res.status(400).json({ error: "Invalid payment method" }); return;
  }
  if (!String(payment_details).trim()) {
    res.status(400).json({ error: "payment_details is required (account number / UID / wallet address)" }); return;
  }
  const totalPrice = Number(amount) * Number(price_per_unit);
  try {
    if (order_type === "sell") {
      // For sell orders: lock AZN in marketplace wallet
      const { balance } = await ensureWallet(sellerId, "azn");
      if (balance < Number(amount)) {
        res.status(400).json({ error: "Insufficient AZN balance in marketplace wallet" }); return;
      }
      await pool.query(
        "UPDATE marketplace_wallets SET balance=balance-$1, locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'",
        [Number(amount), sellerId]
      );
    }
    const r = await pool.query(
      `INSERT INTO azn_listings (seller_id, amount, price_per_unit, total_price, currency, min_buy, order_type, payment_method, payment_details)
       VALUES ($1,$2,$3,$4,'AZN',$5,$6,$7,$8) RETURNING *`,
      [sellerId, Number(amount), Number(price_per_unit), totalPrice, Number(min_buy),
       order_type, payment_method, String(payment_details).trim()]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /marketplace/azn/buy ─────────────────────────────────────────────────
// Buy from a sell listing (AZN wallet-based)
router.post("/marketplace/azn/buy", requireAuth, async (req, res): Promise<void> => {
  const buyerId = req.user!.userId;
  const { listing_id, amount } = req.body;
  if (!listing_id || !amount) { res.status(400).json({ error: "listing_id and amount required" }); return; }
  try {
    const listingR = await pool.query("SELECT * FROM azn_listings WHERE id=$1 AND status='active' AND order_type='sell'", [listing_id]);
    if (!listingR.rows[0]) { res.status(404).json({ error: "Listing not found or sold" }); return; }
    const listing = listingR.rows[0];
    if (listing.seller_id === buyerId) { res.status(400).json({ error: "Cannot buy your own listing" }); return; }
    if (Number(amount) < Number(listing.min_buy)) { res.status(400).json({ error: `Minimum buy is ${listing.min_buy} AZN` }); return; }
    if (Number(amount) > Number(listing.amount)) { res.status(400).json({ error: "Amount exceeds listing" }); return; }
    const cost = Number(amount) * Number(listing.price_per_unit);
    const { balance: buyerBalance } = await ensureWallet(buyerId, "azn");
    if (buyerBalance < cost) { res.status(400).json({ error: "Insufficient balance" }); return; }
    const fee = cost * (FEE_PCT / 100);
    const net = cost - fee;
    const remaining = Number(listing.amount) - Number(amount);

    // Single dedicated connection for the whole transaction — pool.query()
    // scatters BEGIN/COMMIT/ROLLBACK and the statements between them across
    // whichever connection happens to be free, silently breaking atomicity
    // under concurrent requests (see routes/marketplace.ts / routes/wallets
    // .ts for the same pool.connect() pattern used elsewhere).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Guarded by WHERE balance >= $1 — the buyerBalance check above is
      // just a fast-fail pre-check, not the authoritative guard; two
      // concurrent buys against the same wallet could both pass a stale
      // pre-check otherwise and drive the balance negative.
      const debit = await client.query(
        "UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn' AND balance >= $1",
        [cost, buyerId]
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Insufficient balance" }); return;
      }
      await client.query(
        "UPDATE marketplace_wallets SET locked_balance=locked_balance-$1, balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'",
        [Number(amount), listing.seller_id]
      );
      await client.query(
        "UPDATE marketplace_wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'",
        [Number(amount), buyerId]
      );
      if (remaining <= 0) {
        await client.query("UPDATE azn_listings SET status='sold', buyer_id=$1, sold_at=NOW() WHERE id=$2", [buyerId, listing_id]);
      } else {
        await client.query(
          "UPDATE azn_listings SET amount=$1, total_price=$2 WHERE id=$3",
          [remaining, remaining * Number(listing.price_per_unit), listing_id]
        );
      }
      await client.query(
        `INSERT INTO marketplace_transactions (market_type,listing_id,buyer_id,seller_id,amount,fee,net_amount)
         VALUES ('azn',$1,$2,$3,$4,$5,$6)`,
        [listing_id, buyerId, listing.seller_id, cost, fee, net]
      );
      await client.query("COMMIT");
      res.json({ ok: true, amount_bought: Number(amount), cost, fee, net, payment_method: listing.payment_method, payment_details: listing.payment_details });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /marketplace/azn/listings/:id ──────────────────────────────────────
router.delete("/marketplace/azn/listings/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const r = await pool.query("SELECT * FROM azn_listings WHERE id=$1 AND status='active'", [id]);
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const listing = r.rows[0];
    // Phase C5: PDP-routed "owner OR admin" check, direct replacement —
    // reuses `listing.seller_id`, already fetched above; no new query.
    const ownership = await authorize({
      req,
      engine: aznListingOwnerOrAdminEngine,
      action: "marketplace.azn_listing.cancel",
      resource: { type: "marketplace.azn_listing", id, ownerId: listing.seller_id },
    });
    if (ownership.decision.effect !== "ALLOW") { res.status(403).json({ error: "Forbidden" }); return; }
    await pool.query("UPDATE azn_listings SET status='cancelled' WHERE id=$1", [id]);
    if (listing.order_type === "sell" || !listing.order_type) {
      await pool.query(
        "UPDATE marketplace_wallets SET locked_balance=locked_balance-$1, balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'",
        [Number(listing.amount), listing.seller_id]
      );
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /marketplace/azn/stats ────────────────────────────────────────────────
router.get("/marketplace/azn/stats", requireAuth, async (_req, res): Promise<void> => {
  try {
    const [sell, buy, volume] = await Promise.all([
      pool.query("SELECT COUNT(*) as cnt, SUM(amount) as total_azn FROM azn_listings WHERE status='active' AND (order_type='sell' OR order_type IS NULL)"),
      pool.query("SELECT COUNT(*) as cnt FROM azn_listings WHERE status='active' AND order_type='buy'"),
      pool.query("SELECT SUM(amount) as vol, COUNT(*) as trades FROM marketplace_transactions WHERE market_type='azn'"),
    ]);
    res.json({
      active_sell_listings: Number(sell.rows[0].cnt),
      active_buy_listings: Number(buy.rows[0].cnt),
      available_azn: Number(sell.rows[0].total_azn ?? 0),
      total_volume: Number(volume.rows[0].vol ?? 0),
      total_trades: Number(volume.rows[0].trades),
      fee_pct: FEE_PCT,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
