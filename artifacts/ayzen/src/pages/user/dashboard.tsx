import { useState, useEffect, useRef } from "react";
import { useGetMe, useGetUserStats, useListProjects, useListTasks } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  MoreHorizontal, ArrowUpRight, ArrowDownRight,
  CheckSquare, ListTodo, Flame, ChevronDown, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import { useCountUp } from "@/hooks/use-count-up";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

/** Palette pulled straight from the reference design — kept local to this
 *  page instead of the app's dark theme tokens, since this dashboard is
 *  intentionally a light-mode panel. */
const C = {
  green: "#22c55e",
  greenSoft: "#dcfce7",
  amber: "#f59e0b",
  amberSoft: "#fef3c7",
  blue: "#3b82f6",
  blueSoft: "#dbeafe",
  ink: "#0f172a",
  sub: "#94a3b8",
};

function AnimatedNumber({ value, prefix = "", suffix = "" }: { value: number; prefix?: string; suffix?: string }) {
  const animated = useCountUp(value, 1200);
  return <>{prefix}{animated.toLocaleString()}{suffix}</>;
}

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.2 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return { ref, visible };
}

function CardShell({ title, right, children, className }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("bg-white rounded-2xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)]", className)}>
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <span className="text-[11px] font-semibold tracking-widest text-slate-400 uppercase">{title}</span>
        {right ?? <MoreHorizontal className="w-4 h-4 text-slate-300" />}
      </div>
      {children}
    </div>
  );
}

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-100 rounded-xl px-3 py-2 shadow-lg text-xs">
      <div className="text-slate-400 mb-1 font-medium">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2 text-slate-700">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <strong>{p.value}</strong>
        </div>
      ))}
    </div>
  );
};

export default function UserDashboard() {
  const { data: user, isLoading: userLoading } = useGetMe({ query: { queryKey: ["me"], refetchInterval: 30_000 } });
  const { data: stats, isLoading: statsLoading } = useGetUserStats(user?.id || 0, {
    query: { enabled: !!user?.id, queryKey: ["user-stats", user?.id], refetchInterval: 15_000 },
  });
  const { data: projects } = useListProjects(undefined, { query: { queryKey: ["projects"], refetchInterval: 20_000 } });
  const { data: tasks, isLoading: tasksLoading } = useListTasks(undefined, { query: { queryKey: ["tasks"], refetchInterval: 10_000 } });

  const [activity, setActivity] = useState<{ period: string; approved: number; submitted: number; pending: number }[]>([]);
  const [walletUsd, setWalletUsd] = useState<number | null>(null);
  const [walletCount, setWalletCount] = useState(0);

  useEffect(() => {
    const token = localStorage.getItem("ayzen_token") ?? "";
    if (!token) return;
    fetch(`${BASE}/api/history/chart`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((rows: any[]) => {
        const source = rows.length > 0
          ? rows.map(r => ({ period: r.week, approved: Number(r.approved ?? 0), submitted: Number(r.submitted ?? 0) }))
          : ["Jan", "Feb", "Mar", "Apr", "May", "Jun"].map((m, i) => ({
              period: m,
              approved: Math.floor(Math.abs(Math.sin(i * 1.3)) * 8) + 2,
              submitted: Math.floor(Math.abs(Math.sin(i * 0.9 + 1)) * 12) + 3,
            }));
        setActivity(source.map(d => ({ ...d, pending: Math.max(d.submitted - d.approved, 0) })));
      }).catch(() => {});
    fetch(`${BASE}/api/wallets`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((ws: any[]) => {
        setWalletCount(ws.length);
        setWalletUsd(ws.reduce((s, w) => s + (w.balanceUsd ?? 0), 0));
      }).catch(() => {});
  }, [user?.id]);

  const projectList: any[] = Array.isArray(projects) ? projects : ((projects as any)?.projects ?? []);
  const taskList: any[] = Array.isArray(tasks) ? tasks : [];
  const pendingTasks = taskList.filter((t: any) => !t.userStatus || t.userStatus === "pending").length;
  const approvedTasks = taskList.filter((t: any) => t.userStatus === "approved").length;
  const recentTasks = taskList.slice(0, 4);

  const totalRoi = stats?.totalRoi ?? 0;
  const tasksToday = stats?.tasksToday ?? 0;
  const tasksThisWeek = stats?.tasksThisWeek ?? 0;
  const points = stats?.points ?? 0;
  const streak = stats?.streak ?? 0;
  const longestStreak = stats?.longestStreak ?? Math.max(streak, 1);

  const donutData = [
    { name: "Approved", value: approvedTasks || 1, color: C.green },
    { name: "Pending", value: pendingTasks || 1, color: C.amber },
  ];

  const overviewStat = useInView<HTMLDivElement>();

  const goals = [
    { label: "Daily Tasks", current: tasksToday, target: Math.max(5, tasksToday), color: C.blue, display: `${tasksToday} / ${Math.max(5, tasksToday)}` },
    { label: "Weekly Tasks", current: tasksThisWeek, target: Math.max(20, tasksThisWeek), color: C.amber, display: `${tasksThisWeek} / ${Math.max(20, tasksThisWeek)}` },
    { label: "Streak", current: streak, target: longestStreak, color: C.green, display: `${streak}d streak` },
  ];

  return (
    <div className="-m-4 md:-m-6 lg:-m-8 p-4 md:p-6 lg:p-8 bg-[#eef1f7] min-h-full space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          {userLoading ? <Skeleton className="h-6 w-40 mb-1" /> : (
            <h1 className="font-bold text-xl text-slate-900 tracking-tight">
              Gm, <span>{user?.username ?? user?.email?.split("@")[0] ?? "Operator"}</span>
            </h1>
          )}
          <p className="text-xs text-slate-400 mt-0.5">Here's your activity overview</p>
        </div>
        <div className="flex items-center gap-1.5 bg-white border border-slate-100 rounded-full px-3 py-1.5 shadow-sm">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Live</span>
        </div>
      </div>

      {/* Row 1: Task Activity (chart) + Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <CardShell
          title="Task Activity"
          right={
            <button className="flex items-center gap-1 text-xs text-slate-500 bg-slate-50 rounded-lg px-2.5 py-1.5 hover:bg-slate-100 transition-colors">
              Last 6 periods <ChevronDown className="w-3 h-3" />
            </button>
          }
          className="lg:col-span-2"
        >
          <div className="h-[260px] px-2 pb-4 pt-2">
            {activity.length === 0 ? (
              <div className="h-full flex items-center justify-center"><Skeleton className="h-20 w-full mx-4" /></div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={activity} margin={{ top: 10, right: 12, left: -20, bottom: 0 }} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: C.sub }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: C.sub }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f8fafc" }} />
                  <Bar dataKey="approved" name="Approved" fill={C.green} radius={[4, 4, 0, 0]} maxBarSize={18} />
                  <Bar dataKey="pending" name="Pending" fill={C.amber} radius={[4, 4, 0, 0]} maxBarSize={18} />
                  <Bar dataKey="submitted" name="Submitted" fill={C.blue} radius={[4, 4, 0, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="flex items-center gap-5 px-5 pb-5 -mt-2">
            {[["Approved", C.green], ["Pending", C.amber], ["Submitted", C.blue]].map(([label, color]) => (
              <span key={label as string} className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <span className="w-2 h-2 rounded-full" style={{ background: color as string }} /> {label}
              </span>
            ))}
          </div>
        </CardShell>

        <div ref={overviewStat.ref} className="bg-white rounded-2xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] p-6 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold tracking-widest text-slate-400 uppercase">Overview</span>
            <MoreHorizontal className="w-4 h-4 text-slate-300" />
          </div>

          <div className="space-y-5 mt-3">
            <div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> TOTAL EARNED
              </div>
              {statsLoading ? <Skeleton className="h-8 w-28" /> : (
                <div className="text-3xl font-bold text-slate-900">
                  {overviewStat.visible ? <AnimatedNumber value={totalRoi} prefix="$" /> : `$${totalRoi.toLocaleString()}`}
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
                <span className="w-2 h-2 rounded-full bg-amber-500" /> POINTS
              </div>
              {statsLoading ? <Skeleton className="h-8 w-28" /> : (
                <div className="text-3xl font-bold text-slate-900">
                  {overviewStat.visible ? <AnimatedNumber value={points} /> : points.toLocaleString()}
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
                <span className="w-2 h-2 rounded-full bg-blue-500" /> WALLET BALANCE
              </div>
              {walletUsd === null ? <Skeleton className="h-8 w-28" /> : (
                <div className="text-3xl font-bold text-slate-900">
                  {overviewStat.visible ? <AnimatedNumber value={walletUsd} prefix="$" /> : `$${walletUsd.toFixed(2)}`}
                </div>
              )}
            </div>
          </div>

          <p className="text-[11px] text-slate-400 mt-5">
            {walletCount} wallet{walletCount !== 1 ? "s" : ""} connected. <Link href="/wallets"><span className="text-blue-500 font-medium hover:underline">Manage</span></Link>
          </p>
        </div>
      </div>

      {/* Row 2: Recent Transactions / Task Volume / Goals / Task History */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">

        {/* Recent Transactions */}
        <CardShell title="Recent Tasks">
          <div className="divide-y divide-slate-50 mt-2">
            {tasksLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="px-5 py-3 flex items-center gap-3">
                  <Skeleton className="h-7 w-7 rounded-full" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))
            ) : recentTasks.length === 0 ? (
              <div className="px-5 py-10 text-center text-xs text-slate-300">No tasks yet</div>
            ) : recentTasks.map((task: any) => {
              const approved = task.userStatus === "approved";
              return (
                <div key={task.id} className="px-5 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={cn("w-7 h-7 rounded-full flex items-center justify-center shrink-0", approved ? "bg-emerald-100" : "bg-amber-100")}>
                      {approved
                        ? <ArrowUpRight className="w-3.5 h-3.5 text-emerald-600" />
                        : <ArrowDownRight className="w-3.5 h-3.5 text-amber-600" />}
                    </span>
                    <span className="text-sm text-slate-700 truncate">{task.name}</span>
                  </div>
                  <span className={cn("text-sm font-semibold shrink-0", approved ? "text-emerald-600" : "text-amber-600")}>
                    {approved ? "+" : "−"}{task.rewardAmount ?? 0}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="px-5 py-3 border-t border-slate-50 mt-1">
            <Link href="/tasks"><span className="text-xs font-medium text-blue-500 hover:underline">See all tasks</span></Link>
          </div>
        </CardShell>

        {/* Task Volume (donut) */}
        <CardShell title="Task Volume">
          <div className="flex flex-col items-center pt-2 pb-4">
            <div className="w-[140px] h-[140px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donutData} dataKey="value" innerRadius={44} outerRadius={64} paddingAngle={3} strokeWidth={0}>
                    {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-between w-full px-5 mt-3">
              <div className="text-center">
                <div className="flex items-center gap-1 justify-center text-[10px] text-slate-400 uppercase tracking-wide">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Today
                </div>
                <div className="text-lg font-bold text-slate-900 mt-0.5">{tasksToday}</div>
              </div>
              <div className="text-center">
                <div className="flex items-center gap-1 justify-center text-[10px] text-slate-400 uppercase tracking-wide">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> This Week
                </div>
                <div className="text-lg font-bold text-slate-900 mt-0.5">{tasksThisWeek}</div>
              </div>
            </div>
          </div>
        </CardShell>

        {/* Goals (Sales Target equivalent) */}
        <CardShell title="Goals">
          <div className="px-5 pb-5 pt-2 space-y-4">
            {goals.map(g => {
              const pct = Math.min(100, Math.round((g.current / Math.max(g.target, 1)) * 100));
              const done = pct >= 100;
              return (
                <div key={g.label}>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-slate-600 font-medium">{g.label}</span>
                    <span className="text-slate-400">{g.display}</span>
                  </div>
                  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden relative">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: g.color }} />
                    {done && (
                      <span className="absolute right-0 -top-0.5 w-3 h-3 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: `0 0 0 1px ${g.color}` }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: g.color }} />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="px-5 pb-4">
            <Link href="/tasks"><span className="text-xs font-medium text-blue-500 hover:underline">See all tasks</span></Link>
          </div>
        </CardShell>

        {/* Task History (Transaction History equivalent) */}
        <CardShell title="Task History">
          <div className="flex flex-col items-center pt-3 pb-4 border-b border-slate-50">
            <span className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center mb-2">
              <ListTodo className="w-4 h-4 text-blue-600" />
            </span>
            <div className="text-3xl font-bold text-slate-900">{pendingTasks}</div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Pending Tasks</div>
          </div>
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-50">
            <span className="text-xs text-slate-400">Last 30 days</span>
          </div>
          <div className="flex px-5 py-3 gap-4">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckSquare className="w-3 h-3 text-emerald-600" />
              </span>
              <div>
                <div className="text-sm font-bold text-slate-900">{approvedTasks}</div>
                <div className="text-[9px] text-slate-400 uppercase">Approved</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center">
                <Flame className="w-3 h-3 text-amber-600" />
              </span>
              <div>
                <div className="text-sm font-bold text-slate-900">{pendingTasks}</div>
                <div className="text-[9px] text-slate-400 uppercase">Pending</div>
              </div>
            </div>
          </div>
          <div className="px-5 pb-4 pt-1 space-y-2.5">
            {recentTasks.slice(0, 3).map((task: any) => (
              <div key={task.id} className="flex items-center justify-between text-xs">
                <span className="text-slate-600 truncate">{task.name}</span>
                <span className={cn("font-semibold shrink-0", task.userStatus === "approved" ? "text-emerald-600" : "text-amber-600")}>
                  {task.userStatus === "approved" ? "+" : "−"}{task.rewardAmount ?? 0}
                </span>
              </div>
            ))}
          </div>
        </CardShell>
      </div>

      <div className="flex items-center justify-center gap-2 text-[10px] text-slate-300 pt-1">
        <Sparkles className="w-3 h-3" />
        <span>Data refreshes automatically · {projectList.length} protocols tracked</span>
      </div>
    </div>
  );
}
