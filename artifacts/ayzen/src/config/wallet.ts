import type { ElementType } from "react";
import { Coins, DollarSign, Zap, TrendingUp } from "lucide-react";

// Config for pages/user/wallets.tsx (on-chain wallet tracker) and
// pages/user/wallet-hub.tsx (internal AZN/USDT/XP/BDT balance hub). See
// UI_CONFIG_PLAN.md Phase D — "Wallet overall" (extends the existing
// CHAINS / CURRENCY_CONFIG that were already array/object literals in
// each page, just not centralized).
//
// These are two distinct domains that happen to live in the same file
// because the plan groups them under one Phase D row: WALLET_CHAINS is
// which on-chain networks a tracked wallet can belong to; WALLET_CURRENCY_CONFIG
// is AYZEN's own internal ledger currencies. No overlap in keys or shape.

// ── On-chain networks (wallets.tsx) ─────────────────────────────────────────
export interface ChainMeta {
  value: string;
  label: string;
  color: string; // hex, used for the network dot
  prefix: string; // address prefix shown in the placeholder (e.g. "0x", "T", "")
  /** Block explorer address-page URL template, {address} is replaced. */
  explorer: string;
  /** Native-coin ticker shown next to balances. Defaults to `value` when omitted
   *  (e.g. "ETH"); set explicitly where the chain id and the coin ticker differ —
   *  e.g. Polygon's chain id stays "MATIC" but the coin is now ticker "POL". */
  nativeSymbol?: string;
}

export const WALLET_CHAINS: ChainMeta[] = [
  { value: "ETH",    label: "Ethereum",         color: "#627EEA", prefix: "0x", explorer: "https://etherscan.io/address/{address}" },
  { value: "BSC",    label: "BNB Chain",        color: "#F3BA2F", prefix: "0x", explorer: "https://bscscan.com/address/{address}", nativeSymbol: "BNB" },
  { value: "MATIC",  label: "Polygon (POL)",    color: "#8247E5", prefix: "0x", explorer: "https://polygonscan.com/address/{address}", nativeSymbol: "POL" },
  { value: "ARB",    label: "Arbitrum",         color: "#28A0F0", prefix: "0x", explorer: "https://arbiscan.io/address/{address}" },
  { value: "PLASMA", label: "Plasma",           color: "#17FEA6", prefix: "0x", explorer: "https://plasmascan.to/address/{address}", nativeSymbol: "XPL" },
  { value: "OP",     label: "Optimism",         color: "#FF0420", prefix: "0x", explorer: "https://optimistic.etherscan.io/address/{address}" },
  { value: "BASE",   label: "Base",             color: "#0052FF", prefix: "0x", explorer: "https://basescan.org/address/{address}" },
  { value: "AVAX",   label: "Avalanche",        color: "#E84142", prefix: "0x", explorer: "https://snowtrace.io/address/{address}" },
  { value: "SOL",    label: "Solana",           color: "#9945FF", prefix: "",   explorer: "https://solscan.io/account/{address}" },
  { value: "BTC",    label: "Bitcoin",          color: "#F7931A", prefix: "",   explorer: "https://mempool.space/address/{address}" },
  { value: "TRX",    label: "TRON",             color: "#EF0027", prefix: "T",  explorer: "https://tronscan.org/#/address/{address}" },
  { value: "LINEA",  label: "Linea",            color: "#61DFFF", prefix: "0x", explorer: "https://lineascan.build/address/{address}" },
  { value: "ZKSYNC", label: "zkSync Era",       color: "#8C8DFC", prefix: "0x", explorer: "https://explorer.zksync.io/address/{address}" },
  { value: "SCROLL", label: "Scroll",           color: "#FFCF70", prefix: "0x", explorer: "https://scrollscan.com/address/{address}" },
  { value: "FTM",    label: "Fantom",           color: "#13B5EC", prefix: "0x", explorer: "https://ftmscan.com/address/{address}" },
];

export function getChainInfo(chain: string): ChainMeta {
  return WALLET_CHAINS.find(c => c.value === chain) ?? {
    value: chain, label: chain, color: "#888", prefix: "", explorer: "https://etherscan.io/address/{address}",
  };
}

/** Native-coin ticker for a chain — e.g. "POL" for MATIC, "BNB" for BSC, else the chain id itself. */
export function getNativeSymbol(chain: string): string {
  return getChainInfo(chain).nativeSymbol ?? chain;
}

export function getExplorerUrl(address: string, chain: string): string {
  return getChainInfo(chain).explorer.replace("{address}", address);
}

// ── Internal ledger currencies (wallet-hub.tsx) ─────────────────────────────
export interface CurrencyMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  hex: string;
  icon: ElementType;
  desc: string;
  emoji: string;
}

export const WALLET_CURRENCY_CONFIG: Record<string, CurrencyMeta> = {
  AZN:  { label: "AZN",  color: "text-cyan-400",    bg: "bg-cyan-500/5",    border: "border-cyan-500/20",    hex: "#22d3ee", icon: Coins,      desc: "AYZEN Token",       emoji: "⚡" },
  USDT: { label: "USDT", color: "text-emerald-400", bg: "bg-emerald-500/5", border: "border-emerald-500/20", hex: "#34d399", icon: DollarSign, desc: "Tether USD",        emoji: "💵" },
  XP:   { label: "XP",   color: "text-violet-400",  bg: "bg-violet-500/5",  border: "border-violet-500/20",  hex: "#a78bfa", icon: Zap,         desc: "Experience Points", emoji: "✨" },
  BDT:  { label: "BDT",  color: "text-amber-400",   bg: "bg-amber-500/5",   border: "border-amber-500/20",   hex: "#fbbf24", icon: TrendingUp,  desc: "AYZEN BDT",         emoji: "💰" },
};
