import { useState, useEffect } from "react";
import { useGetLeaderboard, useGetMe } from "@workspace/api-client-react";
import { useSearch } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Zap, TrendingUp, LayoutList, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const MEDAL_CONFIG: Record<number, { emoji: string; bg: string; text: string; border: string }> = {
  1: { emoji: "🥇", bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/30" },
  2: { emoji: "🥈", bg: "bg-slate-400/10", text: "text-slate-300", border: "border-slate-400/30" },
  3: { emoji: "🥉", bg: "bg-amber-700/10", text: "text-amber-600", border: "border-amber-700/30" },
};

// ─── Entity leaderboard tab ───────────────────────────────────────────────────
function EntityLeaderboard() {
  const [sort, setSort] = useState<"roi" | "completions">("roi");
  const [data, setData] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const { data: me } = useGetMe();

  useEffect(() => {
    setLoading(true);
    fetch(`${BASE}/api/leaderboard/entities?sort=${sort}&limit=100`)
      .then(r => r.ok ? r.json() : [])
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [sort]);

  const myUsername = (me as any)?.username;
  const myEntry = data ? data.find((e: any) => e.username === myUsername) : null;
  const top3 = (data ?? []).slice(0, 3);

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-muted-foreground font-mono text-sm">All entities ranked by performance</p>
        <div className="flex items-center gap-1.5">
          {myEntry && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border border-primary/20 rounded-lg mr-2">
              <TrendingUp className="w-3 h-3 text-primary" />
              <span className="font-mono text-xs">Your entity: <strong className="text-primary">#{myEntry.rank}</strong></span>
            </div>
          )}
          <span className="font-mono text-[10px] text-muted-foreground/50 mr-1">Sort by</span>
          {(["roi", "completions"] as const).map(s => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={cn(
                "font-mono text-[10px] px-2.5 py-1 rounded border transition-all uppercase tracking-wide",
                sort === s
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-card-border bg-muted/5 text-muted-foreground/50 hover:text-foreground"
              )}
            >
              {s === "roi" ? "Net ROI" : "Tasks"}
            </button>
          ))}
        </div>
      </div>

      {/* Podium top 3 */}
      {!loading && top3.length >= 3 && (
        <div className="grid grid-cols-3 gap-3 max-w-sm mx-auto">
          {[top3[1], top3[0], top3[2]].map((entry: any, idx) => {
            const rank = idx === 0 ? 2 : idx === 1 ? 1 : 3;
            const cfg = MEDAL_CONFIG[rank];
            const heights = ["h-24", "h-32", "h-20"];
            const isMe = entry.username === myUsername;
            return (
              <div key={entry.vaultEntryId} className={cn(
                "flex flex-col items-center justify-end rounded-xl border p-3 transition-all",
                cfg.bg, cfg.border, heights[idx], isMe && "ring-2 ring-primary/30"
              )}>
                <div className="text-2xl mb-1">{cfg.emoji}</div>
                <div className={cn("font-mono text-[10px] font-bold truncate max-w-full", cfg.text)}>
                  {entry.entitySerial ?? `#${entry.vaultEntryId}`}
                </div>
                <div className="font-mono text-[8px] text-muted-foreground/50">{entry.username}</div>
                <div className={cn("font-mono text-[9px] font-semibold mt-0.5", entry.totalRoi >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {sort === "roi" ? `$${entry.totalRoi.toFixed(2)}` : `${entry.totalCompletions} tasks`}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full list */}
      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[40px_1fr_80px_70px_72px] gap-2 px-4 py-2 border-b border-card-border bg-muted/5">
          {["Rank", "Entity", "Projects", "Tasks", "Net ROI"].map(h => (
            <div key={h} className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">{h}</div>
          ))}
        </div>
        <div className="divide-y divide-card-border">
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="grid grid-cols-[40px_1fr_80px_70px_72px] gap-2 items-center px-4 py-3">
                <Skeleton className="h-5 w-5 rounded" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))
          ) : !data || data.length === 0 ? (
            <div className="text-center py-12 font-mono text-muted-foreground/50">
              <LayoutList className="w-8 h-8 mx-auto mb-3 opacity-20" />
              No entities found.
            </div>
          ) : (
            data.map((entry: any) => {
              const cfg = MEDAL_CONFIG[entry.rank as number];
              const isMe = entry.username === myUsername;
              return (
                <div
                  key={entry.vaultEntryId}
                  className={cn(
                    "grid grid-cols-[40px_1fr_80px_70px_72px] gap-2 items-center px-4 py-3 hover:bg-muted/20 transition-colors",
                    entry.rank <= 3 && cfg?.bg,
                    isMe && "bg-primary/5 border-l-2 border-primary"
                  )}
                >
                  {/* Rank */}
                  <div className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center font-mono font-black text-xs border shrink-0",
                    cfg ? cn(cfg.bg, cfg.text, cfg.border) : "border-border/30 text-muted-foreground/40"
                  )}>
                    {entry.rank <= 3 ? cfg.emoji : entry.rank}
                  </div>

                  {/* Entity */}
                  <div className="min-w-0">
                    <div className={cn(
                      "font-mono text-sm font-bold truncate",
                      entry.rank <= 3 ? cfg.text : "text-foreground",
                      isMe && "text-primary"
                    )}>
                      {entry.entitySerial ?? `Entity #${entry.vaultEntryId}`}
                      {isMe && <span className="ml-1.5 text-[9px] font-normal text-primary/60">(you)</span>}
                    </div>
                    <div className="font-mono text-[9px] text-muted-foreground/40 truncate">
                      {entry.username} · {entry.category ?? "–"}
                    </div>
                  </div>

                  {/* Projects */}
                  <div className="font-mono text-xs text-muted-foreground/60">{entry.totalProjects}p</div>

                  {/* Tasks */}
                  <div className="font-mono text-xs text-muted-foreground/60 flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5 text-yellow-400/60" />{entry.totalCompletions}
                  </div>

                  {/* ROI */}
                  <div className={cn(
                    "font-mono text-sm font-bold",
                    entry.totalRoi > 0 ? "text-emerald-400" : entry.totalRoi < 0 ? "text-red-400" : "text-muted-foreground/40"
                  )}>
                    {entry.totalRoi >= 0 ? "+" : ""}${entry.totalRoi.toFixed(2)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Operators leaderboard tab ────────────────────────────────────────────────
function OperatorsLeaderboard() {
  const { data, isLoading } = useGetLeaderboard({ period: "all", limit: 50 });
  const { data: me } = useGetMe();
  const myEntry = me && data ? data.find((e: any) => e.username === (me as any).username) : null;
  const top3 = (data ?? []).slice(0, 3);

  return (
    <div className="space-y-5">
      {myEntry && (
        <div className="flex justify-end">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border border-primary/20 rounded-lg">
            <TrendingUp className="w-3 h-3 text-primary" />
            <span className="font-mono text-xs">Your rank: <strong className="text-primary">#{(myEntry as any).rank}</strong></span>
          </div>
        </div>
      )}

      {!isLoading && top3.length >= 3 && (
        <div className="grid grid-cols-3 gap-3 max-w-sm mx-auto">
          {[top3[1], top3[0], top3[2]].map((entry: any, idx) => {
            const rank = idx === 0 ? 2 : idx === 1 ? 1 : 3;
            const cfg = MEDAL_CONFIG[rank];
            const heights = ["h-24", "h-32", "h-20"];
            const isMe = (myEntry as any)?.userId === entry.userId;
            return (
              <div key={entry.userId} className={cn(
                "flex flex-col items-center justify-end rounded-xl border p-3 transition-all",
                cfg.bg, cfg.border, heights[idx], isMe && "ring-2 ring-primary/30"
              )}>
                <div className="text-2xl mb-1">{cfg.emoji}</div>
                <div className={cn("font-mono text-[10px] font-bold truncate max-w-full", cfg.text, isMe && "underline")}>{entry.username}</div>
                <div className="font-mono text-[9px] text-muted-foreground/60">${entry.totalRoi.toLocaleString()}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <div className="divide-y divide-card-border">
          {isLoading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-16 ml-auto" />
              </div>
            ))
          ) : !data || data.length === 0 ? (
            <div className="text-center py-12 font-mono text-muted-foreground/50">
              <Trophy className="w-8 h-8 mx-auto mb-3 opacity-20" />
              Rankings unavailable.
            </div>
          ) : (
            data.map((entry: any) => {
              const cfg = MEDAL_CONFIG[entry.rank as number];
              const isMe = (myEntry as any)?.userId === entry.userId;
              return (
                <div key={entry.userId} className={cn(
                  "flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors",
                  entry.rank <= 3 && cfg?.bg,
                  isMe && "bg-primary/5 border-l-2 border-primary"
                )}>
                  <div className={cn("w-8 h-8 rounded-full flex items-center justify-center font-mono font-black text-sm border shrink-0", cfg ? cn(cfg.bg, cfg.text, cfg.border) : "border-border/30 text-muted-foreground/40")}>
                    {entry.rank <= 3 ? cfg.emoji : entry.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={cn("font-mono text-sm font-bold truncate", entry.rank <= 3 ? cfg?.text : "text-foreground", isMe && "text-primary")}>
                      {entry.username} {isMe && <span className="text-[9px] font-normal text-primary/60">(you)</span>}
                    </div>
                    <div className="font-mono text-[9px] text-muted-foreground/50">{entry.tasksCompleted} tasks</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm font-bold text-primary">${entry.totalRoi.toLocaleString()}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50 flex items-center justify-end gap-1">
                      <Zap className="w-2.5 h-2.5" />{entry.streak ?? 0}d
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function UserLeaderboard() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const initialTab = params.get("tab") === "entities" ? "entities" : "operators";
  const [activeTab, setActiveTab] = useState<"operators" | "entities">(initialTab);

  const TABS = [
    { id: "operators" as const, label: "Operators", icon: Trophy },
    { id: "entities"  as const, label: "Entities",  icon: LayoutList },
  ];

  return (
    <div className="space-y-6 page-enter">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow flex items-center gap-2">
          <Trophy className="h-6 w-6 text-yellow-400" /> Leaderboard
        </h1>
        <p className="text-muted-foreground font-mono text-sm">Global rankings — all time</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/10 border border-card-border rounded-lg p-1 w-fit">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md font-mono text-sm transition-all",
                activeTab === tab.id
                  ? "bg-card border border-card-border text-foreground shadow-sm"
                  : "text-muted-foreground/60 hover:text-foreground"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "operators" ? <OperatorsLeaderboard /> : <EntityLeaderboard />}
    </div>
  );
}
