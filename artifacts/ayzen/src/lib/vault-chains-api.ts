/**
 * lib/vault-chains-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around GET /wallets/vault-chains (routes/wallets.ts) — the
 * live list of networks + currencies the built-in AYZEN custodial wallet
 * (Account Wallet / Vault Wallet) supports for deposit and withdrawal.
 * Same hand-written customFetch pattern as wallet-worth-api.ts.
 *
 * Used to build a single "network + currency" picker instead of hardcoding
 * chain/token lists in multiple pages — the backend (lib/tokens.ts) is the
 * source of truth, so this always reflects what deposits are actually
 * watched for and what withdrawals will actually resolve.
 */
import { customFetch } from "@workspace/api-client-react";

export interface VaultChainToken {
  symbol: string;
  decimals: number;
  /** Public on-chain contract address — needed to build a client-signed (MetaMask) ERC-20 transfer. */
  contract: string;
}

export interface VaultChain {
  chain: string;           // "ETH" | "BSC" | "MATIC" | "PLASMA" | "ARB"
  nativeSymbol: string;    // "ETH" | "BNB" | "POL" | "XPL" | "ETH" (Arbitrum gas is still ETH)
  chainId: number;
  confirmationsRequired: number;
  tokens: VaultChainToken[]; // ERC-20s watched on this chain, e.g. USDT, ARB
}

let cache: VaultChain[] | null = null;
let inflight: Promise<VaultChain[]> | null = null;

/** Fetches (and caches for the session) the supported network/currency list. */
export function getVaultChains(): Promise<VaultChain[]> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (customFetch("/api/wallets/vault-chains") as Promise<VaultChain[]>)
    .then((data) => { cache = data; inflight = null; return data; })
    .catch((err) => { inflight = null; throw err; });
  return inflight;
}

/** Every currency symbol available across all chains, native coins first, USDT/ARB after — deduped. */
export function flattenCurrencies(chains: VaultChain[]): { symbol: string; chain: string }[] {
  const natives = chains.map((c) => ({ symbol: c.nativeSymbol, chain: c.chain }));
  const tokens = chains.flatMap((c) => c.tokens.map((t) => ({ symbol: t.symbol, chain: c.chain })));
  const seen = new Set<string>();
  return [...natives, ...tokens].filter((c) => {
    const key = `${c.symbol}:${c.chain}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
