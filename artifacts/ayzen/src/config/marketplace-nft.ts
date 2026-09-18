import type { ElementType } from "react";
import { User, Gem, TrendingUp, Zap, Award, Wallet } from "lucide-react";
import { AZN_PAYMENT_METHODS } from "@/config/marketplace-azn";

// Config shared by pages/user/marketplace-nft.tsx and
// pages/user/nft-marketplace.tsx. See UI_CONFIG_PLAN.md Phase C —
// "NFT marketplace".

// ── Rarity badge (marketplace-nft.tsx) ──────────────────────────────────────
export interface RarityMeta {
  label: string;
  color: string; // full badge className (text/border/bg, some include animate-pulse)
}

export const NFT_RARITY_CONFIG: Record<string, RarityMeta> = {
  common:    { label: "Common",    color: "text-muted-foreground border-border/40 bg-muted/10" },
  uncommon:  { label: "Uncommon",  color: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5" },
  rare:      { label: "Rare",      color: "text-blue-400 border-blue-400/30 bg-blue-400/5" },
  epic:      { label: "Epic",      color: "text-violet-400 border-violet-400/30 bg-violet-400/5" },
  legendary: { label: "Legendary", color: "text-amber-400 border-amber-400/30 bg-amber-400/10 animate-pulse" },
  mythic:    { label: "Mythic",    color: "text-red-400 border-red-500/30 bg-red-500/10" },
};

export function getNftRarityMeta(rarity: string): RarityMeta {
  return NFT_RARITY_CONFIG[rarity] ?? { label: rarity, color: "text-muted-foreground border-border/40 bg-muted/10" };
}

// ── Category icon lookup (nft-marketplace.tsx, DB-driven categories) ───────
export const NFT_CATEGORY_ICONS: Record<string, ElementType> = {
  user: User, gem: Gem, infinity: TrendingUp, zap: Zap, award: Award, wallet: Wallet,
};

export function getNftCategoryIcon(icon?: string): ElementType {
  return NFT_CATEGORY_ICONS[icon ?? "gem"] ?? Gem;
}

// ── Payment methods (nft-marketplace.tsx buy/checkout) ──────────────────────
// AZN itself (fee-free, self-currency) plus the same gateways used for AZN
// buy/sell listings — reuses AZN_PAYMENT_METHODS from
// config/marketplace-azn.ts instead of re-declaring binance/bkash/nagad a
// second time. Adding a checkout payment method here is one entry.
export const NFT_PAYMENT_METHODS = [
  { id: "azn", label: "AZN", icon: Zap, color: "text-primary", border: "border-primary/30", bg: "bg-primary/10", fee: 0 },
  ...AZN_PAYMENT_METHODS,
];
