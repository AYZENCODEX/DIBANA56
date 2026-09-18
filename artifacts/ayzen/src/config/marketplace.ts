import type { ElementType } from "react";
import {
  Shield, Smartphone, Gem, Coins, User, Award, Package,
  Clock, CheckCircle2, XCircle, Zap, X, Star,
  Handshake, Image, Vault, LineChart, AtSign, Hash, Phone, Gamepad2,
} from "lucide-react";

// Shared marketplace config. See UI_CONFIG_PLAN.md Phase C.
//
// pages/user/marketplace.tsx is the "marketplace home" (buy/sell listings
// across entity/local_account/nft/azn/username_nft/badge_nft) and is the
// canonical owner of listing-type + listing-status badge config. Every
// other marketplace-* page either extends this (marketplace-azn.ts, which
// now also powers the renamed P2P Market page) or is a distinct domain that
// gets its own small section below (cross-market order history).

// ── Listing type badge (marketplace.tsx TypeBadge) ─────────────────────────
export interface ListingTypeMeta {
  label: string;
  icon: ElementType;
  color: string;
  bg: string;
}

export const MARKETPLACE_TYPE_CONFIG: Record<string, ListingTypeMeta> = {
  entity:        { label: "Entity",        icon: Shield,     color: "text-cyan-400",    bg: "bg-cyan-400/10" },
  local_account: { label: "Local Account", icon: Smartphone, color: "text-violet-400",  bg: "bg-violet-400/10" },
  nft:           { label: "NFT Pass",      icon: Gem,        color: "text-amber-400",   bg: "bg-amber-400/10" },
  azn:           { label: "AZN Token",     icon: Coins,      color: "text-emerald-400", bg: "bg-emerald-400/10" },
  username_nft:  { label: "Username NFT",  icon: User,       color: "text-cyan-300",    bg: "bg-cyan-300/10" },
  badge_nft:     { label: "Badge NFT",     icon: Award,      color: "text-amber-300",   bg: "bg-amber-300/10" },
  // Admin-only order types (pages/admin/marketplace.tsx order queue) — not
  // sellable listings, so they don't appear in the user-facing create form.
  subscription_pass: { label: "Subscription Pass", icon: Zap,  color: "text-blue-400",  bg: "bg-blue-400/10" },
  lifetime_pass:      { label: "Lifetime Pass",     icon: Star, color: "text-yellow-400", bg: "bg-yellow-400/10" },
};

export function getMarketplaceTypeMeta(type: string): ListingTypeMeta {
  return MARKETPLACE_TYPE_CONFIG[type] ?? { label: type, icon: Package, color: "text-muted-foreground", bg: "" };
}

// ── Listing status badge (marketplace.tsx StatusBadge) ─────────────────────
export interface ListingStatusMeta {
  label: string;
  cls: string;
  icon: ElementType;
}

export const MARKETPLACE_STATUS_CONFIG: Record<string, ListingStatusMeta> = {
  pending:   { label: "Pending",   cls: "text-amber-400 border-amber-400/30",     icon: Clock },
  approved:  { label: "Approved",  cls: "text-emerald-400 border-emerald-400/30", icon: CheckCircle2 },
  rejected:  { label: "Rejected",  cls: "text-red-400 border-red-400/30",         icon: XCircle },
  active:    { label: "Active",    cls: "text-cyan-400 border-cyan-400/30",       icon: Zap },
  sold:      { label: "Sold",      cls: "text-muted-foreground border-border",    icon: CheckCircle2 },
  cancelled: { label: "Cancelled", cls: "text-muted-foreground border-border",    icon: X },
};

export function getMarketplaceStatusMeta(status: string): ListingStatusMeta {
  return MARKETPLACE_STATUS_CONFIG[status] ?? { label: status, cls: "text-muted-foreground", icon: Package };
}

// ── Create Listing modal: expiry options ────────────────────────────────────
export interface ExpiryOption {
  label: string;
  days: number;
}

export const MARKETPLACE_EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: "Never", days: 0 },
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

// ── Cross-market order history (marketplace-order-history.tsx) ─────────────
// Distinct domain from the listing type/status above: this aggregates
// completed orders across every marketplace surface (AZN, NFT, Vault, P2P,
// Polymarket), each with its own "source" and a simpler status set.

export type OrderSource = "azn" | "nft" | "vault" | "p2p" | "polymarket";

export interface OrderSourceMeta {
  label: string;
  icon: ElementType;
  color: string;
}

export const ORDER_SOURCE_META: Record<OrderSource, OrderSourceMeta> = {
  azn:        { label: "AZN Market",   icon: Zap,       color: "text-primary" },
  nft:        { label: "NFT Market",   icon: Image,     color: "text-violet-400" },
  vault:      { label: "Vault Market", icon: Vault,     color: "text-amber-400" },
  p2p:        { label: "P2P Market",   icon: Handshake, color: "text-emerald-400" },
  polymarket: { label: "Polymarket",   icon: LineChart, color: "text-blue-400" },
};

export const ORDER_STATUS_COLOR: Record<string, string> = {
  completed: "text-emerald-400 border-emerald-400/30",
  pending:   "text-amber-400 border-amber-400/30",
  failed:    "text-red-400 border-red-400/30",
};

// ── Wallet hub cards (marketplace-wallet.tsx) ───────────────────────────────
// Distinct from ORDER_SOURCE_META above: this needs a routing href and a
// raw hex color for the balance pie chart, and only covers the markets
// with their own on-platform wallet balance (azn/nft/vault/game — not
// p2p or polymarket).
export interface MarketHubMeta {
  label: string;
  icon: ElementType;
  color: string; // hex, for chart fill
  accent: string;
  border: string;
  bg: string;
  href: string;
}

export const MARKETPLACE_HUB_CONFIG: Record<string, MarketHubMeta> = {
  azn:   { label: "AZN Market",   icon: Zap,   color: "#22d3ee", accent: "text-primary",    border: "border-primary/30",    bg: "bg-primary/10",    href: "/marketplace/azn" },
  nft:   { label: "NFT Market",   icon: Image, color: "#a78bfa", accent: "text-violet-400", border: "border-violet-400/30", bg: "bg-violet-400/10", href: "/marketplace/nft" },
  vault: { label: "Vault Market", icon: Vault, color: "#fbbf24", accent: "text-amber-400",  border: "border-amber-400/30",  bg: "bg-amber-400/10",  href: "/marketplace/vault" },
  game:  { label: "Game Market",  icon: Gamepad2, color: "#818cf8", accent: "text-indigo-400", border: "border-indigo-400/30", bg: "bg-indigo-400/10", href: "/marketplace/game" },
};

// ── Polymarket order fill status (marketplace-polymarket.tsx) ──────────────
// Own small vocabulary (filled/pending/cancelled) — distinct from
// ORDER_STATUS_COLOR's (completed/pending/failed), which is for the
// cross-market order history page.
export const POLYMARKET_STATUS_COLOR: Record<string, string> = {
  filled:    "text-emerald-400 border-emerald-400/30",
  pending:   "text-amber-400 border-amber-400/30",
  cancelled: "text-muted-foreground border-border",
  submitted: "text-cyan-400 border-cyan-400/30",
  failed:    "text-red-400 border-red-400/30",
};

// ── Entity platform meta (marketplace-vault.tsx entity buy/sell flow) ──────
// An entity can carry several platforms at once (unlike a local account,
// which is a single category), so the entity flow works off the vault
// entry's actual platforms instead of a fixed category list. Twitter/
// Discord/Telegram only — "other" platforms are freeform and don't get an
// icon/color here.
export interface EntityPlatformMeta {
  label: string;
  icon: ElementType;
  color: string;
  border: string;
  bg: string;
}

export const ENTITY_PLATFORM_META: Record<string, EntityPlatformMeta> = {
  twitter:  { label: "Twitter",  icon: AtSign, color: "text-sky-400",    border: "border-sky-400/30",    bg: "bg-sky-400/10" },
  discord:  { label: "Discord",  icon: Hash,   color: "text-indigo-400", border: "border-indigo-400/30", bg: "bg-indigo-400/10" },
  telegram: { label: "Telegram", icon: Phone,  color: "text-blue-400",   border: "border-blue-400/30",   bg: "bg-blue-400/10" },
};
