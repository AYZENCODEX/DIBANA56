import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();
const MARKET_TYPES = ["azn", "nft", "vault", "game"] as const;

async function ensureAllWallets(userId: number) {
  for (const t of MARKET_TYPES) {
    await pool.query(
      `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
       VALUES ($1, $2, 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
      [userId, t]
    );
  }
}

// ── 1. GET /marketplace/wallet — all 3 wallets for current user ───────────────
router.get("/marketplace/wallet", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    await ensureAllWallets(userId);
    const r = await pool.query(
      "SELECT * FROM marketplace_wallets WHERE user_id=$1 ORDER BY market_type",
      [userId]
    );
    const wallets: Record<string, any> = {};
    for (const row of r.rows) {
      wallets[row.market_type] = {
        balance: Number(row.balance),
        locked_balance: Number(row.locked_balance),
        available: Number(row.balance) - Number(row.locked_balance),
        address: row.address ?? generateAddress(userId, row.market_type),
        updated_at: row.updated_at,
      };
    }
    res.json(wallets);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function generateAddress(userId: number, type: string) {
  const seed = `${userId}-${type}-ayzen`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) { hash = ((hash << 5) - hash + seed.charCodeAt(i)) >>> 0; }
  return `0xMKT${hash.toString(16).padStart(8, "0").toUpperCase()}${type.toUpperCase()}`;
}

// ── 2. POST /marketplace/wallet/:type/deposit — deposit from main AZN balance ──
router.post("/marketplace/wallet/:type/deposit", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { type } = req.params;
  const { amount } = req.body;
  if (!MARKET_TYPES.includes(type as any)) { res.status(400).json({ error: "Invalid market type" }); return; }
  if (!amount || Number(amount) <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }
  try {
    const credR = await pool.query("SELECT azn_balance FROM credits WHERE user_id=$1", [userId]);
    if (!credR.rows[0] || Number(credR.rows[0].azn_balance) < Number(amount)) {
      res.status(400).json({ error: "Insufficient AZN balance in main wallet" }); return;
    }
    // Single dedicated connection for the whole transaction — see
    // routes/marketplace.ts / routes/wallets.ts for the same pattern;
    // pool.query("BEGIN") followed by more pool.query() calls can scatter
    // the statements across different pooled connections and silently
    // break atomicity under concurrent requests.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Guarded by WHERE azn_balance >= $1 — the pre-check above is just a
      // fast-fail, not the authoritative guard against a concurrent deposit
      // draining the same main balance twice.
      const debit = await client.query(
        "UPDATE credits SET azn_balance=azn_balance-$1 WHERE user_id=$2 AND azn_balance >= $1",
        [Number(amount), userId]
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Insufficient AZN balance in main wallet" }); return;
      }
      await ensureAllWallets(userId);
      await client.query(
        "UPDATE marketplace_wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type=$3",
        [Number(amount), userId, type]
      );
      const r = await client.query(
        "SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type=$2",
        [userId, type]
      );
      await client.query("COMMIT");
      res.json({ ok: true, balance: Number(r.rows[0].balance), deposited: Number(amount) });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 3. POST /marketplace/wallet/:type/withdraw — withdraw back to main balance ─
router.post("/marketplace/wallet/:type/withdraw", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { type } = req.params;
  const { amount } = req.body;
  if (!MARKET_TYPES.includes(type as any)) { res.status(400).json({ error: "Invalid market type" }); return; }
  if (!amount || Number(amount) <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }
  try {
    const r = await pool.query(
      "SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type=$2",
      [userId, type]
    );
    const available = Number(r.rows[0]?.balance ?? 0) - Number(r.rows[0]?.locked_balance ?? 0);
    if (available < Number(amount)) { res.status(400).json({ error: `Available: ${available} AZN` }); return; }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Guarded against locked_balance too — the pre-check above alone is
      // just a fast-fail; a concurrent withdraw or a lock placed in between
      // could otherwise still push balance below locked_balance.
      const debit = await client.query(
        "UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type=$3 AND balance - locked_balance >= $1",
        [Number(amount), userId, type]
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `Available: ${available} AZN` }); return;
      }
      await client.query(
        `INSERT INTO credits (user_id, azn_balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + $2`,
        [userId, Number(amount)]
      );
      await client.query("COMMIT");
      res.json({ ok: true, withdrawn: Number(amount) });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 4. GET /marketplace/wallet/transactions — history across all 3 markets ─────
router.get("/marketplace/wallet/transactions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { limit = 50, market_type } = req.query as any;
  try {
    let q = `
      SELECT mt.*, 
             b.username as buyer_username, s.username as seller_username
      FROM marketplace_transactions mt
      LEFT JOIN users b ON b.id = mt.buyer_id
      LEFT JOIN users s ON s.id = mt.seller_id
      WHERE (mt.buyer_id=$1 OR mt.seller_id=$1)
    `;
    const params: any[] = [userId];
    if (market_type) { params.push(market_type); q += ` AND mt.market_type=$${params.length}`; }
    q += ` ORDER BY mt.created_at DESC LIMIT $${params.length + 1}`;
    params.push(Number(limit));
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 5. GET /marketplace/wallet/summary — portfolio summary ────────────────────
router.get("/marketplace/wallet/summary", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    await ensureAllWallets(userId);
    const [wallets, trades, earned] = await Promise.all([
      pool.query("SELECT market_type, balance, locked_balance FROM marketplace_wallets WHERE user_id=$1", [userId]),
      pool.query("SELECT market_type, COUNT(*) as cnt FROM marketplace_transactions WHERE buyer_id=$1 OR seller_id=$1 GROUP BY market_type", [userId]),
      pool.query("SELECT SUM(net_amount) as total FROM marketplace_transactions WHERE seller_id=$1", [userId]),
    ]);
    const total = wallets.rows.reduce((s, w) => s + Number(w.balance), 0);
    const tradeMap: Record<string, number> = {};
    trades.rows.forEach((r: any) => { tradeMap[r.market_type] = Number(r.cnt); });
    res.json({
      wallets: wallets.rows.map(w => ({ ...w, balance: Number(w.balance), locked: Number(w.locked_balance) })),
      total_balance: total,
      total_earned: Number(earned.rows[0]?.total ?? 0),
      trades: tradeMap,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
