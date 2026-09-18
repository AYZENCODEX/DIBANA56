import { useGetMe, useListTasks } from "@workspace/api-client-react";
import { TrendingUp, CheckCircle2, DollarSign, Zap, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { BarChart, Bar, ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  color: string;
  borderColor: string;
  trend?: "up" | "down" | null;
  loading?: boolean;
  chartData?: { v: number }[];
  chartColor?: string;
}

function StatCard({ label, value, sub, icon: Icon, color, borderColor, trend, loading, chartData, chartColor }: StatCardProps) {
  return (
    <div className={cn(
      "bg-card border rounded-xl px-4 py-3 flex items-center gap-3 flex-1 min-w-0 relative overflow-hidden",
      borderColor
    )}>
      <div className={cn("absolute top-0 left-0 w-full h-[1px]", color.replace("text-", "bg-").replace("/80", "/40"))} />
      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", `bg-${color.split("-")[1]}-500/10`)}>
        <Icon className={cn("w-4 h-4", color)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-0.5">{label}</div>
        {loading ? (
          <Skeleton className="h-5 w-16" />
        ) : (
          <div className="flex items-center gap-1.5">
            <span className={cn("font-mono font-bold text-lg leading-tight", color)}>{value}</span>
            {trend && (
              <span className={cn("text-[9px]", trend === "up" ? "text-emerald-400" : "text-red-400")}>
                {trend === "up" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              </span>
            )}
          </div>
        )}
        {sub && !loading && (
          <div className="font-mono text-[9px] text-muted-foreground/50 mt-0.5 truncate">{sub}</div>
        )}
      </div>
      {chartData && chartData.length > 0 && !loading && (
        <div className="w-16 h-10 flex-shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barSize={4} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <Bar dataKey="v" fill={chartColor ?? "hsl(var(--primary))"} radius={[2, 2, 0, 0]} opacity={0.7} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "10px", fontFamily: "monospace", padding: "4px 8px" }}
                cursor={{ fill: "rgba(255,255,255,0.05)" }}
                formatter={(v: any) => [v, ""]}
                labelFormatter={() => ""}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default function StatsBar() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: tasksData, isLoading: tasksLoading } = useListTasks();

  const tasks = Array.isArray(tasksData) ? tasksData : [];

  const completedTasks = tasks.filter((t: any) => t.userStatus === "approved").length;
  const pendingTasks = tasks.filter((t: any) => t.userStatus === "pending").length;

  const approvedSubs = tasks.filter((t: any) => t.userStatus === "approved");
  const totalCost = approvedSubs.reduce((s: number, t: any) => s + (t.cost ?? 0), 0);
  const totalProfit = approvedSubs.reduce((s: number, t: any) => s + (t.profit ?? 0), 0);
  const roi = totalCost > 0 ? (((totalProfit - totalCost) / totalCost) * 100) : null;

  const aznBalance = (me as any)?.aznBalance ?? (me as any)?.credits?.aznBalance ?? 0;
  const xpBalance = (me as any)?.xpBalance ?? (me as any)?.credits?.balance ?? 0;

  const loading = meLoading || tasksLoading;

  // Build last-7-day activity sparkline from tasks with createdAt
  const activityData = (() => {
    const days: { v: number }[] = Array.from({ length: 7 }, () => ({ v: 0 }));
    const now = Date.now();
    tasks.forEach((t: any) => {
      if (t.userStatus !== "approved") return;
      const createdAt = t.createdAt ? new Date(t.createdAt).getTime() : 0;
      const dayAgo = Math.floor((now - createdAt) / 86400000);
      if (dayAgo >= 0 && dayAgo < 7) {
        days[6 - dayAgo].v += 1;
      }
    });
    return days;
  })();

  const costChart = (() => {
    const days: { v: number }[] = Array.from({ length: 7 }, () => ({ v: 0 }));
    const now = Date.now();
    approvedSubs.forEach((t: any) => {
      const createdAt = t.createdAt ? new Date(t.createdAt).getTime() : 0;
      const dayAgo = Math.floor((now - createdAt) / 86400000);
      if (dayAgo >= 0 && dayAgo < 7) {
        days[6 - dayAgo].v += Math.round((t.cost ?? 0) * 100) / 100;
      }
    });
    return days;
  })();

  return (
    <div className="flex gap-2 flex-wrap sm:flex-nowrap">
      <StatCard
        label="Portfolio ROI"
        value={roi !== null ? `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%` : "—"}
        sub={totalCost > 0 ? `$${totalCost.toFixed(2)} invested` : "No cost tracked"}
        icon={TrendingUp}
        color={roi !== null && roi >= 0 ? "text-emerald-400/80" : "text-red-400/80"}
        borderColor={roi !== null && roi >= 0 ? "border-emerald-500/20" : roi !== null ? "border-red-500/20" : "border-card-border"}
        trend={roi !== null ? (roi >= 0 ? "up" : "down") : null}
        loading={loading}
      />
      <StatCard
        label="Tasks Done"
        value={String(completedTasks)}
        sub={pendingTasks > 0 ? `${pendingTasks} pending review` : `of ${tasks.length} total`}
        icon={CheckCircle2}
        color="text-primary/80"
        borderColor="border-primary/20"
        loading={loading}
        chartData={activityData}
        chartColor="hsl(var(--primary))"
      />
      <StatCard
        label="Total Cost"
        value={totalCost > 0 ? `$${totalCost.toFixed(2)}` : "$0.00"}
        sub={totalProfit > 0 ? `$${totalProfit.toFixed(2)} earned back` : "Track costs in tasks"}
        icon={DollarSign}
        color="text-amber-400/80"
        borderColor="border-amber-500/20"
        loading={loading}
        chartData={costChart}
        chartColor="#fbbf24"
      />
      <StatCard
        label="AZN Balance"
        value={aznBalance > 0 ? `${Number(aznBalance).toFixed(4)}` : "0.0000"}
        sub={xpBalance > 0 ? `${xpBalance} XP accumulated` : "Complete tasks to earn"}
        icon={Zap}
        color="text-violet-400/80"
        borderColor="border-violet-500/20"
        loading={loading}
      />
    </div>
  );
}
