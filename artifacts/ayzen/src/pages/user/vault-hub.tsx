/**
 * pages/user/vault-hub.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Landing page for the whole Vault section — mounted at /vault/hub, and what
 * clicking the "Vault" group in the main app sidebar (app-sidebar.tsx)
 * navigates to. Mirrors the public landing page's hero + feature-grid feel,
 * but in the app's own dark/mono theme, and the four cards below map 1:1
 * onto the 4-step Vault sidebar (components/layout/vault-sidebar.tsx —
 * STEP 01 Account · 02 Access · 03 Enrollment · 04 Other) so this page and
 * the in-page VaultSidebar never drift out of sync.
 */
import { Link } from "wouter";
import { useEffect, useState } from "react";
import { useListVaultEntries } from "@workspace/api-client-react";
import {
  Vault, Shield, Smartphone, ShieldCheck, Gamepad2,
  Key, Mail, Wallet, UserPlus, LayoutDashboard, Link2, FolderGit2,
  Share2, Ban, Trash2, History, Lock, ArrowRight,
} from "lucide-react";

interface HubCard {
  step: string;
  href: string;
  icon: React.ElementType;
  title: string;
  description: string;
  chips: { label: string; icon: React.ElementType }[];
  color: "cyan" | "violet";
}

const CARDS: HubCard[] = [
  {
    step: "01", href: "/vault?tab=entity", icon: Shield, title: "Account",
    description: "Every entity, local account, KYC document, and game account you're storing in the vault.",
    chips: [
      { label: "Entity", icon: Shield }, { label: "Local", icon: Smartphone },
      { label: "KYC", icon: ShieldCheck }, { label: "Game", icon: Gamepad2 },
    ],
    color: "cyan",
  },
  {
    step: "02", href: "/vault/2fa/overview", icon: Key, title: "Access",
    description: "2FA codes, backup codes, connected mail inboxes, and every wallet address & seed on file.",
    chips: [
      { label: "2FA", icon: ShieldCheck }, { label: "Backup Code", icon: Key },
      { label: "Mail Hub", icon: Mail }, { label: "Wallet Hub", icon: Wallet },
    ],
    color: "violet",
  },
  {
    step: "03", href: "/vault/enrollment/overview", icon: UserPlus, title: "Enrollment",
    description: "Which entities are enrolled in which projects, linked accounts, and per-project reward totals.",
    chips: [
      { label: "Overview", icon: LayoutDashboard }, { label: "Enroll", icon: UserPlus },
      { label: "Linked", icon: Link2 }, { label: "Project", icon: FolderGit2 },
    ],
    color: "cyan",
  },
  {
    step: "04", href: "/vault/security", icon: Lock, title: "Other",
    description: "Sharing, the banned/trash bins, the full activity log, and vault-wide security settings.",
    chips: [
      { label: "Shared", icon: Share2 }, { label: "Banned", icon: Ban },
      { label: "Trash", icon: Trash2 }, { label: "Activity Log", icon: History },
    ],
    color: "violet",
  },
];

function useCountUpLocal(target: number, ms = 900) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!target) { setVal(0); return; }
    let start = 0;
    const step = Math.max(1, Math.ceil(target / 30));
    const id = setInterval(() => { start = Math.min(start + step, target); setVal(start); if (start >= target) clearInterval(id); }, ms / 30);
    return () => clearInterval(id);
  }, [target, ms]);
  return val;
}

export default function VaultHub() {
  const { data, isLoading } = useListVaultEntries();
  const entities: any[] = Array.isArray(data) ? data : [];
  const entityCount = useCountUpLocal(entities.length);

  return (
    <div className="space-y-8 page-enter">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.06] via-transparent to-violet-500/[0.06] px-6 py-10 sm:px-10 sm:py-14 text-center">
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "36px 36px" }} />
        <div className="relative">
          <div className="inline-flex items-center gap-2 border border-primary/20 bg-primary/5 rounded-full px-3.5 py-1 mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-primary">Vault · Command Center</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-mono font-bold tracking-tighter text-foreground mb-3 flex items-center justify-center gap-3">
            <Vault className="w-7 h-7 text-primary" /> Your Vault
          </h1>
          <p className="text-sm text-muted-foreground font-mono max-w-xl mx-auto leading-relaxed mb-6">
            Everything encrypted and stored under your account — accounts, access credentials, project enrollment, and vault-wide management — organized into four steps below.
          </p>
          <div className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70">
            <span className="text-2xl font-bold text-primary tabular-nums">{isLoading ? "—" : entityCount}</span>
            <span className="uppercase tracking-widest">entities secured</span>
          </div>
        </div>
      </div>

      {/* Step cards — mirrors VaultSidebar's 4-step structure 1:1 */}
      <div className="grid sm:grid-cols-2 gap-4">
        {CARDS.map(card => {
          const Icon = card.icon;
          const isCyan = card.color === "cyan";
          return (
            <Link key={card.step} href={card.href}>
              <div className={`group relative h-full rounded-xl border p-5 cursor-pointer transition-all hover:-translate-y-0.5 ${
                isCyan ? "border-cyan-900/40 hover:border-cyan-500/40 hover:shadow-[0_0_24px_rgba(34,211,238,0.08)]"
                       : "border-violet-900/40 hover:border-violet-500/40 hover:shadow-[0_0_24px_rgba(167,139,250,0.08)]"
              } bg-card`}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`font-mono text-[9px] font-bold tabular-nums ${isCyan ? "text-cyan-400/50" : "text-violet-400/50"}`}>{card.step}</span>
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                      isCyan ? "bg-cyan-500/10 border-cyan-500/20" : "bg-violet-500/10 border-violet-500/20"
                    }`}>
                      <Icon className={`w-4 h-4 ${isCyan ? "text-cyan-400" : "text-violet-400"}`} />
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                </div>
                <h3 className="font-mono font-bold text-base text-foreground mb-1.5">{card.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed mb-4">{card.description}</p>
                <div className="flex flex-wrap gap-1.5">
                  {card.chips.map(chip => (
                    <span key={chip.label} className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 border border-border/30 rounded-full px-2 py-0.5">
                      <chip.icon className="w-2.5 h-2.5" /> {chip.label}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
