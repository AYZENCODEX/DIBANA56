import { useState, useEffect, useCallback, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useGetProject, useGetProjectStats } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  ArrowLeft, ExternalLink, Users, CheckSquare, Zap, Activity,
  LayoutDashboard, ListTodo, Settings, Plus, Trash2, Edit3,
  Twitter, Globe, MessageCircle, TrendingUp, DollarSign, Timer, Calendar,
  CheckCircle2, Clock, ChevronRight, Star, Shield,
  Ban, ShieldAlert, XCircle, RotateCcw, MoreVertical, LayoutTemplate, Save,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { TaskCategoryBadge, CategoryLegend } from "@/components/ui/task-category-badge";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { CountdownTimer } from "@/components/ui/countdown-timer";
import { buildTemplateDiff, TemplatePreviewModal } from "@/components/projects/template-preview";

// Same tiny name/folder substring filter as admin/projects.tsx's template
// dropdown — duplicated rather than imported since that file's version is
// scoped to its own ProjectTemplate interface; this one just needs `any`.
function filterProjectTemplates(list: any[], query: string): any[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(t => t.name?.toLowerCase().includes(q) || (t.folder ?? "").toLowerCase().includes(q));
}
import { ProjectDatesManager } from "@/components/project-dates-manager";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function getToken() { return localStorage.getItem("ayzen_token") || ""; }
function getAuth() {
  const t = getToken();
  if (!t) return { userId: 1, role: "user" };
  try { return JSON.parse(Buffer.from(t.replace("Bearer ", ""), "base64").toString()); } catch { return { userId: 1, role: "user" }; }
}

interface Task {
  id: number; name: string; description?: string;
  rewardAmount?: number; verificationType: string; taskType: string;
  cost: number; profit: number; category: string; taskCategory: string;
  completionCount: number; deadline?: string; timeLimitMinutes?: number;
}

// ─── Create/Edit Task Dialog ──────────────────────────────────────────────────
// Thin wrapper around the shared Task-sidebar TaskFormDialog (same rich,
// tabbed create/edit UI used on the Task sidebar / admin/tasks.tsx), locked
// to this project so it always creates/edits the task here.
function TaskDialog({ projectId, projectMeta, task, onDone }: {
  projectId: number;
  projectMeta?: { name?: string; xpName?: string | null; xpPrice?: number };
  task?: Task;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={task ? "ghost" : "default"} onClick={() => setOpen(true)}
        className={cn("font-mono text-[10px] uppercase tracking-wider gap-1.5 h-7",
          task ? "text-muted-foreground hover:text-primary" : ""
        )}>
        {task ? <Edit3 className="w-3 h-3" /> : <><Plus className="w-3 h-3" /> Add Task</>}
      </Button>

      <TaskFormDialog
        open={open}
        onClose={() => setOpen(false)}
        editTask={task ? {
          id: task.id, name: task.name, description: task.description,
          taskType: task.taskType, verificationType: task.verificationType,
          rewardAmount: task.rewardAmount, taskCategory: task.taskCategory,
          deadline: task.deadline, timeLimitMinutes: task.timeLimitMinutes,
          projectId,
        } : null}
        projects={[{ id: projectId, name: projectMeta?.name ?? `Project #${projectId}`, xpName: projectMeta?.xpName, xpPrice: projectMeta?.xpPrice }]}
        lockedProjectId={projectId}
        onSaved={onDone}
      />
    </>
  );
}

// ─── Badge/tag input — Phase 7A. Type freely, press Space/Enter/, to commit
// a tag. Local copy of the same pattern used for game-entry tags (see
// components/game-entries.tsx TagInput) — kept local since neither file
// exports a shared version yet. ─────────────────────────────────────────────
function BadgeTagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === " " || e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => onChange(value.filter(t => t !== tag));

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[2.25rem] bg-input border border-border rounded-lg px-2.5 py-1.5 focus-within:border-primary/60 transition-colors"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/25"
        >
          {tag}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); removeTag(tag); }}
            className="hover:text-red-400 transition-colors"
          >
            <XCircle className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? "e.g. hot, low-cost, testnet..." : ""}
        className="flex-1 min-w-[8ch] bg-transparent outline-none font-mono text-xs placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AdminProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const { toast } = useToast();
  const token = getToken();

  const { data: project, isLoading: projectLoading, refetch } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: ["project", projectId] }
  });
  const { data: stats, isLoading: statsLoading } = useGetProjectStats(projectId, {
    query: { enabled: !!projectId, queryKey: ["project-stats", projectId] }
  });

  const [activeTab, setActiveTab] = useState<"dashboard" | "tasks" | "members" | "entities" | "settings">("dashboard");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [settingsForm, setSettingsForm] = useState<any>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showCategoryLegend, setShowCategoryLegend] = useState(false);

  // Phase 5 — per-entity enrollment moderation (disqualify/ban/cancel), the
  // admin-side counterpart to the same actions on
  // pages/user/project-entities.tsx. Separate from `members` above, which is
  // per-*user* (user_projects); this is per-*entity* (project_enrollments,
  // one row per vault entity enrolled by any user).
  const [entityEnrollments, setEntityEnrollments] = useState<any[]>([]);
  const [loadingEntityEnrollments, setLoadingEntityEnrollments] = useState(false);

  const loadEntityEnrollments = useCallback(async () => {
    setLoadingEntityEnrollments(true);
    try {
      const res = await fetch(`${BASE}/api/admin/projects/${projectId}/entity-enrollments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setEntityEnrollments(await res.json());
    } catch {} finally { setLoadingEntityEnrollments(false); }
  }, [projectId, token]);

  const loadTasks = useCallback(async () => {
    setLoadingTasks(true);
    try {
      const res = await fetch(`${BASE}/api/tasks?projectId=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setTasks(await res.json());
    } catch {} finally { setLoadingTasks(false); }
  }, [projectId, token]);

  const loadMembers = useCallback(async () => {
    setLoadingMembers(true);
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMembers(await res.json());
    } catch {} finally { setLoadingMembers(false); }
  }, [projectId, token]);

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => { if (activeTab === "members") loadMembers(); }, [activeTab, loadMembers]);
  useEffect(() => { if (activeTab === "entities") loadEntityEnrollments(); }, [activeTab, loadEntityEnrollments]);
  useEffect(() => {
    if (project && !settingsForm) {
      setSettingsForm({
        name: (project as any).name ?? "",
        description: (project as any).description ?? "",
        xpName: (project as any).xpName ?? "",
        websiteUrl: (project as any).websiteUrl ?? "",
        twitterHandle: (project as any).twitterHandle ?? "",
        discordUrl: (project as any).discordUrl ?? "",
        tier: (project as any).tier ?? "1",
        fundingAmount: (project as any).fundingAmount ?? 0,
        rewardEstimate: (project as any).rewardEstimate ?? 0,
        experienceLevel: (project as any).experienceLevel ?? "Beginner",
        deadline: (project as any).deadline ? new Date((project as any).deadline).toISOString().slice(0, 16) : "",
        status: (project as any).status ?? "active",
        // Phase 7A — badges stored as a JSON-stringified array (same
        // convention as tutorialSteps); parse for the tag-input control.
        badges: (() => {
          try {
            const raw = (project as any).badges;
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
          } catch { return []; }
        })(),
      });
    }
  }, [project, settingsForm]);

  const deleteTask = async (taskId: number) => {
    if (!confirm("Delete this task?")) return;
    await fetch(`${BASE}/api/tasks/${taskId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    toast({ title: "Task deleted" });
    loadTasks();
  };

  // Phase 5 — Disqualify / Ban / Cancel enrollment / Restore, admin side.
  const ENTITY_MODERATION_LABELS: Record<string, string> = {
    disqualified: "Disqualified", banned: "Banned", cancelled: "Cancelled", active: "Restored to active",
  };
  const moderateEntityEnrollment = async (enrollmentId: number, status: "disqualified" | "banned" | "cancelled" | "active") => {
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}/enrollments/${enrollmentId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) { toast({ variant: "destructive", title: "Action failed" }); return; }
      const updated = await res.json();
      setEntityEnrollments(rows => rows.map(r => (r.id === enrollmentId ? { ...r, status: updated.status } : r)));
      toast({ title: ENTITY_MODERATION_LABELS[status] ?? status });
    } catch { toast({ variant: "destructive", title: "Network error" }); }
  };

  const saveSettings = async () => {
    if (!settingsForm) return;
    setSavingSettings(true);
    try {
      const body = {
        ...settingsForm,
        deadline: settingsForm.deadline ? new Date(settingsForm.deadline).toISOString() : undefined,
      };
      const res = await fetch(`${BASE}/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) { toast({ variant: "destructive", title: "Save failed" }); return; }
      toast({ title: "Project settings saved!" });
      refetch();
      setSettingsForm(null);
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    finally { setSavingSettings(false); }
  };

  // ── Project Templates — apply an existing template onto THIS project, or
  // save this project's current fields as a new template. Distinct from
  // admin/projects.tsx's dropdown (that one prefills a blank create form;
  // this one PATCHes a project that already exists). Lazy-loaded the first
  // time the Apply Template menu is opened.
  const [templates, setTemplates] = useState<any[] | null>(null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [previewTemplate, setPreviewTemplate] = useState<any | null>(null);
  const loadTemplates = () => {
    if (templates !== null) return;
    fetch(`${BASE}/api/project-templates`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { templates: [] })
      .then(d => setTemplates(d.templates ?? []))
      .catch(() => setTemplates([]));
  };

  const applyTemplateToProject = async (t: any) => {
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(t.data),
      });
      if (!res.ok) { toast({ variant: "destructive", title: "Could not apply template" }); return; }
      fetch(`${BASE}/api/project-templates/${t.id}/apply`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      toast({ title: "Template applied", description: `${t.name} → ${(project as any)?.name}` });
      refetch();
    } catch { toast({ variant: "destructive", title: "Network error" }); }
  };

  const saveProjectAsTemplate = async () => {
    const name = window.prompt("Template name:", `${(project as any)?.name ?? "Project"} preset`);
    if (!name?.trim()) return;
    try {
      const res = await fetch(`${BASE}/api/project-templates/from-project/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await res.json();
      if (!res.ok) { toast({ variant: "destructive", title: "Could not save template", description: d.error }); return; }
      toast({ title: "Template saved", description: d.name });
      setTemplates(prev => (prev ? [d, ...prev] : [d]));
    } catch { toast({ variant: "destructive", title: "Network error" }); }
  };

  const TABS = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "tasks", label: `Tasks (${tasks.length})`, icon: ListTodo },
    { id: "members", label: "Operators", icon: Users },
    { id: "entities", label: `Entities (${entityEnrollments.length})`, icon: Shield },
    { id: "settings", label: "Settings", icon: Settings },
  ] as const;

  const keyTasks = tasks.filter(t => (t.rewardAmount ?? 0) > 0).slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/admin/projects">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-3">
            {projectLoading ? <Skeleton className="h-8 w-40" /> : (project as any)?.name}
            {(project as any)?.tier && (
              <Badge variant="outline" className="font-mono text-xs border-primary/50 text-primary">
                TIER {(project as any).tier}
              </Badge>
            )}
            {(project as any)?.status && (project as any).status !== "active" && (
              <Badge variant="outline" className="font-mono text-xs border-amber-400/50 text-amber-400">
                {((project as any).status as string).toUpperCase()}
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Protocol details · admin panel</p>
        </div>
        <DropdownMenu onOpenChange={(open) => { if (open) loadTemplates(); else setTemplateSearch(""); }}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="font-mono text-xs gap-2 uppercase tracking-wider">
              <LayoutTemplate className="h-3.5 w-3.5" /> Template
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">Apply template</div>
            {templates && templates.length > 3 && (
              <div className="px-2 py-1.5">
                <Input
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  placeholder="Search templates…"
                  className="h-7 text-xs font-mono"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )}
            {(!templates || templates.length === 0) && (
              <div className="px-2 py-1.5 text-[11px] font-mono text-muted-foreground">
                {templates === null ? "Loading…" : "No templates yet"}
              </div>
            )}
            {templates && templates.length > 0 && filterProjectTemplates(templates, templateSearch).length === 0 && (
              <div className="px-2 py-1.5 text-[11px] font-mono text-muted-foreground">No matches</div>
            )}
            {filterProjectTemplates(templates ?? [], templateSearch).map(t => (
              <DropdownMenuItem key={t.id} onClick={() => setPreviewTemplate(t)} className="font-mono text-xs">
                {t.name}
              </DropdownMenuItem>
            ))}
            <div className="my-1 border-t border-border" />
            <DropdownMenuItem onClick={saveProjectAsTemplate} className="font-mono text-xs gap-2">
              <Save className="h-3.5 w-3.5" /> Save this project as template
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {previewTemplate && (
          <TemplatePreviewModal
            templateName={previewTemplate.name}
            rows={buildTemplateDiff(previewTemplate.data, project as any)}
            onClose={() => setPreviewTemplate(null)}
            confirmLabel="Apply to this Project"
            onConfirm={() => { applyTemplateToProject(previewTemplate); setPreviewTemplate(null); }}
          />
        )}
        {(project as any)?.deadline && (
          <div className="flex flex-col items-end gap-1">
            <span className="font-mono text-[9px] text-muted-foreground/50 uppercase">Deadline</span>
            <CountdownTimer deadline={(project as any).deadline} />
          </div>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: "Active Operators", value: statsLoading ? null : (stats as any)?.activeUsers || 0, icon: Users, color: "text-primary" },
          { label: "Total Tasks", value: statsLoading ? null : tasks.length, icon: Activity, color: "text-cyan-400" },
          { label: "Executions", value: statsLoading ? null : (stats as any)?.completedTasks || 0, icon: CheckSquare, color: "text-emerald-400" },
          { label: "Distributed ROI", value: statsLoading ? null : `$${((stats as any)?.totalRoiDistributed || 0).toLocaleString()}`, icon: Zap, color: "text-yellow-400" },
        ].map(s => (
          <Card key={s.label} className="bg-card border-card-border shadow-none">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">{s.label}</CardTitle>
              <s.icon className={cn("h-4 w-4", s.color)} />
            </CardHeader>
            <CardContent>
              {s.value === null ? <Skeleton className="h-8 w-16" /> : (
                <div className={cn("text-2xl font-bold font-mono", s.color)}>{s.value}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-0.5 p-1 bg-muted/20 rounded-xl border border-border/30 w-fit">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-[10px] uppercase tracking-wider transition-all",
              activeTab === tab.id
                ? "bg-card text-primary font-bold shadow-sm border border-border/40"
                : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            <tab.icon className="w-3 h-3" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── DASHBOARD TAB ─── */}
      {activeTab === "dashboard" && (
        <div className="space-y-4">
          {/* Description + Links */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="bg-card border-card-border shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="font-mono text-xs uppercase text-primary/60">Protocol Intel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="font-mono text-sm text-muted-foreground leading-relaxed">
                  {projectLoading ? <Skeleton className="h-16 w-full" /> : ((project as any)?.description || "No description.")}
                </p>
                {(project as any)?.xpName && (
                  <div className="flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="font-mono text-xs text-yellow-400">{(project as any).xpName} XP Token</span>
                  </div>
                )}
                <div className="flex flex-col gap-1.5 pt-1">
                  {(project as any)?.websiteUrl && (
                    <a href={(project as any).websiteUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
                      <Globe className="w-3.5 h-3.5" /> Website
                    </a>
                  )}
                  {(project as any)?.twitterHandle && (
                    <a href={`https://twitter.com/${(project as any).twitterHandle.replace("@","")}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-sky-400 transition-colors">
                      <Twitter className="w-3.5 h-3.5" /> {(project as any).twitterHandle}
                    </a>
                  )}
                  {(project as any)?.discordUrl && (
                    <a href={(project as any).discordUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-indigo-400 transition-colors">
                      <MessageCircle className="w-3.5 h-3.5" /> Discord
                    </a>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-card-border shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="font-mono text-xs uppercase text-primary/60">Key Tasks</CardTitle>
              </CardHeader>
              <CardContent>
                {keyTasks.length === 0 ? (
                  <p className="font-mono text-xs text-muted-foreground/50">No high-value tasks yet.</p>
                ) : (
                  <div className="space-y-2">
                    {keyTasks.map(t => (
                      <div key={t.id} className="flex items-center gap-3 p-2 bg-muted/10 rounded-md">
                        <Star className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-xs font-bold truncate">{t.name}</div>
                          <div className="font-mono text-[9px] text-muted-foreground/50">{t.taskType} · {t.verificationType}</div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <TaskCategoryBadge category={t.taskCategory ?? t.category ?? "B1"} />
                          {t.rewardAmount && <span className="font-mono text-[9px] text-primary font-bold">${t.rewardAmount}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Financials */}
          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="font-mono text-xs uppercase text-primary/60">Financials</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Funding</div>
                  <div className="font-mono text-xl font-bold text-primary">${(project as any)?.fundingAmount?.toLocaleString() ?? 0}</div>
                </div>
                <div className="space-y-1">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Est. Reward</div>
                  <div className="font-mono text-xl font-bold text-emerald-400">${(project as any)?.rewardEstimate?.toLocaleString() ?? 0}</div>
                </div>
                <div className="space-y-1">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">ROI Distributed</div>
                  <div className="font-mono text-xl font-bold text-yellow-400">${(project as any)?.totalRoiDistributed?.toLocaleString() ?? 0}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── TASKS TAB ─── */}
      {activeTab === "tasks" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono font-bold text-sm">Tasks</div>
              <div className="font-mono text-[10px] text-muted-foreground/50">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCategoryLegend(v => !v)}
                className="font-mono text-[10px] text-muted-foreground/50 hover:text-primary transition-colors border border-card-border rounded px-2 py-1"
              >
                Category Guide
              </button>
              <TaskDialog projectId={projectId} projectMeta={{ name: (project as any)?.name, xpName: (project as any)?.xpName, xpPrice: (project as any)?.xpPrice }} onDone={loadTasks} />
            </div>
          </div>

          {showCategoryLegend && (
            <Card className="bg-card border-card-border shadow-none p-4">
              <CategoryLegend />
            </Card>
          )}

          {loadingTasks ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : tasks.length === 0 ? (
            <Card className="bg-card border-card-border shadow-none">
              <CardContent className="p-8 text-center font-mono text-muted-foreground/50">
                No tasks yet. Add the first task.
              </CardContent>
            </Card>
          ) : (
            <Card className="bg-card border-card-border shadow-none overflow-hidden">
              <div className="divide-y divide-card-border">
                {tasks.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/5 group transition-colors">
                    <TaskCategoryBadge category={t.taskCategory ?? t.category ?? "B1"} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-medium">{t.name}</span>
                        <Badge variant="outline" className="font-mono text-[9px] border-card-border text-muted-foreground/50">{t.taskType}</Badge>
                        {t.verificationType === "auto" && (
                          <Badge variant="outline" className="font-mono text-[9px] border-emerald-400/20 text-emerald-400">AUTO</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        {t.description && <span className="font-mono text-[9px] text-muted-foreground/40 truncate max-w-xs">{t.description}</span>}
                        {t.rewardAmount != null && t.rewardAmount > 0 && <span className="font-mono text-[9px] text-primary font-bold">${t.rewardAmount} reward</span>}
                        {(t.cost ?? 0) > 0 && <span className="font-mono text-[9px] text-red-400">-${t.cost} cost</span>}
                        {(t.profit ?? 0) > 0 && <span className="font-mono text-[9px] text-emerald-400">+${t.profit} profit</span>}
                        <span className="font-mono text-[9px] text-muted-foreground/30">{t.completionCount} done</span>
                      </div>
                      {t.deadline && (
                        <div className="mt-1">
                          <CountdownTimer deadline={t.deadline} compact />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <TaskDialog projectId={projectId} projectMeta={{ name: (project as any)?.name, xpName: (project as any)?.xpName, xpPrice: (project as any)?.xpPrice }} task={t} onDone={loadTasks} />
                      <Button size="sm" variant="ghost" onClick={() => deleteTask(t.id)}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ─── MEMBERS / OPERATORS TAB ─── */}
      {activeTab === "members" && (
        <div className="space-y-3">
          <div>
            <div className="font-mono font-bold text-sm">Operators</div>
            <div className="font-mono text-[10px] text-muted-foreground/50">{members.length} enrolled</div>
          </div>
          {loadingMembers ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : members.length === 0 ? (
            <Card className="bg-card border-card-border shadow-none">
              <CardContent className="p-8 text-center font-mono text-muted-foreground/50">No operators enrolled yet.</CardContent>
            </Card>
          ) : (
            <>
              {/* ROI Summary Bar */}
              {(() => {
                const totalTasks = members.reduce((s: number, m: any) => s + (m.tasksCompleted || 0), 0);
                const maxTasks = Math.max(...members.map((m: any) => m.tasksCompleted || 0), 1);
                const totalRoi = members.reduce((s: number, m: any) => s + (m.roi || 0), 0);
                return (
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    {[
                      { label: "Total Operators", value: members.length, color: "text-primary" },
                      { label: "Total Executions", value: totalTasks, color: "text-emerald-400" },
                      { label: "ROI Distributed", value: `$${totalRoi.toLocaleString()}`, color: "text-yellow-400" },
                    ].map(s => (
                      <div key={s.label} className="bg-card border border-card-border rounded-lg p-3">
                        <div className={cn("font-mono text-lg font-bold", s.color)}>{s.value}</div>
                        <div className="font-mono text-[9px] text-muted-foreground/50">{s.label}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              <Card className="bg-card border-card-border shadow-none overflow-hidden">
                <div className="divide-y divide-card-border">
                  {members.map((m: any) => {
                    const maxTasks = Math.max(...members.map((x: any) => x.tasksCompleted || 0), 1);
                    const pct = Math.round(((m.tasksCompleted || 0) / maxTasks) * 100);
                    const progressPct = Math.round(m.progress || 0);
                    return (
                      <div key={m.userId} className="px-4 py-3 space-y-2">
                        <div className="flex items-center gap-4">
                          <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 font-bold font-mono text-xs text-primary">
                            {(m.username || "?")[0].toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm font-bold">{m.username}</div>
                            <div className="font-mono text-[9px] text-muted-foreground/40">
                              Joined {m.joinedAt ? format(new Date(m.joinedAt), "MMM d, yyyy") : "—"}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className="font-mono text-xs font-bold text-primary">{m.tasksCompleted} tasks</div>
                            <div className="font-mono text-[9px] text-muted-foreground/40">{progressPct}% done</div>
                          </div>
                        </div>
                        {/* ROI bar */}
                        <div className="space-y-0.5">
                          <div className="flex justify-between text-[9px] font-mono text-muted-foreground/40">
                            <span>Task completion</span>
                            <span>{pct}% of top performer</span>
                          </div>
                          <div className="h-1.5 bg-muted/20 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-primary/60 to-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between text-[9px] font-mono text-muted-foreground/40">
                            <span>Project progress</span>
                            <span>{progressPct}%</span>
                          </div>
                          <div className="h-1 bg-muted/20 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-emerald-500/50 to-emerald-400 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ─── ENTITIES TAB — Phase 5: per-entity enrollment moderation ─── */}
      {activeTab === "entities" && (
        <div className="space-y-3">
          <div>
            <div className="font-mono font-bold text-sm">Entity Enrollments</div>
            <div className="font-mono text-[10px] text-muted-foreground/50">
              {entityEnrollments.length} entit{entityEnrollments.length !== 1 ? "ies" : "y"} enrolled · disqualify, ban, or cancel an entity's enrollment
            </div>
          </div>
          {loadingEntityEnrollments ? (
            <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : entityEnrollments.length === 0 ? (
            <Card className="bg-card border-card-border shadow-none">
              <CardContent className="p-8 text-center font-mono text-muted-foreground/50">No entities enrolled yet.</CardContent>
            </Card>
          ) : (
            <Card className="bg-card border-card-border shadow-none overflow-hidden">
              <div className="divide-y divide-card-border">
                {entityEnrollments.map((enr: any) => {
                  const statusMeta: Record<string, { label: string; className: string }> = {
                    active: { label: "Active", className: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5" },
                    disqualified: { label: "Disqualified", className: "text-amber-400 border-amber-400/30 bg-amber-400/5" },
                    banned: { label: "Banned", className: "text-red-400 border-red-400/30 bg-red-400/5" },
                    cancelled: { label: "Cancelled", className: "text-muted-foreground/60 border-border/30 bg-muted/5" },
                  };
                  const meta = statusMeta[enr.status] ?? { label: enr.status, className: "text-muted-foreground/60 border-border/30" };
                  return (
                    <div key={enr.id} className={cn("px-4 py-3 flex items-center gap-3", enr.status !== "active" && "opacity-60")}>
                      <Shield className="w-4 h-4 text-primary/70 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs font-bold truncate">{enr.entity?.projectName ?? `Entity #${enr.vaultEntryId}`}</div>
                        <div className="font-mono text-[9px] text-muted-foreground/40 truncate">
                          {enr.entity?.entitySerial ? `${enr.entity.entitySerial} · ` : ""}Owner: {enr.ownerUsername ?? `user #${enr.userId}`}
                        </div>
                      </div>
                      <Badge variant="outline" className={cn("font-mono text-[9px] flex-shrink-0", meta.className)}>{meta.label}</Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0">
                            <MoreVertical className="w-3.5 h-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="font-mono text-xs">
                          {enr.status !== "active" && (
                            <DropdownMenuItem onClick={() => moderateEntityEnrollment(enr.id, "active")} className="gap-1.5">
                              <RotateCcw className="w-3.5 h-3.5" /> Restore to active
                            </DropdownMenuItem>
                          )}
                          {enr.status !== "disqualified" && (
                            <DropdownMenuItem onClick={() => moderateEntityEnrollment(enr.id, "disqualified")} className="gap-1.5 text-amber-400 focus:text-amber-400">
                              <ShieldAlert className="w-3.5 h-3.5" /> Disqualify
                            </DropdownMenuItem>
                          )}
                          {enr.status !== "banned" && (
                            <DropdownMenuItem onClick={() => moderateEntityEnrollment(enr.id, "banned")} className="gap-1.5 text-red-400 focus:text-red-400">
                              <Ban className="w-3.5 h-3.5" /> Ban
                            </DropdownMenuItem>
                          )}
                          {enr.status !== "cancelled" && (
                            <DropdownMenuItem onClick={() => moderateEntityEnrollment(enr.id, "cancelled")} className="gap-1.5">
                              <XCircle className="w-3.5 h-3.5" /> Cancel enrollment
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ─── SETTINGS TAB ─── */}
      {activeTab === "settings" && settingsForm && (
        <div className="space-y-4 max-w-2xl">
          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-xs uppercase text-primary/60">General</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { key: "name", label: "Project Name *", placeholder: "Project name" },
                { key: "xpName", label: "XP Token Name", placeholder: "e.g. LAYER3 XP" },
                { key: "websiteUrl", label: "Website URL", placeholder: "https://..." },
                { key: "twitterHandle", label: "Twitter Handle", placeholder: "@handle" },
                { key: "discordUrl", label: "Discord URL", placeholder: "https://discord.gg/..." },
              ].map(f => (
                <div key={f.key} className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{f.label}</Label>
                  <Input
                    value={settingsForm[f.key] ?? ""}
                    onChange={e => setSettingsForm((p: any) => ({ ...p, [f.key]: e.target.value }))}
                    className="font-mono text-xs h-8 bg-input"
                    placeholder={f.placeholder}
                  />
                </div>
              ))}
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Description</Label>
                <Textarea
                  value={settingsForm.description ?? ""}
                  onChange={e => setSettingsForm((p: any) => ({ ...p, description: e.target.value }))}
                  className="font-mono text-xs bg-input min-h-[80px] resize-none"
                  placeholder="Project description..."
                />
              </div>
              {/* Phase 7A — badges/tags, editable alongside description */}
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Badges / Tags</Label>
                <BadgeTagInput
                  value={settingsForm.badges ?? []}
                  onChange={tags => setSettingsForm((p: any) => ({ ...p, badges: tags }))}
                />
              </div>
            </CardContent>
          </Card>

          <ProjectDatesManager projectId={projectId} />

          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-xs uppercase text-primary/60">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1 mb-3">
                <Label className="font-mono text-[10px] uppercase text-muted-foreground">Category</Label>
                <div className="flex flex-wrap gap-1.5">
                  {["DeFi","NFT","GameFi","Layer2","Testnet","CEX","Exchange","Instant Web3","TGE","Social","Other"].map(cat => (
                    <button key={cat} onClick={() => setSettingsForm((p: any) => ({ ...p, category: cat }))}
                      className={cn("px-2.5 py-1 rounded-lg font-mono text-[10px] border transition-all",
                        (settingsForm.category ?? "Other") === cat
                          ? "border-primary/50 bg-primary/10 text-primary font-bold"
                          : "border-card-border text-muted-foreground/60 hover:border-primary/20")}>
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase text-muted-foreground">Tier</Label>
                  <Select value={settingsForm.tier} onValueChange={v => setSettingsForm((p: any) => ({ ...p, tier: v }))}>
                    <SelectTrigger className="font-mono text-xs h-8 bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["1","2","3","4","5"].map(t => <SelectItem key={t} value={t} className="font-mono text-xs">Tier {t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase text-muted-foreground">Funding ($)</Label>
                  <Input type="number" value={settingsForm.fundingAmount} onChange={e => setSettingsForm((p: any) => ({ ...p, fundingAmount: Number(e.target.value) }))} className="font-mono text-xs h-8 bg-input" />
                </div>
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase text-muted-foreground">Est. Reward ($)</Label>
                  <Input type="number" value={settingsForm.rewardEstimate} onChange={e => setSettingsForm((p: any) => ({ ...p, rewardEstimate: Number(e.target.value) }))} className="font-mono text-xs h-8 bg-input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase text-muted-foreground">Experience Level</Label>
                  <Select value={settingsForm.experienceLevel} onValueChange={v => setSettingsForm((p: any) => ({ ...p, experienceLevel: v }))}>
                    <SelectTrigger className="font-mono text-xs h-8 bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Beginner","Intermediate","Advanced"].map(l => <SelectItem key={l} value={l} className="font-mono text-xs">{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase text-muted-foreground">Status</Label>
                  <Select value={settingsForm.status} onValueChange={v => setSettingsForm((p: any) => ({ ...p, status: v }))}>
                    <SelectTrigger className="font-mono text-xs h-8 bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["active","paused","completed","archived"].map(s => <SelectItem key={s} value={s} className="font-mono text-xs capitalize">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase text-muted-foreground flex items-center gap-1">
                  <Timer className="w-2.5 h-2.5" /> Project Deadline
                </Label>
                <Input
                  type="datetime-local"
                  value={settingsForm.deadline}
                  onChange={e => setSettingsForm((p: any) => ({ ...p, deadline: e.target.value }))}
                  className="font-mono text-xs h-8 bg-input"
                />
              </div>
            </CardContent>
          </Card>

          <Button onClick={saveSettings} disabled={savingSettings} className="font-mono text-xs uppercase gap-2">
            {savingSettings ? "Saving..." : <><CheckSquare className="w-3.5 h-3.5" /> Save Settings</>}
          </Button>
        </div>
      )}
    </div>
  );
}
