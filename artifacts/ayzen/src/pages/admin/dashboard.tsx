import { useGetPlatformStats, useGetPlatformActivity } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Activity, Target, Zap, TrendingUp, UserPlus, Clock, DollarSign, Share2, MessageSquare, ChevronRight, ClipboardList, Check, X } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, AreaChart, Area } from "recharts";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { useState, useEffect } from "react";
import { format } from "date-fns";
import { ADMIN_DASHBOARD_STAT_CARDS, type AdminDashboardCtx } from "@/config/columns/project-dashboard";

interface RecentUser { id: number; username: string; email: string; createdAt: string; referralCode?: string; }

const QUICK_ACTIONS = [
  { label: "Manage Users", href: "/admin/users", icon: Users, desc: "View, ban, promote operators", color: "text-primary border-primary/20 hover:bg-primary/5" },
  { label: "Referrals", href: "/admin/referrals", icon: Share2, desc: "Process pending rewards", color: "text-violet-400 border-violet-400/20 hover:bg-violet-400/5" },
  { label: "Support", href: "/admin/support", icon: MessageSquare, desc: "Respond to tickets", color: "text-amber-400 border-amber-400/20 hover:bg-amber-400/5" },
  { label: "Broadcast", href: "/admin/broadcast", icon: Zap, desc: "Send platform alerts", color: "text-emerald-400 border-emerald-400/20 hover:bg-emerald-400/5" },
  { label: "Projects", href: "/admin/projects", icon: Target, desc: "Create & manage airdrops", color: "text-sky-400 border-sky-400/20 hover:bg-sky-400/5" },
  { label: "Developer", href: "/admin/developer", icon: Activity, desc: "Telemetry & AI models", color: "text-pink-400 border-pink-400/20 hover:bg-pink-400/5" },
];

export default function AdminDashboard() {
  const { data: stats, isLoading: statsLoading } = useGetPlatformStats();
  const { data: activity, isLoading: activityLoading } = useGetPlatformActivity();
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([]);
  const [pendingSubs, setPendingSubs] = useState<any[]>([]);

  const token = localStorage.getItem("ayzen_token") ?? "";

  useEffect(() => {
    fetch("/api/users?limit=5&page=1", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setRecentUsers(Array.isArray(d.users) ? d.users.slice(0, 5) : []));
    fetch("/api/tasks/submissions?status=pending", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then(d => setPendingSubs(Array.isArray(d) ? d.slice(0, 5) : []));
  }, []);

  const statCtx: AdminDashboardCtx = { stats };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Platform Overview</h1>
          <p className="text-muted-foreground font-mono text-sm">System metrics, ROI tracking, and quick controls</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-400/10 border border-emerald-400/20 rounded-lg">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] font-mono text-emerald-400">All Systems Operational</span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ADMIN_DASHBOARD_STAT_CARDS.map(card => {
          const v = card.getValue(statCtx);
          return (
            <div key={card.key} className={cn("rounded-xl border p-4 animate-fade-up", card.bg)}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <card.icon className={cn("w-3.5 h-3.5", card.color)} />
                  <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{card.label}</span>
                </div>
                <TrendingUp className="w-3 h-3 text-muted-foreground/30" />
              </div>
              {statsLoading ? <Skeleton className="h-8 w-24" /> : (
                <p className={cn("text-3xl font-mono font-black", card.color)}>
                  {v.value?.toLocaleString() ?? "—"}
                </p>
              )}
              <p className="font-mono text-[10px] text-muted-foreground mt-1">{v.change}</p>
            </div>
          );
        })}
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Charts - 2/3 width */}
        <div className="md:col-span-2 space-y-4">
          {/* Daily activity chart */}
          <div className="border border-card-border rounded-xl bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-card-border">
              <p className="font-mono text-sm font-bold">Daily Task Activity</p>
              <p className="font-mono text-[10px] text-muted-foreground">Tasks completed over last 14 days</p>
            </div>
            <div className="p-4 h-[200px]">
              {activityLoading ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={activity?.daily ?? []}>
                    <defs>
                      <linearGradient id="taskGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", fontFamily: "monospace", fontSize: 11 }} />
                    <Area type="monotone" dataKey="tasks" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#taskGrad)" dot={false} />
                    <Line type="monotone" dataKey="users" stroke="hsl(var(--secondary))" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Monthly user bar chart */}
          <div className="border border-card-border rounded-xl bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-card-border">
              <p className="font-mono text-sm font-bold">Monthly Growth</p>
              <p className="font-mono text-[10px] text-muted-foreground">New operators per month</p>
            </div>
            <div className="p-4 h-[180px]">
              {activityLoading ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={activity?.monthly ?? []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", fontFamily: "monospace", fontSize: 11 }} cursor={{ fill: "hsl(var(--muted))" }} />
                    <Bar dataKey="users" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* Right column - Quick actions + Pending subs + Recent users */}
        <div className="space-y-4">
          {/* Pending submissions */}
          {pendingSubs.length > 0 && (
            <div className="border border-yellow-400/20 rounded-xl bg-yellow-400/3 overflow-hidden">
              <div className="px-4 py-3 border-b border-yellow-400/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClipboardList className="w-3.5 h-3.5 text-yellow-400" />
                  <p className="font-mono text-sm font-bold text-yellow-400">Pending Submissions</p>
                  <span className="bg-yellow-400 text-black rounded-full px-1.5 text-[9px] font-bold">{pendingSubs.length}</span>
                </div>
                <Link href="/admin/tasks"><span className="text-[10px] font-mono text-yellow-400 hover:underline cursor-pointer">Review →</span></Link>
              </div>
              <div className="divide-y divide-yellow-400/10">
                {pendingSubs.map((s: any) => (
                  <div key={s.id} className="px-4 py-2 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs font-medium truncate">{s.username ?? `User #${s.userId}`}</p>
                      <p className="font-mono text-[9px] text-muted-foreground/50 truncate">{s.taskName ?? `Task #${s.taskId}`}</p>
                    </div>
                    <span className="font-mono text-[9px] text-muted-foreground/40 shrink-0">
                      {format(new Date(s.submittedAt), "MMM d HH:mm")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Quick actions */}
          <div className="border border-card-border rounded-xl bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-card-border">
              <p className="font-mono text-sm font-bold">Quick Actions</p>
            </div>
            <div className="p-2 space-y-1">
              {QUICK_ACTIONS.map(a => (
                <Link key={a.href} href={a.href}>
                  <div className={cn("flex items-center justify-between p-2.5 rounded-lg border transition-all cursor-pointer group", a.color)}>
                    <div className="flex items-center gap-2.5">
                      <a.icon className="w-3.5 h-3.5 shrink-0" />
                      <div>
                        <p className="font-mono text-xs font-bold">{a.label}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/60">{a.desc}</p>
                      </div>
                    </div>
                    <ChevronRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Recent registrations */}
          <div className="border border-card-border rounded-xl bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
              <p className="font-mono text-sm font-bold">Recent Signups</p>
              <Link href="/admin/users"><span className="text-[10px] font-mono text-primary hover:underline cursor-pointer">See all →</span></Link>
            </div>
            <div className="divide-y divide-card-border">
              {recentUsers.length === 0 ? (
                <div className="p-4 text-center font-mono text-xs text-muted-foreground">No users yet</div>
              ) : recentUsers.map(u => (
                <div key={u.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-muted/20 transition-colors">
                  <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-mono font-bold text-primary">{u.username?.[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs font-bold text-foreground truncate">{u.username}</p>
                    <p className="font-mono text-[9px] text-muted-foreground/60 truncate">{u.email}</p>
                  </div>
                  <span className="font-mono text-[9px] text-muted-foreground/40 shrink-0">
                    {format(new Date(u.createdAt), "MMM d")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
