/**
 * pages/user/marketplace-hub.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Landing page for the whole Market section — mounted at /marketplace/hub,
 * and what clicking the "Market" group in the main app sidebar
 * (app-sidebar.tsx) navigates to. Cards map 1:1 onto the Market sidebar tree
 * (Official Market · Vault Market · Polymarket · P2P Market · Market Wallet ·
 * Order History) so this page never drifts out of sync with the sidebar.
 */
import { Link } from "wouter";
import {
  Store, DollarSign, Vault, Shield, Smartphone, ShieldCheck, Gamepad2,
  LineChart, BarChart3, Wallet, Bot as BotIcon, History, Handshake, ArrowRight,
} from "lucide-react";

interface HubCard {
  href: string;
  icon: React.ElementType;
  title: string;
  description: string;
  chips: { label: string; icon: React.ElementType }[];
  color: "cyan" | "violet";
}

const CARDS: HubCard[] = [
  {
    href: "/marketplace/azn", icon: DollarSign, title: "Official Market",
    description: "AYZEN's own AZN token market — buy and sell AZN directly at the official rate.",
    chips: [], color: "cyan",
  },
  {
    href: "/marketplace/vault?type=entity", icon: Vault, title: "Vault Market",
    description: "Buy and sell vault items — entities, local accounts, KYC docs, and game accounts.",
    chips: [
      { label: "Entity", icon: Shield }, { label: "Local", icon: Smartphone },
      { label: "KYC", icon: ShieldCheck }, { label: "Game", icon: Gamepad2 },
    ],
    color: "violet",
  },
  {
    href: "/marketplace/polymarket?tab=overview", icon: LineChart, title: "Polymarket",
    description: "Prediction markets — track positions, place trades, and review your order history.",
    chips: [
      { label: "Overview", icon: BarChart3 }, { label: "Market", icon: LineChart },
      { label: "Wallet", icon: Wallet }, { label: "AI Agent", icon: BotIcon },
    ],
    color: "cyan",
  },
  {
    href: "/marketplace", icon: Handshake, title: "P2P Market",
    description: "Peer-to-peer listings from other operators — browse, list, and negotiate directly.",
    chips: [], color: "violet",
  },
  {
    href: "/marketplace/wallet", icon: Wallet, title: "Market Wallet",
    description: "Your dedicated marketplace balance — deposits, withdrawals, and trade history.",
    chips: [], color: "cyan",
  },
  {
    href: "/marketplace/order-history", icon: History, title: "Order History",
    description: "Every order you've placed or fulfilled across the marketplace, in one list.",
    chips: [], color: "violet",
  },
];

export default function MarketHub() {
  return (
    <div className="space-y-8 page-enter">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.06] via-transparent to-violet-500/[0.06] px-6 py-10 sm:px-10 sm:py-14 text-center">
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "36px 36px" }} />
        <div className="relative">
          <div className="inline-flex items-center gap-2 border border-primary/20 bg-primary/5 rounded-full px-3.5 py-1 mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-primary">Market · Live</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-mono font-bold tracking-tighter text-foreground mb-3 flex items-center justify-center gap-3">
            <Store className="w-7 h-7 text-primary" /> Market
          </h1>
          <p className="text-sm text-muted-foreground font-mono max-w-xl mx-auto leading-relaxed">
            Trade AZN, vault items, and prediction markets, or deal peer-to-peer with other operators — pick where you want to go below.
          </p>
        </div>
      </div>

      {/* Cards — mirror app-sidebar.tsx's Market group 1:1 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {CARDS.map(card => {
          const Icon = card.icon;
          const isCyan = card.color === "cyan";
          return (
            <Link key={card.href} href={card.href}>
              <div className={`group relative h-full rounded-xl border p-5 cursor-pointer transition-all hover:-translate-y-0.5 ${
                isCyan ? "border-cyan-900/40 hover:border-cyan-500/40 hover:shadow-[0_0_24px_rgba(34,211,238,0.08)]"
                       : "border-violet-900/40 hover:border-violet-500/40 hover:shadow-[0_0_24px_rgba(167,139,250,0.08)]"
              } bg-card`}>
                <div className="flex items-start justify-between mb-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                    isCyan ? "bg-cyan-500/10 border-cyan-500/20" : "bg-violet-500/10 border-violet-500/20"
                  }`}>
                    <Icon className={`w-4 h-4 ${isCyan ? "text-cyan-400" : "text-violet-400"}`} />
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                </div>
                <h3 className="font-mono font-bold text-base text-foreground mb-1.5">{card.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed mb-4">{card.description}</p>
                {card.chips.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {card.chips.map(chip => (
                      <span key={chip.label} className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 border border-border/30 rounded-full px-2 py-0.5">
                        <chip.icon className="w-2.5 h-2.5" /> {chip.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
