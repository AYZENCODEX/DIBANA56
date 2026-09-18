import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Flame } from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function getDayKey(date: Date) {
  return date.toISOString().split("T")[0];
}

function buildGrid(data: Record<string, number>) {
  const today = new Date();
  const days: { date: Date; key: string; count: number }[] = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = getDayKey(d);
    days.push({ date: d, key, count: data[key] ?? 0 });
  }
  return days;
}

function getColor(count: number) {
  if (count === 0) return "bg-muted/20 border-border/20";
  if (count <= 1) return "bg-primary/25 border-primary/20";
  if (count <= 3) return "bg-primary/50 border-primary/30";
  if (count <= 6) return "bg-primary/75 border-primary/50";
  return "bg-primary border-primary/80";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ActivityHeatmap() {
  const { token } = useAuth();
  const [data, setData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{ key: string; count: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE}/api/history?limit=1000`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const entries = Array.isArray(d) ? d : (d?.entries ?? []);
        const counts: Record<string, number> = {};
        entries.forEach((e: any) => {
          const key = getDayKey(new Date(e.createdAt));
          counts[key] = (counts[key] ?? 0) + 1;
        });
        setData(counts);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  const days = buildGrid(data);
  const totalActivity = Object.values(data).reduce((s, v) => s + v, 0);
  const streak = (() => {
    let s = 0;
    const today = getDayKey(new Date());
    for (let i = 0; i < 365; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = getDayKey(d);
      if (key === today && !data[key]) { if (i === 0) continue; break; }
      if (!data[key]) break;
      s++;
    }
    return s;
  })();

  const weeks: (typeof days)[] = [];
  let week: typeof days = [];
  days.forEach((d, i) => {
    if (i === 0) {
      const pad = d.date.getDay();
      for (let p = 0; p < pad; p++) week.push({ date: new Date(0), key: "", count: -1 });
    }
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  });
  if (week.length) weeks.push(week);

  const monthLabels: { label: string; col: number }[] = [];
  weeks.forEach((w, wi) => {
    const first = w.find(d => d.count >= 0);
    if (first && first.date.getDate() <= 7) {
      const m = first.date.getMonth();
      if (!monthLabels.length || monthLabels[monthLabels.length - 1].label !== MONTHS[m]) {
        monthLabels.push({ label: MONTHS[m], col: wi });
      }
    }
  });

  if (loading) {
    return (
      <div className="bg-card border border-card-border rounded-xl p-4 animate-pulse">
        <div className="h-24 bg-muted/20 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="bg-card border border-card-border rounded-xl p-4 relative">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-orange-400" />
          <span className="font-mono font-bold text-sm text-foreground uppercase tracking-wider">Activity</span>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-mono text-muted-foreground/60">
          {streak > 0 && <span className="text-orange-400 font-bold">{streak} day streak 🔥</span>}
          <span>{totalActivity} actions this year</span>
        </div>
      </div>

      {/* Month labels */}
      <div className="relative overflow-x-auto">
        <div className="flex gap-[3px] mb-1 ml-0">
          {weeks.map((_, wi) => {
            const ml = monthLabels.find(m => m.col === wi);
            return (
              <div key={wi} className="w-3 flex-shrink-0">
                {ml && <span className="font-mono text-[9px] text-muted-foreground/40">{ml.label}</span>}
              </div>
            );
          })}
        </div>

        <div className="flex gap-[3px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((day, di) => (
                <div
                  key={di}
                  className={cn(
                    "w-3 h-3 rounded-sm border transition-all duration-150 cursor-default",
                    day.count < 0 ? "opacity-0" : getColor(day.count),
                    day.count > 0 && "hover:ring-1 hover:ring-primary/50 cursor-pointer"
                  )}
                  onMouseEnter={e => {
                    if (day.count < 0) return;
                    const rect = (e.target as HTMLElement).getBoundingClientRect();
                    setTooltip({ key: day.key, count: day.count, x: rect.left, y: rect.top });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5 mt-2 justify-end">
          <span className="font-mono text-[9px] text-muted-foreground/40">Less</span>
          {[0, 1, 3, 6, 9].map(c => (
            <div key={c} className={cn("w-2.5 h-2.5 rounded-sm border", getColor(c))} />
          ))}
          <span className="font-mono text-[9px] text-muted-foreground/40">More</span>
        </div>
      </div>

      {tooltip && (
        <div
          className="fixed z-50 bg-popover border border-border rounded-lg px-2 py-1.5 shadow-lg pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y - 40 }}
        >
          <div className="font-mono text-[11px] text-foreground">{tooltip.key}</div>
          <div className="font-mono text-[10px] text-muted-foreground">{tooltip.count} action{tooltip.count !== 1 ? "s" : ""}</div>
        </div>
      )}
    </div>
  );
}
