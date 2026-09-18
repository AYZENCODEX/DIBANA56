import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Search, LayoutDashboard, Shield, FolderOpen, Settings,
  Terminal, ChevronRight, Zap, Activity, Wallet, BookOpen,
  Flame, CheckCircle2, Loader2, Coins, Bookmark,
  Store, Users, ArrowRight,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const QUICK_LINKS = [
  {
    label: "Dashboard",
    icon: LayoutDashboard,
    href: "/dashboard",
    desc: "ROI overview & analytics",
    color: "from-primary/15 to-primary/5 border-primary/30 hover:border-primary/60",
    iconColor: "text-primary",
  },
  {
    label: "Vault",
    icon: Shield,
    href: "/vault",
    desc: "Credentials & accounts",
    color: "from-violet-500/15 to-violet-500/5 border-violet-500/30 hover:border-violet-500/60",
    iconColor: "text-violet-400",
  },
  {
    label: "Projects",
    icon: FolderOpen,
    href: "/projects",
    desc: "Airdrop protocols",
    color: "from-cyan-500/15 to-cyan-500/5 border-cyan-500/30 hover:border-cyan-500/60",
    iconColor: "text-cyan-400",
  },
  {
    label: "Settings",
    icon: Settings,
    href: "/settings",
    desc: "Preferences & config",
    color: "from-amber-500/15 to-amber-500/5 border-amber-500/30 hover:border-amber-500/60",
    iconColor: "text-amber-400",
  },
];

const ALL_LINKS = [
  ...QUICK_LINKS,
  { label: "Tasks",       icon: Zap,      href: "/tasks",        desc: "Task center & submissions",       color: "from-emerald-500/15 to-emerald-500/5 border-emerald-500/30 hover:border-emerald-500/60", iconColor: "text-emerald-400" },
  { label: "Leaderboard", icon: Activity, href: "/leaderboard",  desc: "Rankings & scores",               color: "from-orange-500/15 to-orange-500/5 border-orange-500/30 hover:border-orange-500/60",  iconColor: "text-orange-400" },
  { label: "Wallets",     icon: Wallet,   href: "/wallets",      desc: "Multi-chain wallet tracker",     color: "from-sky-500/15 to-sky-500/5 border-sky-500/30 hover:border-sky-500/60",          iconColor: "text-sky-400" },
  { label: "History",     icon: BookOpen, href: "/history",      desc: "Activity log & timeline",        color: "from-rose-500/15 to-rose-500/5 border-rose-500/30 hover:border-rose-500/60",       iconColor: "text-rose-400" },
  { label: "P2P Market",  icon: Store,    href: "/marketplace",  desc: "Buy & sell airdrop assets",      color: "from-teal-500/15 to-teal-500/5 border-teal-500/30 hover:border-teal-500/60",      iconColor: "text-teal-400" },
  { label: "Teams",       icon: Users,    href: "/teams",        desc: "Collaborate with operators",     color: "from-indigo-500/15 to-indigo-500/5 border-indigo-500/30 hover:border-indigo-500/60", iconColor: "text-indigo-400" },
  { label: "Watchlist",   icon: Bookmark, href: "/watchlist",    desc: "Bookmarked projects",            color: "from-pink-500/15 to-pink-500/5 border-pink-500/30 hover:border-pink-500/60",      iconColor: "text-pink-400" },
  { label: "Check-in",    icon: Flame,    href: "/checkin",      desc: "Daily streak & rewards",         color: "from-orange-500/15 to-orange-500/5 border-orange-500/30 hover:border-orange-500/60", iconColor: "text-orange-400" },
];

interface CheckinStatus {
  checkedInToday: boolean;
  currentStreak: number;
  nextXP: number;
  nextAZN: number;
  nextMilestone: string | null;
}

function CheckinWidget({ token }: { token: string }) {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<CheckinStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/checkin/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); setStatus(d); setDone(d.checkedInToday); }
    } catch { }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const doCheckin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setChecking(true);
    try {
      const r = await fetch(`${BASE}/api/checkin`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { setDone(true); await load(); }
    } catch { }
    setChecking(false);
  };

  return (
    <div
      onClick={() => setLocation("/checkin")}
      className={cn(
        "relative overflow-hidden rounded-xl border p-4 cursor-pointer transition-all group",
        done
          ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/50"
          : "border-orange-500/30 bg-orange-500/5 hover:border-orange-500/60"
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-10 h-10 rounded-xl flex items-center justify-center border flex-shrink-0",
          done ? "border-emerald-500/30 bg-emerald-500/10" : "border-orange-500/30 bg-orange-500/10"
        )}>
          {done
            ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            : <Flame className={cn("w-5 h-5 text-orange-400", !done && "animate-pulse")} />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-sm text-foreground">Daily Check-in</span>
            {status && (
              <Badge variant="outline" className={cn(
                "text-[9px] font-mono",
                status.currentStreak >= 7  ? "border-yellow-400/30 text-yellow-400" :
                status.currentStreak >= 3  ? "border-orange-400/30 text-orange-400" :
                "border-muted/30 text-muted-foreground"
              )}>
                🔥 {status.currentStreak}d streak
              </Badge>
            )}
          </div>
          <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
            {done
              ? "Claimed today! Come back tomorrow."
              : status
              ? `Claim +${status.nextXP} XP · +${status.nextAZN} AZN${status.nextMilestone ? ` · 🎉 ${status.nextMilestone}` : ""}`
              : "Claim your daily reward"
            }
          </p>
        </div>
        {!done && (
          <Button
            size="sm"
            onClick={doCheckin}
            disabled={checking}
            className="text-xs font-mono gap-1 h-8 flex-shrink-0"
          >
            {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            {checking ? "..." : "Claim"}
          </Button>
        )}
        {done && (
          <ArrowRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 flex-shrink-0 transition-colors" />
        )}
      </div>
      {status?.nextMilestone && !done && (
        <div className="mt-2 pt-2 border-t border-orange-500/10">
          <p className="font-mono text-[9px] text-orange-400/80">🎯 Milestone today: {status.nextMilestone}</p>
        </div>
      )}
    </div>
  );
}

export default function UserHome() {
  const [, setLocation] = useLocation();
  const { user, token } = useAuth() as any;
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? ALL_LINKS.filter(l =>
        l.label.toLowerCase().includes(search.toLowerCase()) ||
        l.desc.toLowerCase().includes(search.toLowerCase())
      )
    : QUICK_LINKS;

  const showingAll = Boolean(search.trim());

  return (
    <div className="space-y-8 max-w-3xl mx-auto py-4">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary/60" />
          <span className="font-mono text-[10px] text-primary/60 uppercase tracking-widest">
            OPERATOR WORKSPACE
          </span>
        </div>
        <h1 className="font-mono font-black text-4xl md:text-5xl tracking-tight text-foreground leading-none">
          AYZEN{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-violet-400">
            WORKSPACE
          </span>
        </h1>
        <p className="font-mono text-sm text-muted-foreground/60 max-w-md">
          {user?.username
            ? `Welcome back, ${user.username}. Command center ready.`
            : "Crypto airdrop command center."}
        </p>
      </div>

      {/* ── Daily Check-in widget ────────────────────────────────── */}
      {token && <CheckinWidget token={token} />}

      {/* ── Search ──────────────────────────────────────────────── */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground/40 pointer-events-none" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === "Escape" && setSearch("")}
          placeholder="Search workspace — Dashboard, Vault, Tasks, Market…"
          className="h-13 pl-12 pr-6 font-mono text-sm bg-card border-card-border rounded-xl focus-visible:ring-primary/30 focus-visible:border-primary/50 h-[3.25rem]"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground/40 hover:text-muted-foreground border border-border/40 rounded px-1.5 py-0.5 transition-colors"
          >
            ESC
          </button>
        )}
      </div>

      {/* ── Quick Launch / Search Results ───────────────────────── */}
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 mb-3">
          {showingAll ? `Results for "${search}"` : "Quick Launch"}
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center font-mono text-sm text-muted-foreground/40 border border-dashed border-border/30 rounded-xl">
            No matches for &ldquo;{search}&rdquo;
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {filtered.map(link => {
              const Icon = link.icon;
              return (
                <button
                  key={link.href}
                  onClick={() => setLocation(link.href)}
                  className={cn(
                    "p-5 rounded-xl border bg-gradient-to-br text-left transition-all duration-200",
                    "hover:scale-[1.03] hover:shadow-xl hover:shadow-black/20 group",
                    link.color
                  )}
                >
                  <Icon className={cn("w-6 h-6 mb-3 transition-colors", link.iconColor)} />
                  <div className="font-mono font-bold text-sm text-foreground">{link.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5 leading-relaxed">
                    {link.desc}
                  </div>
                  <ChevronRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-foreground/50 mt-2 transition-colors" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Status strip ─────────────────────────────────────────── */}
      <div className="flex items-center gap-4 py-2 border-t border-border/20">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
        <span className="text-[9px] font-mono text-muted-foreground/30 tracking-widest">
          AYZEN PROTOCOL
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
      </div>
    </div>
  );
}
