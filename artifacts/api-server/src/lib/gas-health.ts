/**
 * lib/gas-health.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only "gas health" snapshot for an EVM address on one chain: its
 * current native-coin balance, the chain's live gas price, and — derived
 * from those two — a simulation of how many more transactions that balance
 * can actually pay for before it runs dry.
 *
 * "Gas" here always means the chain's native coin (ETH/BNB/POL/XPL — the
 * thing that pays tx fees), never an ERC-20 token balance. An address can
 * be sitting on $10k of USDT/USDC and still be unable to move a single wei
 * of it if it has zero native coin for gas — that's the risk this module
 * exists to surface, ahead of time, instead of a failed tx being the first
 * warning.
 *
 * Built on the same ethers v6 read-only pattern as lib/chain-balance.ts
 * (getBalance / getFeeData only — no signing, no writes, never throws).
 *
 * Used by:
 *   - routes/vault.ts    GET /vault/gas-overview  + GET /vault/:id/gas
 *     (Vault Entities — each entity's driveWalletAddress + walletAddresses,
 *     which is exactly what refresh-wallet-worth already reads)
 *   - routes/wallets.ts  GET /wallets/gas-overview
 *     (the built-in custodial wallet's single address, across the same
 *     chains lib/tokens.ts + services/deposit-watcher.ts already watch)
 */
import { ethers } from "ethers";
import { logger } from "./logger";

export type GasChain = "ETH" | "BASE" | "MATIC" | "BSC" | "ARB" | "OP" | "PLASMA";

export const GAS_RPC_URLS: Record<GasChain, string> = {
  ETH: "https://cloudflare-eth.com",
  BASE: "https://mainnet.base.org",
  MATIC: "https://polygon-rpc.com",
  BSC: "https://bsc-dataseed.binance.org",
  ARB: "https://arb1.arbitrum.io/rpc",
  OP: "https://mainnet.optimism.io",
  PLASMA: "https://rpc.plasma.to",
};

const NATIVE_SYMBOL: Record<GasChain, string> = {
  ETH: "ETH", BASE: "ETH", ARB: "ETH", OP: "ETH",
  MATIC: "POL", BSC: "BNB", PLASMA: "XPL",
};

// Coingecko ids for native-coin USD pricing — verified against
// coingecko.com/en/coins/<slug> for each (XPL's id is genuinely "plasma",
// not "xpl" — confirmed on its CoinGecko page, "API ID · plasma").
const COINGECKO_IDS: Record<GasChain, string> = {
  ETH: "ethereum", ARB: "ethereum", OP: "ethereum", BASE: "ethereum",
  MATIC: "matic-network", BSC: "binancecoin", PLASMA: "plasma",
};

// Gas cost, in gas units, for the two actions the simulation counts against
// a balance: a plain native-coin send (21000 — fixed EVM-wide constant) and
// an ERC-20 transfer() call (65000 — a round, slightly conservative
// estimate; most standard token contracts cost less, some non-standard ones
// cost a bit more, so this errs toward not over-promising tx headroom).
const NATIVE_SEND_GAS = 21_000n;
const ERC20_TRANSFER_GAS = 65_000n;

const providers: Partial<Record<GasChain, ethers.JsonRpcProvider>> = {};
function getProvider(chain: GasChain): ethers.JsonRpcProvider {
  if (!providers[chain]) providers[chain] = new ethers.JsonRpcProvider(GAS_RPC_URLS[chain]);
  return providers[chain]!;
}

// Short-lived in-process caches so a gas-overview call across many
// entities/addresses × chains doesn't fire duplicate price/fee lookups.
const priceCache = new Map<string, { price: number; at: number }>();
const feeCache = new Map<GasChain, { gasPriceWei: bigint; at: number }>();
const CACHE_TTL_MS = 30_000;

async function nativePriceUsd(chain: GasChain): Promise<number> {
  const id = COINGECKO_IDS[chain];
  const cached = priceCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS * 2) return cached.price;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const d = (await r.json()) as Record<string, { usd?: number }>;
    const price = d?.[id]?.usd ?? 0;
    priceCache.set(id, { price, at: Date.now() });
    return price;
  } catch {
    return cached?.price ?? 0;
  }
}

async function currentGasPriceWei(chain: GasChain): Promise<bigint> {
  const cached = feeCache.get(chain);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.gasPriceWei;
  const feeData = await getProvider(chain).getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  feeCache.set(chain, { gasPriceWei, at: Date.now() });
  return gasPriceWei;
}

export type GasRisk = "critical" | "warning" | "healthy" | "unknown";

export interface GasSnapshot {
  chain: GasChain;
  address: string;
  nativeSymbol: string;
  balance: number;               // native coin amount
  balanceUsd: number;
  gasPriceGwei: number;          // current network gas price
  nativeSendCapacity: number;    // how many more plain native sends this balance covers (floor)
  erc20TransferCapacity: number; // how many more ERC-20 transfer() calls this balance covers (floor)
  risk: GasRisk;
  error?: string;
}

// Risk is judged in TRANSACTION COUNT, not USD — that's what makes one
// threshold work fairly across cheap chains (Polygon, BSC, Plasma) and
// expensive ones (Ethereum mainnet) alike: $2 of ETH gas and $2 of POL gas
// buy very different numbers of transactions, but "fewer than 1/5 sends
// left" means the same kind of trouble on any chain.
function riskFor(nativeSendCapacity: number): GasRisk {
  if (nativeSendCapacity < 1) return "critical"; // can't complete even one more send
  if (nativeSendCapacity < 5) return "warning";  // running low
  return "healthy";
}

/** Read-only gas-health snapshot for one address on one chain. Never throws. */
export async function getGasSnapshot(address: string, chain: GasChain): Promise<GasSnapshot> {
  const nativeSymbol = NATIVE_SYMBOL[chain];
  try {
    const [wei, gasPriceWei] = await Promise.all([
      getProvider(chain).getBalance(address),
      currentGasPriceWei(chain),
    ]);
    const balance = parseFloat(ethers.formatEther(wei));
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPriceWei, "gwei"));
    const price = balance > 0 ? await nativePriceUsd(chain) : 0;

    const nativeSendCapacity = gasPriceWei > 0n ? Number(wei / (gasPriceWei * NATIVE_SEND_GAS)) : 0;
    const erc20TransferCapacity = gasPriceWei > 0n ? Number(wei / (gasPriceWei * ERC20_TRANSFER_GAS)) : 0;

    return {
      chain, address, nativeSymbol,
      balance, balanceUsd: parseFloat((balance * price).toFixed(2)),
      gasPriceGwei: parseFloat(gasPriceGwei.toFixed(2)),
      nativeSendCapacity, erc20TransferCapacity,
      risk: riskFor(nativeSendCapacity),
    };
  } catch (err: any) {
    logger.warn({ err: err?.message, address, chain }, "gas-health: RPC read failed");
    return {
      chain, address, nativeSymbol, balance: 0, balanceUsd: 0, gasPriceGwei: 0,
      nativeSendCapacity: 0, erc20TransferCapacity: 0, risk: "unknown", error: err?.message ?? "RPC error",
    };
  }
}

export interface GasOverview {
  totalUsd: number;
  worstRisk: GasRisk;
  snapshots: GasSnapshot[];
}

const RISK_SEVERITY: GasRisk[] = ["critical", "warning", "unknown", "healthy"];

/** Gas snapshots for a set of addresses across a set of chains — deduped, fetched in parallel. */
export async function getGasOverview(addresses: string[], chains: GasChain[]): Promise<GasOverview> {
  const unique = [...new Set(
    addresses.map((a) => a?.trim()).filter((a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a))
  )];
  const jobs: Promise<GasSnapshot>[] = [];
  for (const address of unique) for (const chain of chains) jobs.push(getGasSnapshot(address, chain));
  const snapshots = await Promise.all(jobs);

  const totalUsd = parseFloat(snapshots.reduce((s, r) => s + r.balanceUsd, 0).toFixed(2));
  const worstRisk = snapshots.reduce<GasRisk>(
    (worst, s) => (RISK_SEVERITY.indexOf(s.risk) < RISK_SEVERITY.indexOf(worst) ? s.risk : worst),
    "healthy"
  );
  return { totalUsd, worstRisk, snapshots };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee-tier estimation + speed selection for outgoing transactions (withdrawals).
// Distinct from the balance-risk snapshot above: this is "what will THIS tx
// cost, and how fast", not "how much runway does this address have left".
//
// Public RPCs here don't reliably support eth_feeHistory percentiles, so
// tiers are a fixed multiplier off the provider's current fee estimate —
// the same simplified approach most lightweight wallets use against a
// public endpoint. Good enough for "slow/medium/fast", not a promise of an
// exact confirmation time.
// ─────────────────────────────────────────────────────────────────────────────

export type GasSpeed = "slow" | "medium" | "fast";

const SPEED_MULTIPLIERS: Record<GasSpeed, number> = { slow: 0.85, medium: 1, fast: 1.3 };

// Sanity bounds for an advanced/custom gwei value a user can type in by
// hand — guards against an empty/zero value silently stalling a tx forever,
// and against an obvious typo (e.g. "500" meant as wei) massively overpaying.
const GWEI_FLOOR = 0.001;
const GWEI_CEILING = 5000;
function clampGwei(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return GWEI_FLOOR;
  return Math.min(GWEI_CEILING, Math.max(GWEI_FLOOR, v));
}

export interface GasFeeTier {
  speed: GasSpeed;
  gasPriceGwei: number;              // display value (legacy gasPrice, or maxFeePerGas on EIP-1559 chains)
  maxPriorityFeePerGasGwei?: number; // EIP-1559 chains only
  estimatedNativeCost: number;       // cost of a plain 21000-gas native send at this tier
  estimatedUsdCost: number;
}

export interface GasPriceEstimate {
  chain: GasChain;
  nativeSymbol: string;
  isEip1559: boolean;
  tiers: GasFeeTier[]; // [slow, medium, fast]
  updatedAt: string;
}

/** Live slow/medium/fast fee tiers for one chain — powers the withdraw dialog's speed picker. Never throws. */
export async function getGasPriceEstimate(chain: GasChain): Promise<GasPriceEstimate> {
  const nativeSymbol = NATIVE_SYMBOL[chain];
  try {
    const feeData = await getProvider(chain).getFeeData();
    const isEip1559 = feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null;
    const baseFeeWei = (isEip1559 ? feeData.maxFeePerGas : feeData.gasPrice) ?? feeData.gasPrice ?? 0n;
    const basePriorityWei = feeData.maxPriorityFeePerGas ?? 0n;
    const price = await nativePriceUsd(chain);

    const tiers: GasFeeTier[] = (["slow", "medium", "fast"] as GasSpeed[]).map((speed) => {
      const mult = SPEED_MULTIPLIERS[speed];
      const feeWei = BigInt(Math.round(Number(baseFeeWei) * mult));
      const priorityWei = isEip1559 ? BigInt(Math.round(Number(basePriorityWei) * mult)) : undefined;
      const nativeCost = parseFloat(ethers.formatEther(feeWei * NATIVE_SEND_GAS));
      return {
        speed,
        gasPriceGwei: parseFloat(parseFloat(ethers.formatUnits(feeWei, "gwei")).toFixed(4)),
        maxPriorityFeePerGasGwei: priorityWei != null ? parseFloat(parseFloat(ethers.formatUnits(priorityWei, "gwei")).toFixed(4)) : undefined,
        estimatedNativeCost: nativeCost,
        estimatedUsdCost: parseFloat((nativeCost * price).toFixed(4)),
      };
    });

    return { chain, nativeSymbol, isEip1559, tiers, updatedAt: new Date().toISOString() };
  } catch (err: any) {
    logger.warn({ err: err?.message, chain }, "gas-health: fee estimate failed");
    return { chain, nativeSymbol, isEip1559: false, tiers: [], updatedAt: new Date().toISOString() };
  }
}

export interface GasOverrideRequest {
  speed?: GasSpeed;                   // "slow" | "medium" | "fast" — ignored if any advanced field below is set
  gasPriceGwei?: number;              // advanced: explicit legacy gas price
  maxFeePerGasGwei?: number;          // advanced: explicit EIP-1559 max fee
  maxPriorityFeePerGasGwei?: number;  // advanced: explicit EIP-1559 priority fee
}

export interface GasTxOverrides {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * Turns a speed tier or explicit advanced gwei values into ethers-ready
 * transaction fee overrides for one chain. Returns {} (no overrides — the
 * signer/provider picks, same as before this feature existed) when nothing
 * was requested, i.e. plain "medium"/default withdrawals are unaffected.
 */
export async function resolveGasOverrides(chain: GasChain, req: GasOverrideRequest): Promise<GasTxOverrides> {
  const hasAdvanced = req.gasPriceGwei != null || req.maxFeePerGasGwei != null || req.maxPriorityFeePerGasGwei != null;
  if (!hasAdvanced && (!req.speed || req.speed === "medium")) return {};

  const feeData = await getProvider(chain).getFeeData();
  const isEip1559 = feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null;

  if (hasAdvanced) {
    if (isEip1559 && (req.maxFeePerGasGwei != null || req.maxPriorityFeePerGasGwei != null)) {
      const maxFee = clampGwei(req.maxFeePerGasGwei ?? parseFloat(ethers.formatUnits(feeData.maxFeePerGas!, "gwei")));
      const maxPriority = clampGwei(Math.min(
        req.maxPriorityFeePerGasGwei ?? parseFloat(ethers.formatUnits(feeData.maxPriorityFeePerGas!, "gwei")),
        maxFee
      ));
      return {
        maxFeePerGas: ethers.parseUnits(maxFee.toFixed(9), "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits(maxPriority.toFixed(9), "gwei"),
      };
    }
    const gasPrice = clampGwei(req.gasPriceGwei ?? parseFloat(ethers.formatUnits(feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n, "gwei")));
    return { gasPrice: ethers.parseUnits(gasPrice.toFixed(9), "gwei") };
  }

  // Speed tier — scale the network's current fee estimate by a fixed multiplier.
  const mult = SPEED_MULTIPLIERS[req.speed!];
  if (isEip1559) {
    return {
      maxFeePerGas: BigInt(Math.round(Number(feeData.maxFeePerGas) * mult)),
      maxPriorityFeePerGas: BigInt(Math.round(Number(feeData.maxPriorityFeePerGas) * mult)),
    };
  }
  return { gasPrice: BigInt(Math.round(Number(feeData.gasPrice ?? 0n) * mult)) };
}
