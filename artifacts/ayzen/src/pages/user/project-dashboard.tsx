// project-dashboard.tsx
// ─────────────────────────────────────────────
// Phase 9B — Per-project dedicated dashboard page
//
// Each project in the Phase 9A list (pages/user/enroll-projects.tsx,
// ProjectListTab) is clickable and opens here — its own deep-linkable URL
// (/enroll/projects/:id), separate from the submission-flow
// pages/user/project-detail.tsx. Shows:
//
//   - Project header (name/thumbnail/category — GET /projects/:id, public)
//   - Stat widgets + heatmap scoped to THIS project only, sourced from
//     GET /projects/:id/enrollments/overview (Phase 4 activity_log,
//     aggregated server-side via lib/activity-log.ts#getProjectEnrollmentsOverview
//     — same "derive at read time, never store" rule as Phase 9A's
//     Projects Overview, just filtered to one project).
//   - Enrolled entities + the Phase 4 activity log + the Phase 5 moderation
//     actions (disqualify/ban/cancel/restore) — reuses
//     pages/user/project-entities.tsx's ProjectEntitiesDetail component
//     verbatim instead of a second implementation of that list.
import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  BarChart, Bar, ResponsiveContainer, Tooltip, XAxis,
} from "recharts";
import {
  FolderGit2, Loader2, Users, CheckCircle2, ShieldAlert, Ban,
  XCircle, Gift, Timer, TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { DataActivityHeatmap } from "@/components/data-activity-heatmap";
import { ProjectEntitiesDetail } from "@/pages/user/project-entities";

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

interface ProjectSummary {
  id: number;
  name: string;
  thumbnailUrl?: string | null;
  category?: string | null;
}

interface ProjectOverview {
  summary: {
    totalEnrollments: number; activeEnrollments: number; disqualifiedCount: number;
    bannedCount: number; cancelledCount: number; totalReward: number;
    totalDaysActive: number; avgRewardPerDay: number | null;
  };
  rewardsByEntity: { vaultEntryId: number; entityName: string; totalReward: number }[];
  activityHeatmap: { day: string; count: number }[];
}

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

function ProjectStatsPanel({ projectId }: { projectId: number }) {
  const authedFetch = useAuthedFetch();
  const [data, setData] = useState<ProjectOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authedFetch(`/projects/${projectId}/enrollments/overview`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authedFetch, projectId]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  if (!data) return <div className="text-center py-16 font-mono text-xs text-muted-foreground/50">Couldn't load project stats</div>;

  const { summary, rewardsByEntity, activityHeatmap } = data;
  const rewardBarData = rewardsByEntity.map(e => ({ name: e.entityName, reward: e.totalReward }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Enrollments" value={String(summary.totalEnrollments)} icon={Users} color="text-cyan-400" />
        <StatCard label="Active" value={String(summary.activeEnrollments)} icon={CheckCircle2} color="text-emerald-400" />
        <StatCard label="Disqualified" value={String(summary.disqualifiedCount)} icon={ShieldAlert} color="text-amber-400" />
        <StatCard label="Banned" value={String(summary.bannedCount)} icon={Ban} color="text-red-400" />
        <StatCard label="Cancelled" value={String(summary.cancelledCount)} icon={XCircle} color="text-muted-foreground" />
        <StatCard label="Total Reward" value={`$${summary.totalReward.toFixed(2)}`} icon={Gift} color="text-emerald-400" />
        <StatCard label="Days Active" value={summary.totalDaysActive.toFixed(1)} icon={Timer} color="text-foreground" />
        <StatCard label="Avg Reward / Day" value={summary.avgRewardPerDay === null ? "—" : `$${summary.avgRewardPerDay.toFixed(2)}`} icon={TrendingUp} color="text-primary" />
      </div>

      <div className="bg-card border border-card-border rounded-xl p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Reward by Entity (top 8)</p>
        {rewardBarData.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground/40 py-8 text-center">No rewards recorded yet</p>
        ) : (
          <div className="h-[130px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rewardBarData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 9, fontFamily: "monospace" }} />
                <Bar dataKey="reward" radius={[3, 3, 0, 0]} fill="#34d399" />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-card border border-card-border rounded-xl p-4">
        <DataActivityHeatmap activity={activityHeatmap} label="Project Activity — Past Year" unitLabel="event" />
      </div>
    </div>
  );
}

export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const [, navigate] = useLocation();
  const authedFetch = useAuthedFetch();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authedFetch(`/projects/${projectId}`)
      .then(d => { if (!cancelled) setProject(d); })
      .catch(() => { if (!cancelled) setProject(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authedFetch, projectId]);

  return (
    <div className="space-y-5 page-enter">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
          <FolderGit2 className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold font-mono tracking-tighter truncate">
            {loading ? "Loading..." : project?.name ?? `Project #${projectId}`}
          </h1>
          {project?.category && (
            <Badge variant="outline" className="font-mono text-[9px] mt-0.5">{project.category}</Badge>
          )}
        </div>
      </div>

      <ProjectStatsPanel projectId={projectId} />

      <ProjectEntitiesDetail
        projectId={projectId}
        projectName={project?.name ?? "Project"}
        onBack={() => navigate("/enroll/projects")}
      />
    </div>
  );
}
