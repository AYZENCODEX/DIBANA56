/**
 * lib/chain-balance.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only multi-chain native-balance lookup, built on ethers v6 (already a
 * project dependency for EVM wallet derivation / the vault deposit-watcher).
 *
 * Used by POST /vault/:id/refresh-wallet-worth (routes/vault.ts) to pull a
 * vault entity's live wallet worth instead of requiring it to be typed in by
 * hand. Same EVM address is valid on every chain below, so each address gets
 * checked against all six — exactly like the existing withdrawal path in
 * routes/wallets.ts (RPC_URLS / getDefaultChainId).
 *
 * Kept deliberately read-only: getBalance() only, no signing, no writes.
 */
import { ethers } from "ethers";
import { logger } from "./logger";

// Same public RPC endpoints as routes/wallets.ts / services/deposit-watcher.ts.
export const CHAINS = ["ETH", "BASE", "MATIC", "BSC", "ARB", "OP"] as const;
export type ChainSymbol = typeof CHAINS[number];

const RPC_URLS: Record<ChainSymbol, string> = {
  ETH: "https://cloudflare-eth.com",
  BASE: "https://mainnet.base.org",
  MATIC: "https://polygon-rpc.com",
  BSC: "https://bsc-dataseed.binance.org",
  ARB: "https://arb1.arbitrum.io/rpc",
  OP: "https://mainnet.optimism.io",
};

// Chain → coingecko id for native-coin USD pricing.
const COINGECKO_IDS: Record<ChainSymbol, string> = {
  ETH: "ethereum", ARB: "ethereum", OP: "ethereum", BASE: "ethereum",
  MATIC: "matic-network", BSC: "binancecoin",
};

const providers: Partial<Record<ChainSymbol, ethers.JsonRpcProvider>> = {};
function getProvider(chain: ChainSymbol): ethers.JsonRpcProvider {
  if (!providers[chain]) providers[chain] = new ethers.JsonRpcProvider(RPC_URLS[chain]);
  return providers[chain]!;
}

// Short-lived in-process price cache — one address × six chains would
// otherwise fire up to 3 duplicate coingecko calls per refresh (ETH price is
// shared by ETH/ARB/OP/BASE, so really at most 3 unique ids anyway).
const priceCache = new Map<string, { price: number; at: number }>();
const PRICE_TTL_MS = 60_000;

async function nativePriceUsd(chain: ChainSymbol): Promise<number> {
  const id = COINGECKO_IDS[chain];
  const cached = priceCache.get(id);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const d = await r.json() as Record<string, { usd?: number }>;
    const price = d?.[id]?.usd ?? 0;
    priceCache.set(id, { price, at: Date.now() });
    return price;
  } catch {
    return cached?.price ?? 0;
  }
}

export interface ChainBalanceResult {
  address: string;
  chain: ChainSymbol;
  balance: number;    // native coin amount
  balanceUsd: number;
  error?: string;
}

/** Read-only balance check for one address on one chain. Never throws. */
export async function getChainBalance(address: string, chain: ChainSymbol): Promise<ChainBalanceResult> {
  try {
    const provider = getProvider(chain);
    const wei = await provider.getBalance(address);
    const balance = parseFloat(ethers.formatEther(wei));
    const price = balance > 0 ? await nativePriceUsd(chain) : 0;
    return { address, chain, balance, balanceUsd: parseFloat((balance * price).toFixed(2)) };
  } catch (err: any) {
    logger.warn({ err: err?.message, address, chain }, "chain-balance: RPC read failed");
    return { address, chain, balance: 0, balanceUsd: 0, error: err?.message ?? "RPC error" };
  }
}

export interface WalletWorthSummary {
  totalUsd: number;
  results: ChainBalanceResult[];
}

/**
 * Sums native-coin USD worth for a set of EVM addresses across every chain
 * in CHAINS. Dedupes addresses first (an entity's driveWalletAddress can
 * coincide with one of its manually-added walletAddresses).
 */
export async function getMultiChainWalletWorth(addresses: string[]): Promise<WalletWorthSummary> {
  const unique = [...new Set(addresses.map((a) => a?.trim()).filter((a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a)))];
  const jobs: Promise<ChainBalanceResult>[] = [];
  for (const address of unique) {
    for (const chain of CHAINS) jobs.push(getChainBalance(address, chain));
  }
  const results = await Promise.all(jobs);
  const totalUsd = results.reduce((sum, r) => sum + r.balanceUsd, 0);
  return { totalUsd: parseFloat(totalUsd.toFixed(2)), results };
}
