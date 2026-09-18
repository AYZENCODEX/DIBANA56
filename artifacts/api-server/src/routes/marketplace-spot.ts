import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// Supported internal pairs. Base = AZN (tracked in marketplace_wallets, market_type='azn'),
// Quote = USDT (tracked in builtin_wallet_tokens, symbol='USDT').
const PAIRS = ["AZN/USDT"] as const;
const FEE_PCT = 0.1; // taker/maker flat fee, matches typical spot-exchange scale

function assertPair(pair: string) {
  if (!PAIRS.includes(pair as any)) throw Object.assign(new Error("Unsupported pair"), { status: 400 });
}

// `spot_orders` and `staking_positions` each have their own plain
// single-owner column (`user_id`) — two separate builders since they're
// different tables, same shared `requireOwnership()` wrapper as the rest
// of this series. Both handlers already re-select the row themselves
// inside a `FOR UPDATE` transaction after this gate — PEP is an
// additive pre-check, it doesn't replace or race with that lock.
const SPOT_RESOURCE_OWNER_SENTINEL_NONE = -1;
const spotOrderResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "spot_order", id: req.params.id, ownerId: SPOT_RESOURCE_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT user_id FROM spot_orders WHERE id=$1 LIMIT 1", [id]);
  return { type: "spot_order", id, ownerId: rows[0]?.user_id ?? SPOT_RESOURCE_OWNER_SENTINEL_NONE };
};
const stakingPositionResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "staking_position", id: req.params.id, ownerId: SPOT_RESOURCE_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT user_id FROM staking_positions WHERE id=$1 LIMIT 1", [id]);
  return { type: "staking_position", id, ownerId: rows[0]?.user_id ?? SPOT_RESOURCE_OWNER_SENTINEL_NONE };
};
function requireSpotResourceOwnership(resource: ResourceRefBuilder, action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, resource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

async function ensureAznWallet(userId: number) {
  await pool.query(
    `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
     VALUES ($1, 'azn', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
    [userId]
  );
}
async function ensureUsdtWallet(userId: number) {
  await pool.query(
    `INSERT INTO builtin_wallet_tokens (user_id, symbol, amount, locked_amount)
     VALUES ($1, 'USDT', 0, 0) ON CONFLICT (user_id, symbol) DO NOTHING`,
    [userId]
  );
}

async function getBalances(userId: number) {
  await ensureAznWallet(userId);
  await ensureUsdtWallet(userId);
  const [azn, usdt] = await Promise.all([
    pool.query("SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='azn'", [userId]),
    pool.query("SELECT amount, locked_amount FROM builtin_wallet_tokens WHERE user_id=$1 AND symbol='USDT'", [userId]),
  ]);
  return {
    azn: { balance: Number(azn.rows[0]?.balance ?? 0), locked: Number(azn.rows[0]?.locked_balance ?? 0) },
    usdt: { balance: Number(usdt.rows[0]?.amount ?? 0), locked: Number(usdt.rows[0]?.locked_amount ?? 0) },
  };
}

// ── GET /spot/pairs — tradable pairs + last price + 24h stats ─────────────────
router.get("/spot/pairs", requireAuth, async (_req, res): Promise<void> => {
  try {
    const out = [];
    for (const pair of PAIRS) {
      const last = await pool.query(
        "SELECT price FROM spot_trades WHERE pair=$1 ORDER BY id DESC LIMIT 1", [pair]
      );
      const day = await pool.query(
        `SELECT MIN(price) lo, MAX(price) hi, SUM(qty) vol,
                (ARRAY_AGG(price ORDER BY id ASC))[1] open_p
         FROM spot_trades WHERE pair=$1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [pair]
      );
      const d = day.rows[0] ?? {};
      const lastPrice = Number(last.rows[0]?.price ?? 0.01);
      const openPrice = Number(d.open_p ?? lastPrice);
      out.push({
        pair, last_price: lastPrice,
        change_24h_pct: openPrice ? ((lastPrice - openPrice) / openPrice) * 100 : 0,
        high_24h: Number(d.hi ?? lastPrice), low_24h: Number(d.lo ?? lastPrice),
        volume_24h: Number(d.vol ?? 0),
      });
    }
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /spot/orderbook/:pair — live bids/asks (aggregated by price) ──────────
router.get("/spot/orderbook/:pair", requireAuth, async (req, res): Promise<void> => {
  const pair = decodeURIComponent(req.params.pair as string);
  try {
    assertPair(pair);
    const bids = await pool.query(
      `SELECT price, SUM(qty - filled_qty) qty FROM spot_orders
       WHERE pair=$1 AND side='buy' AND status='open' AND order_type='limit'
       GROUP BY price ORDER BY price DESC LIMIT 25`,
      [pair]
    );
    const asks = await pool.query(
      `SELECT price, SUM(qty - filled_qty) qty FROM spot_orders
       WHERE pair=$1 AND side='sell' AND status='open' AND order_type='limit'
       GROUP BY price ORDER BY price ASC LIMIT 25`,
      [pair]
    );
    res.json({
      pair,
      bids: bids.rows.map(r => ({ price: Number(r.price), qty: Number(r.qty) })),
      asks: asks.rows.map(r => ({ price: Number(r.price), qty: Number(r.qty) })),
    });
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

// ── GET /spot/trades/:pair — recent tape ───────────────────────────────────────
router.get("/spot/trades/:pair", requireAuth, async (req, res): Promise<void> => {
  const pair = decodeURIComponent(req.params.pair as string);
  try {
    assertPair(pair);
    const r = await pool.query(
      "SELECT id, price, qty, buyer_id, created_at FROM spot_trades WHERE pair=$1 ORDER BY id DESC LIMIT 50",
      [pair]
    );
    res.json(r.rows.map(t => ({ ...t, price: Number(t.price), qty: Number(t.qty) })));
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

// ── GET /spot/candles/:pair?interval=1h&limit=100 — OHLC bucketed from trades ──
router.get("/spot/candles/:pair", requireAuth, async (req, res): Promise<void> => {
  const pair = decodeURIComponent(req.params.pair as string);
  const { interval = "1h", limit = 100 } = req.query as any;
  const bucketSql: Record<string, string> = {
    "1m": "minute", "5m": "5 minutes", "15m": "15 minutes",
    "1h": "hour", "4h": "4 hours", "1d": "day",
  };
  const bucket = bucketSql[interval] ?? "hour";
  try {
    assertPair(pair);
    const isSimple = ["minute", "hour", "day"].includes(bucket);
    const q = isSimple
      ? `SELECT date_trunc('${bucket}', created_at) AS bucket,
                (ARRAY_AGG(price ORDER BY id ASC))[1] AS open,
                MAX(price) AS high, MIN(price) AS low,
                (ARRAY_AGG(price ORDER BY id DESC))[1] AS close,
                SUM(qty) AS volume
         FROM spot_trades WHERE pair=$1
         GROUP BY bucket ORDER BY bucket DESC LIMIT $2`
      : `SELECT to_timestamp(floor(extract(epoch FROM created_at) / extract(epoch FROM interval '${bucket}')) * extract(epoch FROM interval '${bucket}')) AS bucket,
                (ARRAY_AGG(price ORDER BY id ASC))[1] AS open,
                MAX(price) AS high, MIN(price) AS low,
                (ARRAY_AGG(price ORDER BY id DESC))[1] AS close,
                SUM(qty) AS volume
         FROM spot_trades WHERE pair=$1
         GROUP BY bucket ORDER BY bucket DESC LIMIT $2`;
    const r = await pool.query(q, [pair, Number(limit)]);
    res.json(r.rows.reverse().map(c => ({
      time: c.bucket, open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: Number(c.volume),
    })));
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

// ── GET /spot/balances — trading-wallet balances (AZN + USDT) ─────────────────
router.get("/spot/balances", requireAuth, async (req, res): Promise<void> => {
  try {
    res.json(await getBalances(req.user!.userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /spot/orders — my open + recent orders ─────────────────────────────────
router.get("/spot/orders", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { status } = req.query as any;
  try {
    let q = "SELECT * FROM spot_orders WHERE user_id=$1";
    const params: any[] = [userId];
    if (status) { params.push(status); q += ` AND status=$${params.length}`; }
    q += " ORDER BY id DESC LIMIT 100";
    const r = await pool.query(q, params);
    res.json(r.rows.map(o => ({ ...o, price: Number(o.price), qty: Number(o.qty), filled_qty: Number(o.filled_qty) })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /spot/orders — place order, run matching engine ──────────────────────
// body: { pair, side: 'buy'|'sell', order_type: 'limit'|'market', price?, qty }
router.post("/spot/orders", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { pair = "AZN/USDT", side, order_type = "limit", price, qty } = req.body ?? {};
  try {
    assertPair(pair);
    if (!["buy", "sell"].includes(side)) throw Object.assign(new Error("side must be buy or sell"), { status: 400 });
    if (!["limit", "market"].includes(order_type)) throw Object.assign(new Error("Invalid order_type"), { status: 400 });
    const qtyN = Number(qty);
    if (!qtyN || qtyN <= 0) throw Object.assign(new Error("qty must be positive"), { status: 400 });
    let priceN = Number(price ?? 0);
    if (order_type === "limit" && priceN <= 0) throw Object.assign(new Error("price required for limit orders"), { status: 400 });

    await ensureAznWallet(userId);
    await ensureUsdtWallet(userId);

    // Pinned to ONE client for the whole order-place + match sequence.
    // matchOrder() takes FOR UPDATE row locks on maker orders and moves
    // locked/available balances — calling pool.query() instead (as this
    // used to) hands each statement to whichever connection happens to be
    // free, so a FOR UPDATE lock is released the instant its own statement
    // finishes instead of holding for the rest of the "transaction", and
    // BEGIN/COMMIT/ROLLBACK can each land on a different connection too.
    // That silently turns the matching engine's concurrency guarantees
    // into no-ops — two simultaneous orders could match the same maker
    // twice, or double-release/double-debit a lock. See routes/marketplace
    // .ts / routes/wallets.ts for the same pool.connect() pattern used
    // elsewhere in this codebase.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // For market orders, use best opposite-side price as a reference to size the fund lock.
      if (order_type === "market") {
        const bestRow = await client.query(
          side === "buy"
            ? "SELECT MIN(price) p FROM spot_orders WHERE pair=$1 AND side='sell' AND status='open'"
            : "SELECT MAX(price) p FROM spot_orders WHERE pair=$1 AND side='buy' AND status='open'",
          [pair]
        );
        priceN = Number(bestRow.rows[0]?.p ?? 0);
        if (!priceN) throw Object.assign(new Error("No liquidity available for market order"), { status: 400 });
      }

      // Lock funds: buyer locks qty*price USDT, seller locks qty AZN.
      if (side === "buy") {
        const need = qtyN * priceN;
        const bal = await client.query("SELECT amount, locked_amount FROM builtin_wallet_tokens WHERE user_id=$1 AND symbol='USDT' FOR UPDATE", [userId]);
        const avail = Number(bal.rows[0]?.amount ?? 0) - Number(bal.rows[0]?.locked_amount ?? 0);
        if (avail < need) throw Object.assign(new Error(`Insufficient USDT. Need ${need.toFixed(4)}, have ${avail.toFixed(4)}`), { status: 400 });
        await client.query("UPDATE builtin_wallet_tokens SET locked_amount=locked_amount+$1, updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'", [need, userId]);
      } else {
        const bal = await client.query("SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='azn' FOR UPDATE", [userId]);
        const avail = Number(bal.rows[0]?.balance ?? 0) - Number(bal.rows[0]?.locked_balance ?? 0);
        if (avail < qtyN) throw Object.assign(new Error(`Insufficient AZN. Need ${qtyN}, have ${avail}`), { status: 400 });
        await client.query("UPDATE marketplace_wallets SET locked_balance=locked_balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'", [qtyN, userId]);
      }

      const ins = await client.query(
        `INSERT INTO spot_orders (user_id, pair, side, order_type, price, qty, status)
         VALUES ($1,$2,$3,$4,$5,$6,'open') RETURNING *`,
        [userId, pair, side, order_type, priceN, qtyN]
      );
      const order = ins.rows[0];
      const fills = await matchOrder(client, order, pair);
      await client.query("COMMIT");
      res.json({ order: { ...order, price: priceN, qty: qtyN }, fills });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

// Matching engine — price/time priority, must run inside the caller's
// transaction, on the SAME client the caller BEGIN'd with (see the
// pool.connect() comment above POST /spot/orders — this is what makes the
// FOR UPDATE lock below actually hold for the duration of the match).
async function matchOrder(client: import("pg").PoolClient, order: any, pair: string) {
  const fills: any[] = [];
  let remaining = Number(order.qty) - Number(order.filled_qty);
  const oppositeSide = order.side === "buy" ? "sell" : "buy";
  const orderBy = order.side === "buy" ? "price ASC, id ASC" : "price DESC, id ASC"; // best price for taker first

  while (remaining > 0.00000001) {
    const priceFilter = order.order_type === "limit"
      ? (order.side === "buy" ? "AND price <= $2" : "AND price >= $2")
      : "";
    const params: any[] = priceFilter ? [pair, order.price] : [pair];
    const cand = await client.query(
      `SELECT * FROM spot_orders WHERE pair=$1 AND side='${oppositeSide}' AND status='open' ${priceFilter}
       ORDER BY ${orderBy} LIMIT 1 FOR UPDATE`,
      params
    );
    const maker = cand.rows[0];
    if (!maker) break; // no more matchable liquidity

    const makerRemaining = Number(maker.qty) - Number(maker.filled_qty);
    const tradeQty = Math.min(remaining, makerRemaining);
    const tradePrice = Number(maker.price); // resting order sets the price

    const buyOrder = order.side === "buy" ? order : maker;
    const sellOrder = order.side === "buy" ? maker : order;
    const buyerId = buyOrder.user_id, sellerId = sellOrder.user_id;

    // Settle: seller's locked AZN -> buyer's AZN balance; buyer's locked USDT -> seller's USDT balance.
    const aznAmt = tradeQty;
    const usdtAmt = tradeQty * tradePrice;
    const fee = usdtAmt * (FEE_PCT / 100);

    await client.query("UPDATE marketplace_wallets SET locked_balance=locked_balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'", [aznAmt, sellerId]);
    await client.query(
      `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance) VALUES ($1,'azn',$2,0)
       ON CONFLICT (user_id, market_type) DO UPDATE SET balance=marketplace_wallets.balance+$2, updated_at=NOW()`,
      [buyerId, aznAmt]
    );
    // Buyer's original lock was sized off its own limit/reference price; release exactly what this fill consumes.
    await client.query("UPDATE builtin_wallet_tokens SET locked_amount=GREATEST(0, locked_amount-$1), updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'", [usdtAmt, buyerId]);
    await client.query(
      `INSERT INTO builtin_wallet_tokens (user_id, symbol, amount, locked_amount) VALUES ($1,'USDT',$2,0)
       ON CONFLICT (user_id, symbol) DO UPDATE SET amount=builtin_wallet_tokens.amount+$2, updated_at=NOW()`,
      [sellerId, usdtAmt - fee]
    );

    const newMakerFilled = Number(maker.filled_qty) + tradeQty;
    const makerStatus = newMakerFilled >= Number(maker.qty) - 0.00000001 ? "filled" : "open";
    await client.query("UPDATE spot_orders SET filled_qty=$1, status=$2, updated_at=NOW() WHERE id=$3", [newMakerFilled, makerStatus, maker.id]);

    remaining -= tradeQty;
    const newTakerFilled = Number(order.filled_qty) + tradeQty;
    order.filled_qty = newTakerFilled;
    const takerStatus = remaining <= 0.00000001 ? "filled" : (order.order_type === "market" ? "filled" : "open");
    await client.query("UPDATE spot_orders SET filled_qty=$1, status=$2, updated_at=NOW() WHERE id=$3", [newTakerFilled, takerStatus, order.id]);

    const tradeIns = await client.query(
      `INSERT INTO spot_trades (pair, buy_order_id, sell_order_id, buyer_id, seller_id, price, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pair, buyOrder.id, sellOrder.id, buyerId, sellerId, tradePrice, tradeQty]
    );
    fills.push(tradeIns.rows[0]);
    if (order.order_type === "market" && remaining > 0 && !cand.rows.length) break;
  }

  // Market orders don't rest on the book — release any unfilled remainder's lock.
  if (order.order_type === "market" && remaining > 0.00000001) {
    if (order.side === "buy") {
      await client.query("UPDATE builtin_wallet_tokens SET locked_amount=GREATEST(0, locked_amount-$1), updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'", [remaining * Number(order.price), order.user_id]);
    } else {
      await client.query("UPDATE marketplace_wallets SET locked_balance=GREATEST(0, locked_balance-$1), updated_at=NOW() WHERE user_id=$2 AND market_type='azn'", [remaining, order.user_id]);
    }
    await client.query("UPDATE spot_orders SET status='partial_cancelled', updated_at=NOW() WHERE id=$1", [order.id]);
  }
  return fills;
}

// ── DELETE /spot/orders/:id — cancel an open order and release the lock ────────
router.delete("/spot/orders/:id", requireAuth, requireSpotResourceOwnership(spotOrderResource, "spot_order.cancel", { error: "Order not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT * FROM spot_orders WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, userId]);
      const order = r.rows[0];
      if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (order.status !== "open") throw Object.assign(new Error("Order is not open"), { status: 400 });
      const remaining = Number(order.qty) - Number(order.filled_qty);
      if (order.side === "buy") {
        await client.query("UPDATE builtin_wallet_tokens SET locked_amount=GREATEST(0, locked_amount-$1), updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'", [remaining * Number(order.price), userId]);
      } else {
        await client.query("UPDATE marketplace_wallets SET locked_balance=GREATEST(0, locked_balance-$1), updated_at=NOW() WHERE user_id=$2 AND market_type='azn'", [remaining, userId]);
      }
      await client.query("UPDATE spot_orders SET status='cancelled', updated_at=NOW() WHERE id=$1", [id]);
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

// ══════════════════════════ Staking / Earn ══════════════════════════════════

router.get("/spot/staking/pools", requireAuth, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM staking_pools WHERE is_active=TRUE ORDER BY apy DESC");
    res.json(r.rows.map(p => ({ ...p, apy: Number(p.apy), min_amount: Number(p.min_amount) })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/spot/staking/positions", requireAuth, async (req, res): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT sp.*, pool.symbol, pool.label FROM staking_positions sp
       JOIN staking_pools pool ON pool.id = sp.pool_id
       WHERE sp.user_id=$1 ORDER BY sp.id DESC`,
      [req.user!.userId]
    );
    res.json(r.rows.map(p => ({ ...p, amount: Number(p.amount), apy: Number(p.apy), reward_paid: Number(p.reward_paid) })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/spot/staking/stake", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { pool_id, amount } = req.body ?? {};
  try {
    const amtN = Number(amount);
    if (!amtN || amtN <= 0) throw Object.assign(new Error("amount must be positive"), { status: 400 });
    const poolR = await pool.query("SELECT * FROM staking_pools WHERE id=$1 AND is_active=TRUE", [pool_id]);
    const stakePool = poolR.rows[0];
    if (!stakePool) throw Object.assign(new Error("Pool not found"), { status: 404 });
    if (amtN < Number(stakePool.min_amount)) throw Object.assign(new Error(`Minimum stake is ${stakePool.min_amount} ${stakePool.symbol.split("-")[0]}`), { status: 400 });

    const isAzn = String(stakePool.symbol).startsWith("AZN");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (isAzn) {
        await ensureAznWallet(userId);
        const bal = await client.query("SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='azn' FOR UPDATE", [userId]);
        const avail = Number(bal.rows[0]?.balance ?? 0) - Number(bal.rows[0]?.locked_balance ?? 0);
        if (avail < amtN) throw Object.assign(new Error(`Insufficient AZN. Have ${avail}`), { status: 400 });
        await client.query("UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='azn'", [amtN, userId]);
      } else {
        await ensureUsdtWallet(userId);
        const bal = await client.query("SELECT amount, locked_amount FROM builtin_wallet_tokens WHERE user_id=$1 AND symbol='USDT' FOR UPDATE", [userId]);
        const avail = Number(bal.rows[0]?.amount ?? 0) - Number(bal.rows[0]?.locked_amount ?? 0);
        if (avail < amtN) throw Object.assign(new Error(`Insufficient USDT. Have ${avail.toFixed(4)}`), { status: 400 });
        await client.query("UPDATE builtin_wallet_tokens SET amount=amount-$1, updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'", [amtN, userId]);
      }
      const unlockDays = Number(stakePool.min_lock_days) || 0;
      const ins = await client.query(
        `INSERT INTO staking_positions (user_id, pool_id, amount, apy, unlock_at, status)
         VALUES ($1,$2,$3,$4, NOW() + ($5 || ' days')::interval, 'active') RETURNING *`,
        [userId, pool_id, amtN, stakePool.apy, unlockDays]
      );
      await client.query("COMMIT");
      res.json(ins.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

router.post("/spot/staking/unstake/:id", requireAuth, requireSpotResourceOwnership(stakingPositionResource, "staking_position.unstake", { error: "Position not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `SELECT sp.*, pool.symbol FROM staking_positions sp JOIN staking_pools pool ON pool.id=sp.pool_id
         WHERE sp.id=$1 AND sp.user_id=$2 FOR UPDATE`,
        [id, userId]
      );
      const pos = r.rows[0];
      if (!pos) throw Object.assign(new Error("Position not found"), { status: 404 });
      if (pos.status !== "active") throw Object.assign(new Error("Position is not active"), { status: 400 });
      const matured = new Date(pos.unlock_at).getTime() <= Date.now();
      const daysHeld = Math.max(0, (Date.now() - new Date(pos.started_at).getTime()) / 86400000);
      const reward = matured ? Number(pos.amount) * (Number(pos.apy) / 100) * (daysHeld / 365) : 0;
      const payout = Number(pos.amount) + reward;
      const isAzn = String(pos.symbol).startsWith("AZN");
      if (isAzn) {
        await client.query(
          `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance) VALUES ($1,'azn',$2,0)
           ON CONFLICT (user_id, market_type) DO UPDATE SET balance=marketplace_wallets.balance+$2, updated_at=NOW()`,
          [userId, payout]
        );
      } else {
        await client.query(
          `INSERT INTO builtin_wallet_tokens (user_id, symbol, amount, locked_amount) VALUES ($1,'USDT',$2,0)
           ON CONFLICT (user_id, symbol) DO UPDATE SET amount=builtin_wallet_tokens.amount+$2, updated_at=NOW()`,
          [userId, payout]
        );
      }
      await client.query("UPDATE staking_positions SET status=$1, reward_paid=$2 WHERE id=$3", [matured ? "completed" : "early_exit", reward, id]);
      await client.query("COMMIT");
      res.json({ ok: true, matured, reward, payout });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

export default router;
