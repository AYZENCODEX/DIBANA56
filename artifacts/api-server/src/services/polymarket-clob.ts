/**
 * services/polymarket-clob.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-money Polymarket trading, ported from the standalone Telegram bot's
 * api/clob.py + api/polymarket.py. Key difference from the bot: that bot used
 * ONE wallet from a global .env var. AYZEN is multi-tenant, so every call here
 * takes the specific user's decrypted mnemonic and builds a fresh CLOB client
 * for that request — nothing is cached across users.
 *
 * Uses the official @polymarket/clob-client (TS) SDK, matching py-clob-client's
 * create_order / post_order flow used by the original bot.
 *
 * All public functions return { data, error } — callers never need bare
 * try/catch.
 */
import { ethers } from "ethers";
import axios from "axios";

const CLOB_HOST = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const POLYGON_CHAIN_ID = 137;

// Server-wide safety cap — mirrors REAL_MAX_TRADE_USDC from the original bot.
// Individual users can never place a single order larger than this, regardless
// of their wallet balance, unless the operator raises it.
export const REAL_MAX_TRADE_USDC = parseFloat(process.env["REAL_MAX_TRADE_USDC"] ?? "50");

export interface ClobResult<T> {
  data: T | null;
  error: string | null;
}

/**
 * Build a signer + CLOB client for one specific user's request.
 * `mnemonicOrKey` is the ALREADY-DECRYPTED secret — decrypt it just-in-time in
 * the route handler (see routes/wallets.ts handleWithdraw for the pattern),
 * never store or log the plaintext value.
 */
async function buildClient(mnemonicOrKey: string, provider: ethers.JsonRpcProvider) {
  // @polymarket/clob-client is an optional peer dependency — imported lazily so
  // the rest of the API server still boots if it isn't installed yet.
  const { ClobClient, OrderType, Side } = await import("@polymarket/clob-client");

  const wallet = mnemonicOrKey.trim().split(" ").length >= 12
    ? ethers.Wallet.fromPhrase(mnemonicOrKey.trim()).connect(provider)
    : new ethers.Wallet(mnemonicOrKey.trim(), provider);

  // signatureType 0 = EOA (externally owned account) — same as the bot.
  const client = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet as any, undefined, 0);
  const creds = await client.createOrDeriveApiKey();
  const authedClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet as any, creds, 0);

  return { client: authedClient, wallet, OrderType, Side };
}

export async function getUsdcBalance(
  mnemonicOrKey: string,
  provider: ethers.JsonRpcProvider
): Promise<ClobResult<{ address: string; balance: number }>> {
  try {
    const { client, wallet } = await buildClient(mnemonicOrKey, provider);
    const raw: any = await client.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
    const balance = parseFloat(String(raw?.balance ?? raw?.amount ?? "0")) / 1_000_000; // USDC has 6 decimals
    return { data: { address: wallet.address, balance }, error: null };
  } catch (exc: any) {
    return { data: null, error: exc?.message ?? "Balance fetch failed" };
  }
}

/** Parse clobTokenIds from a Gamma-API market object. Returns [yesId, noId]. */
export function extractTokenIds(market: any): [string | null, string | null] {
  const raw = market?.clobTokenIds;
  if (!raw) return [null, null];
  try {
    const ids = typeof raw === "string" ? JSON.parse(raw) : raw;
    return [ids?.[0] ?? null, ids?.[1] ?? null];
  } catch {
    return [null, null];
  }
}

export async function fetchMarkets(limit = 20, search?: string): Promise<ClobResult<any[]>> {
  try {
    const { data } = await axios.get(GAMMA_API, {
      params: { active: true, closed: false, limit, ...(search ? { search } : {}) },
      timeout: 10_000,
    });
    return { data: Array.isArray(data) ? data : (data?.markets ?? []), error: null };
  } catch (exc: any) {
    return { data: null, error: exc?.message ?? "Failed to fetch markets" };
  }
}

export async function fetchMarketById(marketId: string): Promise<ClobResult<any>> {
  try {
    const { data } = await axios.get(`${GAMMA_API}/${marketId}`, { timeout: 10_000 });
    return { data, error: null };
  } catch (exc: any) {
    return { data: null, error: exc?.message ?? "Failed to fetch market" };
  }
}

export interface PlaceOrderArgs {
  mnemonicOrKey: string;
  provider: ethers.JsonRpcProvider;
  tokenId: string;
  price: number; // 0.01 - 0.99
  sizeUsdc: number;
}

/**
 * Build, sign, and submit a GTC (good-till-cancelled) limit BUY order.
 * Enforces REAL_MAX_TRADE_USDC as a hard cap regardless of what the caller
 * requests, mirroring the original bot's real_trade.py safety check.
 */
export async function placeBuyOrder(
  args: PlaceOrderArgs
): Promise<ClobResult<{ orderId: string | null; raw: any }>> {
  const { mnemonicOrKey, provider, tokenId, price, sizeUsdc } = args;

  if (sizeUsdc > REAL_MAX_TRADE_USDC) {
    return { data: null, error: `Order size $${sizeUsdc} exceeds the max allowed trade of $${REAL_MAX_TRADE_USDC}` };
  }
  if (price <= 0 || price >= 1) {
    return { data: null, error: "price must be between 0.01 and 0.99" };
  }

  try {
    const { client, Side } = await buildClient(mnemonicOrKey, provider);
    const order = await client.createOrder({
      tokenID: tokenId,
      price: Math.round(price * 10_000) / 10_000,
      size: Math.round(sizeUsdc * 100) / 100,
      side: Side.BUY,
      feeRateBps: 0,
    } as any);
    const resp: any = await client.postOrder(order, "GTC" as any);
    return { data: { orderId: resp?.orderID ?? resp?.id ?? null, raw: resp }, error: null };
  } catch (exc: any) {
    return { data: null, error: exc?.message ?? "Order submission failed" };
  }
}

export async function getOrderStatus(
  mnemonicOrKey: string,
  provider: ethers.JsonRpcProvider,
  orderId: string
): Promise<ClobResult<any>> {
  try {
    const { client } = await buildClient(mnemonicOrKey, provider);
    const result = await client.getOrder(orderId);
    return { data: result, error: null };
  } catch (exc: any) {
    return { data: null, error: exc?.message ?? "Order lookup failed" };
  }
}
