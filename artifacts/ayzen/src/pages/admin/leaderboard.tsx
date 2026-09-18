import { useGetLeaderboard } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, TrendingUp, Zap, Medal } from "lucide-react";
import { cn } from "@/lib/utils";

const MEDAL_CONFIG: Record<number, { emoji: string; bg: string; text: string; border: string }> = {
  1: { emoji: "🥇", bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/30" },
  2: { emoji: "🥈", bg: "bg-slate-400/10", text: "text-slate-300", border: "border-slate-400/30" },
  3: { emoji: "🥉", bg: "bg-amber-700/10", text: "text-amber-600", border: "border-amber-700/30" },
};

export default function AdminLeaderboard() {
  const { data, isLoading } = useGetLeaderboard({ period: "all", limit: 100 });

  const top3 = (data ?? []).slice(0, 3);
  const rest = (data ?? []).slice(3);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Trophy className="h-6 w-6 text-yellow-400" /> Global Leaderboard
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Top operator performance rankings — all time</p>
        </div>
        {data && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-card border border-card-border rounded-lg">
            <TrendingUp className="w-3.5 h-3.5 text-primary" />
            <span className="font-mono text-xs text-muted-foreground">{data.length} operators ranked</span>
          </div>
        )}
      </div>

      {/* Podium top 3 */}
      {!isLoading && top3.length >= 3 && (
        <div className="grid grid-cols-3 gap-3 max-w-lg mx-auto">
          {[top3[1], top3[0], top3[2]].map((entry: any, idx) => {
            const rank = idx === 0 ? 2 : idx === 1 ? 1 : 3;
            const cfg = MEDAL_CONFIG[rank];
            const heights = ["h-24", "h-32", "h-20"];
            return (
              <div key={entry.userId} className={cn("flex flex-col items-center justify-end rounded-xl border p-3 transition-all", cfg.bg, cfg.border, heights[idx])}>
                <div className="text-2xl mb-1">{cfg.emoji}</div>
                <div className={cn("font-mono text-[11px] font-bold truncate max-w-full", cfg.text)}>{entry.username}</div>
                <div className="font-mono text-[9px] text-muted-foreground/60">${entry.totalRoi.toLocaleString()}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full table */}
      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center gap-2">
          <Medal className="w-4 h-4 text-primary" />
          <span className="font-mono text-sm font-bold uppercase tracking-wide">Full Rankings</span>
        </div>
        <div className="divide-y divide-card-border">
          {isLoading ? (
            Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-6 w-6 rounded-full" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16 ml-auto" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-8" />
              </div>
            ))
          ) : !data || data.length === 0 ? (
            <div className="text-center py-12 font-mono text-muted-foreground/50">
              <Trophy className="w-8 h-8 mx-auto mb-3 opacity-20" />
              Insufficient data to generate rankings.
            </div>
          ) : (
            data.map((entry: any) => {
              const cfg = MEDAL_CONFIG[entry.rank as number];
              return (
                <div key={entry.userId} className={cn("flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors", entry.rank <= 3 && cfg.bg)}>
                  <div className={cn("w-8 h-8 rounded-full flex items-center justify-center font-mono font-black text-sm border shrink-0", cfg ? cn(cfg.bg, cfg.text, cfg.border) : "border-border/30 text-muted-foreground/40")}>
                    {entry.rank <= 3 ? cfg.emoji : entry.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={cn("font-mono text-sm font-bold truncate", entry.rank <= 3 ? cfg.text : "text-foreground")}>{entry.username}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50">{entry.tasksCompleted} tasks</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm font-bold text-primary">${entry.totalRoi.toLocaleString()}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50 flex items-center justify-end gap-1">
                      <Zap className="w-2.5 h-2.5" />{entry.streak ?? 0}d streak
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
