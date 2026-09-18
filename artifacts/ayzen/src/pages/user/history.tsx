import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle2, Clock, XCircle, LogIn, Folder, KeyRound,
  Wallet, Star, Activity, Filter, RefreshCw, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface HistoryItem {
  id: number;
  action: string;
  label: string;
  entityType?: string;
  entityId?: number;
  entityName?: string;
  meta?: Record<string, any>;
  createdAt: string;
}

const ACTION_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  task_submitted:     { icon: Clock,          color: "text-amber-400",   bg: "bg-amber-400/10 border-amber-400/20" },
  task_approved:      { icon: CheckCircle2,   color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/20" },
  task_auto_approved: { icon: CheckCircle2,   color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/20" },
  task_rejected:      { icon: XCircle,        color: "text-red-400",     bg: "bg-red-400/10 border-red-400/20" },
  project_joined:     { icon: Folder,         color: "text-primary",     bg: "bg-primary/10 border-primary/20" },
  login:              { icon: LogIn,           color: "text-violet-400",  bg: "bg-violet-400/10 border-violet-400/20" },
  password_changed:   { icon: KeyRound,       color: "text-yellow-400",  bg: "bg-yellow-400/10 border-yellow-400/20" },
  vault_created:      { icon: Wallet,         color: "text-cyan-400",    bg: "bg-cyan-400/10 border-cyan-400/20" },
  vault_deleted:      { icon: Wallet,         color: "text-red-400",     bg: "bg-red-400/10 border-red-400/20" },
  credit_purchased:   { icon: Star,           color: "text-amber-400",   bg: "bg-amber-400/10 border-amber-400/20" },
  subscription_upgraded: { icon: Star,        color: "text-violet-400",  bg: "bg-violet-400/10 border-violet-400/20" },
};

function getConfig(action: string) {
  return ACTION_CONFIG[action] ?? { icon: Activity, color: "text-muted-foreground", bg: "bg-muted/20 border-border" };
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function groupByDate(items: HistoryItem[]): { label: string; items: HistoryItem[] }[] {
  const groups: Record<string, HistoryItem[]> = {};
  const now = new Date();
  for (const item of items) {
    const d = new Date(item.createdAt);
    const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
    const label = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }
  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

const FILTER_OPTIONS = [
  { value: "", label: "All Activity" },
  { value: "task_submitted", label: "Submitted" },
  { value: "task_approved", label: "Approved" },
  { value: "task_rejected", label: "Rejected" },
  { value: "project_joined", label: "Projects" },
  { value: "login", label: "Logins" },
];

export default function UserHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const params = new URLSearchParams({ limit: "100" });
      if (filter) params.set("action", filter);
      const res = await fetch(`${BASE}/api/history?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setItems(data.items ?? []);
        setTotal(data.total ?? 0);
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);

  const grouped = groupByDate(items);
  const selectedFilter = FILTER_OPTIONS.find(f => f.value === filter);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow">
            Activity Log
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-0.5">
            {total} recorded {total === 1 ? "event" : "events"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="font-mono text-xs gap-1.5 border-border"
              onClick={() => setFilterOpen(o => !o)}
            >
              <Filter className="w-3 h-3" />
              {selectedFilter?.label ?? "All Activity"}
              <ChevronDown className="w-3 h-3" />
            </Button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[150px]">
                {FILTER_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => { setFilter(opt.value); setFilterOpen(false); }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-muted/30 transition-colors",
                      filter === opt.value ? "text-primary" : "text-muted-foreground"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={load} className="font-mono text-xs gap-1.5 border-border">
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5" />
              <div className="space-y-1.5 flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Activity className="w-10 h-10 text-muted-foreground/20 mb-4" />
          <p className="font-mono text-sm text-muted-foreground">No activity recorded yet.</p>
          <p className="font-mono text-xs text-muted-foreground/50 mt-1">
            Start completing tasks and your history will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(group => (
            <div key={group.label}>
              <div className="flex items-center gap-3 mb-4">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                  {group.label}
                </span>
                <div className="flex-1 h-px bg-border/40" />
                <span className="font-mono text-[10px] text-muted-foreground/40">{group.items.length}</span>
              </div>

              <div className="relative">
                <div className="absolute left-[15px] top-0 bottom-0 w-px bg-border/30" />
                <div className="space-y-1">
                  {group.items.map((item, idx) => {
                    const cfg = getConfig(item.action);
                    const Icon = cfg.icon;
                    return (
                      <div
                        key={item.id}
                        className="relative flex items-start gap-3 pl-9 py-2 group animate-slide-up"
                        style={{ animationDelay: `${idx * 30}ms` }}
                      >
                        <div className={cn(
                          "absolute left-0 w-8 h-8 rounded-full border flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-110",
                          cfg.bg
                        )}>
                          <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
                        </div>

                        <div className="flex-1 min-w-0 flex items-center justify-between gap-4 bg-card/40 hover:bg-card/80 border border-border/0 hover:border-border/30 rounded-lg px-3 py-2 transition-all">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-sm font-medium">{item.label}</span>
                              {item.entityName && (
                                <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                                  — {item.entityName}
                                </span>
                              )}
                            </div>
                            {item.meta && Object.keys(item.meta).length > 0 && (
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                {item.meta.xpAmount != null && item.meta.xpAmount > 0 && (
                                  <span className="text-[9px] font-mono text-violet-400">+{item.meta.xpAmount} XP</span>
                                )}
                                {item.meta.reward != null && item.meta.reward > 0 && (
                                  <span className="text-[9px] font-mono text-emerald-400">+${item.meta.reward}</span>
                                )}
                                {item.meta.reason && (
                                  <span className="text-[9px] font-mono text-red-400/70 truncate max-w-[200px]">{item.meta.reason}</span>
                                )}
                              </div>
                            )}
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground/40 flex-shrink-0">
                            {timeAgo(item.createdAt)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
