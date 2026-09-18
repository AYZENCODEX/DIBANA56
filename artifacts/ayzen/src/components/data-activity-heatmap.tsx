// data-activity-heatmap.tsx
// ─────────────────────────────────────────────
// Data-driven activity heatmap — renders a { day, count }[] series as a
// 53-week GitHub-style contribution grid. Extracted out of
// pages/user/project-detail.tsx (where it was previously a private,
// non-exported component) so Phase 9A's Projects Overview page
// (pages/user/enroll-projects.tsx) can reuse the exact same chart instead
// of building a second heatmap implementation. project-detail.tsx now
// imports this instead of defining its own copy.
//
// Not to be confused with components/activity-heatmap.tsx's <ActivityHeatmap />,
// which self-fetches the user's global /history feed — this one is a pure
// presentational component driven entirely by the `activity` prop, for
// callers (like this one) that already have day-bucketed counts from their
// own endpoint.
import { cn } from "@/lib/utils";

export function DataActivityHeatmap({
  activity, label = "Activity — Past Year", unitLabel = "task",
}: {
  activity: { day: string; count: number }[];
  label?: string;
  unitLabel?: string;
}) {
  const actMap = new Map(activity.map(a => [a.day, a.count]));
  const today = new Date();
  const maxCount = Math.max(...activity.map(a => a.count), 1);

  // Build 53 weeks starting from the most recent Sunday - 52 weeks ago
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 52 * 7 - startDate.getDay());

  const weeks: string[][] = [];
  const cur = new Date(startDate);
  for (let w = 0; w < 53; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(cur.toISOString().split("T")[0]);
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  // Month labels: find weeks where month changes
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthLabels: { wi: number; label: string }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const m = new Date(week[0]).getMonth();
    if (m !== lastMonth) { monthLabels.push({ wi, label: MONTHS[m] }); lastMonth = m; }
  });

  const cellColor = (count: number): string => {
    if (count === 0) return "bg-muted/20";
    const pct = count / maxCount;
    if (pct <= 0.25) return "bg-emerald-500/30";
    if (pct <= 0.5)  return "bg-emerald-500/55";
    if (pct <= 0.75) return "bg-emerald-400/75";
    return "bg-emerald-400";
  };

  const totalContributions = activity.reduce((s, a) => s + a.count, 0);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">{label}</div>
        <div className="font-mono text-[9px] text-muted-foreground/40">{totalContributions} {unitLabel}{totalContributions !== 1 ? "s" : ""}</div>
      </div>
      <div className="bg-muted/5 border border-card-border rounded-lg p-3 overflow-x-auto">
        {/* Month labels row */}
        <div className="flex gap-[3px] mb-1 ml-[22px]">
          {weeks.map((_, wi) => {
            const found = monthLabels.find(m => m.wi === wi);
            return (
              <div key={wi} className="w-[11px] flex-shrink-0 text-[7px] font-mono text-muted-foreground/40 leading-none">
                {found ? found.label : ""}
              </div>
            );
          })}
        </div>
        {/* Grid */}
        <div className="flex gap-[3px]">
          {/* Day-of-week labels */}
          <div className="flex flex-col gap-[3px] mr-1 flex-shrink-0">
            {["S","M","T","W","T","F","S"].map((d, i) => (
              <div key={i} className="w-[14px] h-[11px] text-[7px] font-mono text-muted-foreground/30 flex items-center justify-end leading-none pr-0.5">
                {i % 2 === 1 ? d : ""}
              </div>
            ))}
          </div>
          {/* Week columns */}
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px] flex-shrink-0">
              {week.map(day => {
                const count = actMap.get(day) ?? 0;
                const isFuture = day > today.toISOString().split("T")[0];
                return (
                  <div
                    key={day}
                    title={`${day}: ${count} ${unitLabel}${count !== 1 ? "s" : ""}`}
                    className={cn(
                      "w-[11px] h-[11px] rounded-[2px] transition-all cursor-default",
                      isFuture ? "opacity-0" : cellColor(count)
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-1 justify-end mt-2">
          <span className="font-mono text-[7px] text-muted-foreground/30">Less</span>
          {["bg-muted/20", "bg-emerald-500/30", "bg-emerald-500/55", "bg-emerald-400/75", "bg-emerald-400"].map((c, i) => (
            <div key={i} className={cn("w-[11px] h-[11px] rounded-[2px]", c)} />
          ))}
          <span className="font-mono text-[7px] text-muted-foreground/30">More</span>
        </div>
      </div>
    </div>
  );
}
