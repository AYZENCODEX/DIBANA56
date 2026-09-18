/**
 * Admin › Operator Progress
 * ─────────────────────────
 * Shows per-project operator tracking.
 * - Left: list of all projects (sidebar-like), click to select
 * - Right: operator list for that project with progress bars
 * - Can also filter by individual operator to see all their projects
 *
 * Route: /admin/operator-progress
 */

import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import {
  FolderGit2, Users, ChevronRight, Search, X, CheckCircle2,
  Clock, BarChart2, RefreshCw, User, Globe, ArrowLeftRight, Boxes,
  Filter, SortAsc, SortDesc, Trophy, Activity, ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CATEGORY_COLORS, SIDEBAR_META_HIERARCHY } from "@/config/projects";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
function getToken() { return localStorage.getItem("ayzen_token") || ""; }

interface ProjectSummary {
  id: number;
  name: string;
  category: string;
  projectType: string;
  taskCount: number;
  activeUserCount: number;
  tier: string;
  thumbnailUrl?: string;
}

interface OperatorProgress {
  userId: number;
  username: string;
  email: string;
  joinedAt: string;
  tasksCompleted: number;
  totalTasks: number;
  progress: number;
}

interface UserProjectSummary {
  projectId: number;
  projectName: string;
  projectType: string;
  category: string;
  tasksCompleted: number;
  totalTasks: number;
  progress: number;
  joinedAt: string;
}

type ViewMode = "by-project" | "by-operator";
type SortBy = "progress" | "name" | "tasks" | "joined";

function getTypeLabel(projectType: string): string {
  const node = SIDEBAR_META_HIERARCHY.find(n => n.projectType === projectType);
  return node?.label ?? projectType ?? "Protocol";
}

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS["Other"];
}

function ProgressBar({ value, className }: { value: number; className?: string }) {
  const color = value >= 80 ? "bg-emerald-400" : value >= 50 ? "bg-primary" : value >= 20 ? "bg-amber-400" : "bg-red-400/70";
  return (
    <div className={cn("h-1.5 rounded-full bg-muted/30 overflow-hidden", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", color)}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

// ─── By-Project View ─────────────────────────────────────────────────────────

function ProjectListPanel({
  projects,
  selectedId,
  onSelect,
  loading,
  search,
  onSearch,
}: {
  projects: ProjectSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
}) {
  return (
    <div className="flex flex-col h-full border-r border-border">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border shrink-0">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2 flex items-center gap-1.5">
          <FolderGit2 className="w-3 h-3" /> Projects
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/40" />
          <Input
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Filter projects..."
            className="pl-7 h-7 text-[11px] font-mono bg-input border-border"
          />
        </div>
      </div>
      {/* Project list */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="px-3 py-2">
              <Skeleton className="h-4 w-full mb-1" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))
        ) : projects.length === 0 ? (
          <div className="px-3 py-8 text-center font-mono text-[10px] text-muted-foreground/40">
            No projects found
          </div>
        ) : (
          projects.map(p => (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={cn(
                "w-full text-left px-3 py-2 border-l-2 transition-all hover:bg-muted/30",
                selectedId === p.id
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-transparent text-foreground/70 hover:text-foreground"
              )}
            >
              <div className="font-mono text-[11px] font-semibold truncate leading-tight">{p.name}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={cn("font-mono text-[9px] border px-1 rounded", getCategoryColor(p.category ?? "Other"))}>
                  {getTypeLabel(p.projectType ?? "protocol")}
                </span>
                <span className="font-mono text-[9px] text-muted-foreground/50">
                  {p.activeUserCount ?? 0} ops
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function OperatorProgressPanel({
  projectId,
  project,
}: {
  projectId: number;
  project: ProjectSummary | undefined;
}) {
  const [operators, setOperators] = useState<OperatorProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("progress");
  const [sortDesc, setSortDesc] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}/members`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) setOperators(await res.json());
    } catch { /* noop */ }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const sorted = [...operators]
    .filter(o => !search || o.username.toLowerCase().includes(search.toLowerCase()) || o.email.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === "progress") cmp = a.progress - b.progress;
      else if (sortBy === "tasks") cmp = a.tasksCompleted - b.tasksCompleted;
      else if (sortBy === "name") cmp = a.username.localeCompare(b.username);
      else if (sortBy === "joined") cmp = new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
      return sortDesc ? -cmp : cmp;
    });

  const toggleSort = (by: SortBy) => {
    if (sortBy === by) setSortDesc(d => !d);
    else { setSortBy(by); setSortDesc(true); }
  };

  const avgProgress = operators.length > 0
    ? Math.round(operators.reduce((s, o) => s + o.progress, 0) / operators.length)
    : 0;

  const completed = operators.filter(o => o.progress === 100).length;

  if (!project) return (
    <div className="flex-1 flex items-center justify-center font-mono text-muted-foreground/40 text-xs">
      Select a project to view operator progress
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Project header */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="font-mono font-bold text-base truncate text-primary">{project.name}</h2>
              <Badge variant="outline" className="font-mono text-[9px] border-border">Tier {project.tier}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("font-mono text-[10px] border px-1.5 py-0.5 rounded", getCategoryColor(project.category ?? "Other"))}>
                {getTypeLabel(project.projectType ?? "protocol")}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/50">
                {project.taskCount} tasks
              </span>
            </div>
          </div>
          <Link href={`/admin/projects/${project.id}`}>
            <Button size="sm" variant="outline" className="font-mono text-[10px] uppercase tracking-wider gap-1.5 shrink-0">
              <ExternalLink className="w-3 h-3" /> Detail
            </Button>
          </Link>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mt-3">
          {[
            { label: "Operators", value: operators.length, icon: Users },
            { label: "Avg Progress", value: `${avgProgress}%`, icon: BarChart2 },
            { label: "Completed", value: completed, icon: CheckCircle2 },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-muted/20 border border-border rounded-lg p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <Icon className="w-3 h-3 text-muted-foreground/50" />
                <span className="font-mono text-[9px] text-muted-foreground/50 uppercase tracking-wider">{label}</span>
              </div>
              <div className="font-mono font-bold text-sm text-foreground">{value}</div>
            </div>
          ))}
        </div>

        {/* Overall progress bar */}
        <div className="mt-3">
          <div className="flex justify-between mb-1">
            <span className="font-mono text-[9px] text-muted-foreground/50 uppercase tracking-wider">Overall Progress</span>
            <span className="font-mono text-[9px] text-primary">{avgProgress}%</span>
          </div>
          <ProgressBar value={avgProgress} />
        </div>
      </div>

      {/* Operator list controls */}
      <div className="px-5 py-2.5 border-b border-border shrink-0 flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/40" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search operators..."
            className="pl-7 h-7 text-[11px] font-mono bg-input border-border"
          />
        </div>
        <div className="flex items-center gap-1 ml-auto">
          {(["name", "progress", "tasks", "joined"] as SortBy[]).map(s => (
            <button
              key={s}
              onClick={() => toggleSort(s)}
              className={cn(
                "font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded border transition-all flex items-center gap-1",
                sortBy === s
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/30 text-muted-foreground/40 hover:text-muted-foreground"
              )}
            >
              {s}
              {sortBy === s && (sortDesc ? <SortDesc className="w-2.5 h-2.5" /> : <SortAsc className="w-2.5 h-2.5" />)}
            </button>
          ))}
          <button onClick={load} className="p-1.5 rounded border border-border/30 text-muted-foreground/40 hover:text-primary transition-colors ml-1">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Operator rows */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-1.5 w-full" />
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-12">
            <Users className="w-8 h-8 text-muted-foreground/20" />
            <div className="font-mono text-[11px] text-muted-foreground/40">
              {search ? "No operators match filter" : "No operators have joined this project yet"}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {sorted.map((op, idx) => (
              <div key={op.userId} className="px-5 py-3 hover:bg-muted/10 transition-colors group">
                <div className="flex items-center gap-3">
                  {/* Rank */}
                  <div className="w-5 h-5 rounded-full bg-muted/30 border border-border/30 flex items-center justify-center flex-shrink-0">
                    <span className="font-mono text-[9px] text-muted-foreground/50">{idx + 1}</span>
                  </div>
                  {/* Avatar */}
                  <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0 font-bold text-[10px] uppercase text-primary">
                    {op.username[0]}
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] font-semibold truncate">{op.username}</span>
                        <span className="font-mono text-[9px] text-muted-foreground/40 truncate hidden sm:block">{op.email}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={cn(
                          "font-mono text-[10px] font-bold",
                          op.progress === 100 ? "text-emerald-400" : op.progress >= 50 ? "text-primary" : "text-muted-foreground"
                        )}>
                          {op.progress}%
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground/50">
                          {op.tasksCompleted}/{op.totalTasks} tasks
                        </span>
                      </div>
                    </div>
                    <ProgressBar value={op.progress} />
                  </div>
                  {/* Complete badge */}
                  {op.progress === 100 && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── By-Operator View ─────────────────────────────────────────────────────────

interface OperatorSummary {
  userId: number;
  username: string;
  email: string;
  role: string;
}

function OperatorListPanel({
  operators,
  selectedId,
  onSelect,
  loading,
  search,
  onSearch,
}: {
  operators: OperatorSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
}) {
  return (
    <div className="flex flex-col h-full border-r border-border">
      <div className="px-3 py-3 border-b border-border shrink-0">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2 flex items-center gap-1.5">
          <Users className="w-3 h-3" /> Operators
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/40" />
          <Input
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Filter operators..."
            className="pl-7 h-7 text-[11px] font-mono bg-input border-border"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="px-3 py-2"><Skeleton className="h-4 w-full mb-1" /><Skeleton className="h-3 w-2/3" /></div>
          ))
        ) : operators.length === 0 ? (
          <div className="px-3 py-8 text-center font-mono text-[10px] text-muted-foreground/40">No operators found</div>
        ) : (
          operators.map(op => (
            <button
              key={op.userId}
              onClick={() => onSelect(op.userId)}
              className={cn(
                "w-full text-left px-3 py-2 border-l-2 transition-all hover:bg-muted/30",
                selectedId === op.userId
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-transparent text-foreground/70 hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[9px] font-bold uppercase text-primary flex-shrink-0">
                  {op.username[0]}
                </div>
                <div className="min-w-0">
                  <div className="font-mono text-[11px] font-semibold truncate">{op.username}</div>
                  <div className="font-mono text-[9px] text-muted-foreground/40 truncate">{op.email}</div>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function OperatorProjectsPanel({
  userId,
  operator,
}: {
  userId: number;
  operator: OperatorSummary | undefined;
}) {
  const [projects, setProjects] = useState<UserProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Use the user's project stats endpoint or query via entity overview
      const res = await fetch(`${BASE}/api/projects?limit=200`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) {
        const data = await res.json();
        // For each project, check if this user is a member and get their progress
        const memberChecks = await Promise.all(
          (data.projects ?? []).map(async (p: any) => {
            const membersRes = await fetch(`${BASE}/api/projects/${p.id}/members`, {
              headers: { Authorization: `Bearer ${getToken()}` },
            });
            if (!membersRes.ok) return null;
            const members: OperatorProgress[] = await membersRes.json();
            const member = members.find(m => m.userId === userId);
            if (!member) return null;
            return {
              projectId: p.id,
              projectName: p.name,
              projectType: p.projectType ?? "protocol",
              category: p.category ?? "Other",
              tasksCompleted: member.tasksCompleted,
              totalTasks: member.totalTasks,
              progress: member.progress,
              joinedAt: member.joinedAt,
            } as UserProjectSummary;
          })
        );
        setProjects(memberChecks.filter(Boolean) as UserProjectSummary[]);
      }
    } catch { /* noop */ }
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  if (!operator) return (
    <div className="flex-1 flex items-center justify-center font-mono text-muted-foreground/40 text-xs">
      Select an operator to view their projects
    </div>
  );

  const avgProgress = projects.length > 0
    ? Math.round(projects.reduce((s, p) => s + p.progress, 0) / projects.length)
    : 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Operator header */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center font-bold text-sm uppercase text-primary">
            {operator.username[0]}
          </div>
          <div>
            <div className="font-mono font-bold text-base text-primary">{operator.username}</div>
            <div className="font-mono text-[10px] text-muted-foreground/50">{operator.email}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Projects", value: projects.length },
            { label: "Avg Progress", value: `${avgProgress}%` },
            { label: "Completed", value: projects.filter(p => p.progress === 100).length },
          ].map(({ label, value }) => (
            <div key={label} className="bg-muted/20 border border-border rounded-lg p-2.5">
              <div className="font-mono text-[9px] text-muted-foreground/50 uppercase tracking-wider mb-1">{label}</div>
              <div className="font-mono font-bold text-sm">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Projects list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-1.5 w-full" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 py-12">
            <FolderGit2 className="w-8 h-8 text-muted-foreground/20" />
            <div className="font-mono text-[11px] text-muted-foreground/40">No projects joined</div>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {projects.sort((a, b) => b.progress - a.progress).map(p => (
              <div key={p.projectId} className="px-5 py-3 hover:bg-muted/10 transition-colors">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn("font-mono text-[9px] border px-1.5 rounded shrink-0", getCategoryColor(p.category))}>
                      {getTypeLabel(p.projectType)}
                    </span>
                    <Link href={`/admin/projects/${p.projectId}`}>
                      <span className="font-mono text-[11px] font-semibold truncate hover:text-primary transition-colors cursor-pointer">
                        {p.projectName}
                      </span>
                    </Link>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn(
                      "font-mono text-[10px] font-bold",
                      p.progress === 100 ? "text-emerald-400" : p.progress >= 50 ? "text-primary" : "text-muted-foreground"
                    )}>
                      {p.progress}%
                    </span>
                    <span className="font-mono text-[9px] text-muted-foreground/50">
                      {p.tasksCompleted}/{p.totalTasks}
                    </span>
                    {p.progress === 100 && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                  </div>
                </div>
                <ProgressBar value={p.progress} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OperatorProgressPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("by-project");
  const [projectSearch, setProjectSearch] = useState("");
  const [operatorSearch, setOperatorSearch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedOperatorId, setSelectedOperatorId] = useState<number | null>(null);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [operators, setOperators] = useState<OperatorSummary[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingOperators, setLoadingOperators] = useState(true);

  // Load all projects
  useEffect(() => {
    setLoadingProjects(true);
    fetch(`${BASE}/api/projects?limit=200`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.projects) {
          setProjects(d.projects.map((p: any) => ({
            id: p.id,
            name: p.name,
            category: p.category ?? "Other",
            projectType: p.projectType ?? p.project_type ?? "protocol",
            taskCount: p.taskCount ?? 0,
            activeUserCount: p.activeUserCount ?? 0,
            tier: p.tier ?? "1",
            thumbnailUrl: p.thumbnailUrl,
          })));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingProjects(false));
  }, []);

  // Load all users (operators)
  useEffect(() => {
    setLoadingOperators(true);
    fetch(`${BASE}/api/users?limit=200`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const users = d?.users ?? [];
        setOperators(users.map((u: any) => ({
          userId: u.id,
          username: u.username,
          email: u.email,
          role: u.role,
        })));
      })
      .catch(() => {})
      .finally(() => setLoadingOperators(false));
  }, []);

  const filteredProjects = projects.filter(p =>
    !projectSearch || p.name.toLowerCase().includes(projectSearch.toLowerCase())
  );

  const filteredOperators = operators.filter(op =>
    !operatorSearch || op.username.toLowerCase().includes(operatorSearch.toLowerCase()) || op.email.toLowerCase().includes(operatorSearch.toLowerCase())
  );

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const selectedOperator = operators.find(op => op.userId === selectedOperatorId);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Page header */}
      <div className="px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold font-mono tracking-tighter uppercase text-primary">
              Operator Progress
            </h1>
            <p className="text-muted-foreground font-mono text-[11px] mt-0.5">
              Track which operators are doing which projects and how far they've gotten
            </p>
          </div>
          {/* View toggle */}
          <div className="flex items-center gap-1 bg-muted/20 border border-border rounded-lg p-1">
            {([
              { id: "by-project" as ViewMode, label: "By Project", icon: FolderGit2 },
              { id: "by-operator" as ViewMode, label: "By Operator", icon: Users },
            ]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setViewMode(id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-[10px] uppercase tracking-wider transition-all",
                  viewMode === id
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "text-muted-foreground/50 hover:text-muted-foreground"
                )}
              >
                <Icon className="w-3 h-3" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Split panel layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel — 260px fixed */}
        <div className="w-64 shrink-0 h-full">
          {viewMode === "by-project" ? (
            <ProjectListPanel
              projects={filteredProjects}
              selectedId={selectedProjectId}
              onSelect={id => setSelectedProjectId(id)}
              loading={loadingProjects}
              search={projectSearch}
              onSearch={setProjectSearch}
            />
          ) : (
            <OperatorListPanel
              operators={filteredOperators}
              selectedId={selectedOperatorId}
              onSelect={id => setSelectedOperatorId(id)}
              loading={loadingOperators}
              search={operatorSearch}
              onSearch={setOperatorSearch}
            />
          )}
        </div>

        {/* Right panel — fills remaining space */}
        {viewMode === "by-project" ? (
          selectedProjectId ? (
            <OperatorProgressPanel projectId={selectedProjectId} project={selectedProject} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                <FolderGit2 className="w-5 h-5 text-primary/50" />
              </div>
              <div>
                <div className="font-mono font-semibold text-sm text-muted-foreground">Select a project</div>
                <div className="font-mono text-[10px] text-muted-foreground/40 mt-1">
                  Choose a project from the left panel to see operator progress
                </div>
              </div>
            </div>
          )
        ) : (
          selectedOperatorId ? (
            <OperatorProjectsPanel userId={selectedOperatorId} operator={selectedOperator} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Users className="w-5 h-5 text-primary/50" />
              </div>
              <div>
                <div className="font-mono font-semibold text-sm text-muted-foreground">Select an operator</div>
                <div className="font-mono text-[10px] text-muted-foreground/40 mt-1">
                  Choose an operator to see all their projects and progress
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
