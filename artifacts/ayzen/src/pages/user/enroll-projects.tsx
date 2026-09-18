// enroll-projects.tsx
// ─────────────────────────────────────────────
// Phase 9A — Enroll sidebar shell + Projects Overview
//
// Lives under the new page-local Enroll sidebar (components/layout/
// enroll-sidebar.tsx, modeled on vault-sidebar.tsx). Two tabs:
//
//   Overview — 9 stat widgets + a status pie chart, two bar charts, and an
//              activity heatmap, all sourced from GET /projects/mine/overview
//              (Phase 4 activity_log aggregated server-side — see
//              lib/activity-log.ts#getUserEnrollmentsOverview). Nothing here
//              is mocked; an account with no enrollments just shows zeros.
//   Project list — every project the user has enrolled entities into
//              (GET /projects/mine/enrolled, same endpoint
//              pages/user/project-entities.tsx already uses). Opens that
//              project's dedicated dashboard page (pages/user/
//              project-dashboard.tsx, Phase 9B) at /enroll/projects/:id.
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, Tooltip, XAxis,
} from "recharts";
import {
  FolderGit2, Loader2, Users, CheckCircle2, ShieldAlert, Ban, XCircle,
  Gift, Timer, TrendingUp, Calendar,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { EnrollSectionPage } from "@/components/layout/enroll-sidebar";
import { DataActivityHeatmap } from "@/components/data-activity-heatmap";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function useAuthedFetch() {
  const { token } = useAuth();
  return useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
    return data;
  }, [token]);
}

interface EnrollmentsOverview {
  summary: {
    totalProjects: number; totalEnrollments: number; activeEnrollments: number;
    disqualifiedCount: number; bannedCount: number; cancelledCount: number;
    totalReward: number; totalDaysActive: number; avgRewardPerDay: number | null;
  };
  statusBreakdown: { status: string; count: number }[];
  rewardsByProject: { projectId: number; projectName: string; totalReward: number }[];
  enrollmentsOverTime: { month: string; count: number }[];
  activityHeatmap: { day: string; count: number }[];
}

interface EnrolledProjectSummary {
  projectId: number;
  projectName: string;
  thumbnailUrl?: string | null;
  category?: string | null;
  enrolledCount: number;
}

const STATUS_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  active: { label: "Active", icon: CheckCircle2, color: "#34d399" },
  disqualified: { label: "Disqualified", icon: ShieldAlert, color: "#fbbf24" },
  banned: { label: "Banned", icon: Ban, color: "#f87171" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "#94a3b8" },
};

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="bg-card border border-card-border rounded-xl p-3.5 flex items-start gap-3">
      <Icon className={cn("w-5 h-5 mt-0.5 flex-shrink-0", color)} />
      <div className="min-w-0">
        <p className={cn("text-lg font-bold font-mono truncate", color)}>{value}</p>
        <p className="text-[10px] text-muted-foreground/60 font-mono">{label}</p>
      </div>
    </div>
  );
}

const CHART_TOOLTIP_STYLE = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 10, fontFamily: "monospace" };

function ProjectsOverviewTab() {
  const authedFetch = useAuthedFetch();
  const [data, setData] = useState<EnrollmentsOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authedFetch("/projects/mine/overview")
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authedFetch]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  if (!data) return <div className="text-center py-16 font-mono text-xs text-muted-foreground/50">Couldn't load overview</div>;

  const { summary, statusBreakdown, rewardsByProject, enrollmentsOverTime, activityHeatmap } = data;

  const pieData = statusBreakdown
    .filter(s => s.count > 0)
    .map(s => ({ name: STATUS_META[s.status]?.label ?? s.status, value: s.count, color: STATUS_META[s.status]?.color ?? "#94a3b8" }));

  const rewardBarData = rewardsByProject.map(p => ({ name: p.projectName, reward: p.totalReward }));
  const timeBarData = enrollmentsOverTime.map(e => ({ name: e.month, count: e.count }));

  return (
    <div className="space-y-4">
      {/* 9 stat widgets */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="Projects Enrolled" value={String(summary.totalProjects)} icon={FolderGit2} color="text-primary" />
        <StatCard label="Total Enrollments" value={String(summary.totalEnrollments)} icon={Users} color="text-cyan-400" />
        <StatCard label="Active" value={String(summary.activeEnrollments)} icon={CheckCircle2} color="text-emerald-400" />
        <StatCard label="Disqualified" value={String(summary.disqualifiedCount)} icon={ShieldAlert} color="text-amber-400" />
        <StatCard label="Banned" value={String(summary.bannedCount)} icon={Ban} color="text-red-400" />
        <StatCard label="Cancelled" value={String(summary.cancelledCount)} icon={XCircle} color="text-muted-foreground" />
        <StatCard label="Total Reward" value={`$${summary.totalReward.toFixed(2)}`} icon={Gift} color="text-emerald-400" />
        <StatCard label="Days Active" value={summary.totalDaysActive.toFixed(1)} icon={Timer} color="text-foreground" />
        <StatCard label="Avg Reward / Day" value={summary.avgRewardPerDay === null ? "—" : `$${summary.avgRewardPerDay.toFixed(2)}`} icon={TrendingUp} color="text-primary" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Pie — status breakdown */}
        <div className="bg-card border border-card-border rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Enrollment Status</p>
          {pieData.length === 0 ? (
            <p className="font-mono text-[10px] text-muted-foreground/40 py-8 text-center">No enrollments yet</p>
          ) : (
            <div className="flex items-center gap-4">
              <div className="w-[110px] h-[110px] flex-shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" innerRadius={34} outerRadius={52} paddingAngle={3} strokeWidth={0}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-1.5">
                {pieData.map(d => (
                  <div key={d.name} className="flex items-center gap-1.5 font-mono text-[10px]">
                    <span className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                    <span className="text-muted-foreground/70">{d.name}</span>
                    <span className="font-bold text-foreground">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Bar — reward by project */}
        <div className="bg-card border border-card-border rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Reward by Project (top 8)</p>
          {rewardBarData.length === 0 ? (
            <p className="font-mono text-[10px] text-muted-foreground/40 py-8 text-center">No rewards recorded yet</p>
          ) : (
            <div className="h-[110px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rewardBarData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <XAxis dataKey="name" hide />
                  <Bar dataKey="reward" radius={[3, 3, 0, 0]} fill="#34d399" />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Bar — enrollments over time */}
      <div className="bg-card border border-card-border rounded-xl p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2 flex items-center gap-1.5">
          <Calendar className="w-3 h-3" /> Enrollments Over Time
        </p>
        {timeBarData.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground/40 py-8 text-center">No enrollments yet</p>
        ) : (
          <div className="h-[110px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timeBarData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 9, fontFamily: "monospace" }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]} fill="#60a5fa" />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Heatmap — every enrollment/reward/status event across all enrollments */}
      <div className="bg-card border border-card-border rounded-xl p-4">
        <DataActivityHeatmap activity={activityHeatmap} label="Enrollment Activity — Past Year" unitLabel="event" />
      </div>
    </div>
  );
}

function ProjectListTab() {
  const authedFetch = useAuthedFetch();
  const [, navigate] = useLocation();
  const [projects, setProjects] = useState<EnrolledProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authedFetch("/projects/mine/enrolled")
      .then(d => { if (!cancelled) setProjects(Array.isArray(d) ? d : []); })
      .catch(() => { if (!cancelled) setProjects([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authedFetch]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;

  if (projects.length === 0) {
    return (
      <div className="text-center py-16 space-y-2 border border-dashed border-border/40 rounded-lg">
        <FolderGit2 className="w-6 h-6 text-muted-foreground/20 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No enrollments yet</p>
        <p className="font-mono text-[9px] text-muted-foreground/40">Enroll entities from a project's page — it'll show up here.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {projects.map(p => (
        <button
          key={p.projectId}
          onClick={() => navigate(`/enroll/projects/${p.projectId}`)}
          className="bg-card border border-card-border rounded-lg p-3 flex items-center gap-3 text-left hover:border-primary/40 transition-colors"
        >
          <FolderGit2 className="w-4 h-4 text-primary/70 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-mono text-xs font-bold truncate">{p.projectName}</p>
            <p className="font-mono text-[9px] text-muted-foreground/50">{p.enrolledCount} entit{p.enrolledCount !== 1 ? "ies" : "y"} enrolled</p>
          </div>
        </button>
      ))}
    </div>
  );
}

export default function EnrollProjectsPage() {
  return (
    <EnrollSectionPage
      title="Projects"
      description="Aggregate enrollment stats across every project, plus the projects you've enrolled entities into"
      icon={FolderGit2}
    >
      <Tabs defaultValue="overview" className="space-y-3">
        <TabsList className="bg-muted/20">
          <TabsTrigger value="overview" className="font-mono text-xs">Overview</TabsTrigger>
          <TabsTrigger value="list" className="font-mono text-xs">Project List</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <ProjectsOverviewTab />
        </TabsContent>
        <TabsContent value="list">
          <ProjectListTab />
        </TabsContent>
      </Tabs>
    </EnrollSectionPage>
  );
}
