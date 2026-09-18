/**
 * routes/polymarket.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-money Polymarket trading, using a user's own AYZEN built-in wallet
 * (routes/wallets.ts → POST /wallets/builtin/create). Ported from the
 * standalone Telegram bot (handlers/real_trade.py + api/clob.py), adapted for
 * multi-tenant use: every request decrypts ONLY the requesting user's own
 * wallet, just-in-time, never a shared/global key.
 *
 * Endpoints
 * ─────────
 * GET  /polymarket/markets          — browse active markets (Gamma API proxy)
 * GET  /polymarket/markets/:id      — single market detail
 * GET  /polymarket/balance          — this user's on-chain USDC balance
 * GET  /polymarket/trades           — this user's local trade history
 * POST /polymarket/trade            — place a REAL buy order (real money)
 */
import { Router } from "express";
import { ethers } from "ethers";
import { db, walletsTable, polymarketTradesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getTokenFromReq, getUserFromToken } from "../lib/auth-utils";
import { decryptPhrase } from "../lib/wallet-crypto";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { broadcastEvent } from "./events";
import {
  fetchMarkets,
  fetchMarketById,
  extractTokenIds,
  getUsdcBalance,
  placeBuyOrder,
  REAL_MAX_TRADE_USDC,
} from "../services/polymarket-clob";

const POLYGON_RPC = process.env["POLYGON_RPC"] || "https://polygon-rpc.com";
function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(POLYGON_RPC);
}

const router = Router();

async function requireUser(req: any, res: any): Promise<{ userId: number } | null> {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { userId: authUser.userId };
}

// GET /polymarket/markets?search=&limit=
router.get("/polymarket/markets", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const limit = Math.min(parseInt(String(req.query["limit"] ?? "20"), 10) || 20, 50);
  const search = typeof req.query["search"] === "string" ? req.query["search"] : undefined;

  const { data, error } = await fetchMarkets(limit, search);
  if (error) { res.status(502).json({ error }); return; }
  res.json({ markets: data });
});

// GET /polymarket/markets/:id
router.get("/polymarket/markets/:id", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const { data, error } = await fetchMarketById(req.params.id);
  if (error) { res.status(502).json({ error }); return; }
  if (!data) { res.status(404).json({ error: "Market not found" }); return; }

  const [yesTokenId, noTokenId] = extractTokenIds(data);
  res.json({ market: data, yesTokenId, noTokenId });
});

// GET /polymarket/balance?walletId=
// Returns the on-chain USDC balance for the requesting user's own wallet.
router.get("/polymarket/balance", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const walletId = parseInt(String(req.query["walletId"] ?? ""), 10);
  if (!walletId) { res.status(400).json({ error: "walletId query param is required" }); return; }

  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, walletId), eq(walletsTable.userId, user.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }
  if (!wallet.encryptedPhrase) { res.status(400).json({ error: "This wallet has no key material stored" }); return; }

  try {
    const secret = decryptPhrase(wallet.encryptedPhrase);
    const { data, error } = await getUsdcBalance(secret, getProvider());
    if (error) { res.status(502).json({ error }); return; }
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to unlock wallet key material" });
  }
});

// GET /polymarket/trades — this user's local trade history
router.get("/polymarket/trades", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const rows = await db.select().from(polymarketTradesTable)
    .where(eq(polymarketTradesTable.userId, user.userId))
    .orderBy(desc(polymarketTradesTable.createdAt))
    .limit(50);
  res.json({ trades: rows });
});

// POST /polymarket/trade
// Body: { walletId, marketId, tokenId, outcome: "YES"|"NO", price, sizeUsdc, confirm: true }
//
// REAL MONEY: this signs and submits a live GTC limit order against
// Polymarket's CLOB, funded by the user's own on-chain USDC. `confirm: true`
// must be explicitly sent by the client (never defaulted) as a lightweight
// guard against accidental double-submits from retried requests.
router.post("/polymarket/trade", sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const {
    walletId,
    marketId,
    marketQuestion,
    tokenId,
    outcome,
    price,
    sizeUsdc,
    confirm,
  } = req.body as {
    walletId?: number;
    marketId?: string;
    marketQuestion?: string;
    tokenId?: string;
    outcome?: string;
    price?: number;
    sizeUsdc?: number;
    confirm?: boolean;
  };

  if (!confirm) { res.status(400).json({ error: "confirm: true is required to place a real-money order" }); return; }
  if (!walletId) { res.status(400).json({ error: "walletId is required" }); return; }
  if (!marketId?.trim() || !tokenId?.trim()) { res.status(400).json({ error: "marketId and tokenId are required" }); return; }
  if (outcome !== "YES" && outcome !== "NO") { res.status(400).json({ error: "outcome must be YES or NO" }); return; }
  if (!price || price <= 0 || price >= 1) { res.status(400).json({ error: "price must be between 0.01 and 0.99" }); return; }
  if (!sizeUsdc || sizeUsdc <= 0) { res.status(400).json({ error: "sizeUsdc must be > 0" }); return; }
  if (sizeUsdc > REAL_MAX_TRADE_USDC) {
    res.status(400).json({ error: `sizeUsdc exceeds the configured max trade of $${REAL_MAX_TRADE_USDC}` });
    return;
  }

  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, walletId), eq(walletsTable.userId, user.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }
  if (!wallet.encryptedPhrase) { res.status(400).json({ error: "This wallet has no key material stored — cannot sign an order" }); return; }

  let secret: string;
  try {
    secret = decryptPhrase(wallet.encryptedPhrase);
  } catch {
    res.status(500).json({ error: "Failed to unlock wallet key material" });
    return;
  }

  const { data, error } = await placeBuyOrder({
    mnemonicOrKey: secret,
    provider: getProvider(),
    tokenId: tokenId.trim(),
    price,
    sizeUsdc,
  });

  const [trade] = await db.insert(polymarketTradesTable).values({
    userId: user.userId,
    walletId,
    marketId: marketId.trim(),
    marketQuestion: marketQuestion ?? null,
    tokenId: tokenId.trim(),
    outcome,
    side: "BUY",
    price,
    sizeUsdc,
    status: error ? "failed" : "submitted",
    clobOrderId: data?.orderId ?? null,
    errorMessage: error ?? null,
  }).returning();

  if (error) {
    res.status(502).json({ error, trade });
    return;
  }

  broadcastEvent("polymarket_trade", {
    userId: user.userId,
    walletId,
    marketId,
    outcome,
    price,
    sizeUsdc,
    orderId: data?.orderId ?? null,
  });

  res.json({ success: true, orderId: data?.orderId ?? null, trade });
});

export default router;
