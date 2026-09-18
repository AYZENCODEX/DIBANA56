import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Plus, ExternalLink, Zap, Trash2, BookOpen, Info, DollarSign, Settings2, Tag, Pencil,
  ChevronUp, ChevronDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// This is the same rich, tabbed "New Task" experience used on the Task
// sidebar page (admin/tasks.tsx). It's shared here so any place that lets
// someone create a task — the Task sidebar itself, or a specific
// Protocol/project's Tasks tab — uses one consistent create/edit UI.

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export interface TFDProject { id: number; name: string; xpName?: string | null; xpPrice?: number; }

export interface TFDTaskRow {
  id: number; name: string; projectName?: string | null; projectId?: number | null;
  taskType: string; verificationType: string; xpAmount?: number | null;
  rewardAmount?: number | null; taskId?: string; description?: string | null;
  taskLink?: string | null; steps?: { title: string; description?: string }[];
  taskCategory?: string | null; deadline?: string | null; timeLimitMinutes?: number | null;
  priority?: string | null; estimatedCost?: number | null; estimatedProfit?: number | null;
  difficultyLevel?: string | null;
}

type CreateTab = "details" | "steps" | "meta" | "roi" | "settings";

const CREATE_TABS: { id: CreateTab; label: string; icon: React.ElementType }[] = [
  { id: "details",  label: "Details",  icon: Info },
  { id: "steps",    label: "Steps",    icon: BookOpen },
  { id: "meta",     label: "Meta",     icon: Tag },
  { id: "roi",      label: "ROI",      icon: DollarSign },
  { id: "settings", label: "Settings", icon: Settings2 },
];

interface StepItem { id: string; title: string; description: string; }

function newStep(): StepItem {
  return { id: Math.random().toString(36).slice(2), title: "", description: "" };
}

function StepBuilder({ steps, setSteps }: {
  steps: StepItem[];
  setSteps: React.Dispatch<React.SetStateAction<StepItem[]>>;
}) {
  const moveStep = (idx: number, dir: -1 | 1) => {
    const next = [...steps];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setSteps(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-muted-foreground">
          Build a step-by-step tutorial users will follow to complete this task.
        </p>
        <button
          type="button"
          onClick={() => setSteps(s => [...s, newStep()])}
          className="flex items-center gap-1 font-mono text-[10px] text-primary hover:text-primary/80 border border-primary/30 hover:border-primary/50 rounded px-2 py-1 transition-all"
        >
          <Plus className="w-3 h-3" /> Add Step
        </button>
      </div>

      {steps.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-border/40 rounded-lg">
          <BookOpen className="w-7 h-7 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-[10px] font-mono text-muted-foreground/50">No steps yet — click "Add Step" to build a guide</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {steps.map((step, i) => (
            <div key={step.id} className="flex gap-2 items-start bg-muted/20 rounded-lg p-3 border border-border/30">
              <div className="flex flex-col items-center gap-0.5 mt-1">
                <button
                  type="button"
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  className="text-muted-foreground/30 hover:text-muted-foreground disabled:opacity-20 transition-colors"
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
                <span className="font-mono text-[10px] text-muted-foreground/50 w-5 text-center">{i + 1}</span>
                <button
                  type="button"
                  onClick={() => moveStep(i, 1)}
                  disabled={i === steps.length - 1}
                  className="text-muted-foreground/30 hover:text-muted-foreground disabled:opacity-20 transition-colors"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
              <div className="flex-1 space-y-1.5">
                <Input
                  value={step.title}
                  onChange={e => setSteps(s => s.map(x => x.id === step.id ? { ...x, title: e.target.value } : x))}
                  placeholder={`Step ${i + 1} title *`}
                  className="font-mono text-[11px] h-7 bg-input border-border"
                />
                <Textarea
                  value={step.description}
                  onChange={e => setSteps(s => s.map(x => x.id === step.id ? { ...x, description: e.target.value } : x))}
                  placeholder="Description / instructions (optional)"
                  rows={2}
                  className="font-mono text-[10px] bg-input border-border resize-none min-h-[44px]"
                />
              </div>
              <button
                type="button"
                onClick={() => setSteps(s => s.filter(x => x.id !== step.id))}
                className="text-muted-foreground/40 hover:text-red-400 transition-colors mt-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {steps.length > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground/50 text-center">
          {steps.length} step{steps.length !== 1 ? "s" : ""} · Users will see a checklist
        </p>
      )}
    </div>
  );
}

export interface TaskFormDialogProps {
  open: boolean;
  onClose: () => void;
  editTask: TFDTaskRow | null;
  projects: TFDProject[];
  onSaved: () => void;
  /**
   * When set, the task is always created/edited under this project and the
   * project picker on the Details tab is locked to it instead of being
   * user-selectable. Use this when the dialog is opened from inside a
   * specific Protocol/project (e.g. a project's Tasks tab).
   */
  lockedProjectId?: number;
}

export function TaskFormDialog({
  open,
  onClose,
  editTask,
  projects,
  onSaved,
  lockedProjectId,
}: TaskFormDialogProps) {
  const { toast } = useToast();
  const isEdit = !!editTask;

  const [createTab, setCreateTab] = useState<CreateTab>("details");
  const [saving, setSaving] = useState(false);

  // Details
  const [form, setForm] = useState({
    name: "", description: "", projectId: "", taskLink: "",
  });
  // Steps
  const [steps, setSteps] = useState<StepItem[]>([]);
  // Meta
  const [meta, setMeta] = useState({
    taskType: "One-time", verificationType: "manual",
    taskCategory: "", priority: "normal",
    deadline: "", timeLimitMinutes: "",
    difficultyLevel: "medium",
  });
  // ROI
  const [roi, setRoi] = useState({
    xpAmount: "", rewardAmount: "",
    estimatedCost: "", estimatedProfit: "",
  });
  // Settings (placeholder)
  const [settings, setSettings] = useState({
    isVisible: true, allowResubmit: false, maxSubmissions: "",
  });

  // Populate when editing / opening
  useEffect(() => {
    if (editTask) {
      setForm({
        name: editTask.name ?? "",
        description: editTask.description ?? "",
        projectId: lockedProjectId ? String(lockedProjectId) : (editTask.projectId ? String(editTask.projectId) : ""),
        taskLink: editTask.taskLink ?? "",
      });
      setSteps(
        Array.isArray(editTask.steps)
          ? editTask.steps.map((s, i) => ({ id: String(i), title: s.title, description: s.description ?? "" }))
          : []
      );
      setMeta({
        taskType: editTask.taskType ?? "One-time",
        verificationType: editTask.verificationType ?? "manual",
        taskCategory: editTask.taskCategory ?? "",
        priority: editTask.priority ?? "normal",
        deadline: editTask.deadline ? editTask.deadline.split("T")[0] : "",
        timeLimitMinutes: editTask.timeLimitMinutes ? String(editTask.timeLimitMinutes) : "",
        difficultyLevel: editTask.difficultyLevel ?? "medium",
      });
      setRoi({
        xpAmount: editTask.xpAmount ? String(editTask.xpAmount) : "",
        rewardAmount: editTask.rewardAmount ? String(editTask.rewardAmount) : "",
        estimatedCost: editTask.estimatedCost ? String(editTask.estimatedCost) : "",
        estimatedProfit: editTask.estimatedProfit ? String(editTask.estimatedProfit) : "",
      });
    } else {
      setForm({ name: "", description: "", projectId: lockedProjectId ? String(lockedProjectId) : "", taskLink: "" });
      setSteps([]);
      setMeta({ taskType: "One-time", verificationType: "manual", taskCategory: "", priority: "normal", deadline: "", timeLimitMinutes: "", difficultyLevel: "medium" });
      setRoi({ xpAmount: "", rewardAmount: "", estimatedCost: "", estimatedProfit: "" });
      setSettings({ isVisible: true, allowResubmit: false, maxSubmissions: "" });
    }
    setCreateTab("details");
  }, [editTask, open, lockedProjectId]);

  const selectedProject = projects.find(p => String(p.id) === form.projectId);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ variant: "destructive", title: "Task name is required." });
      setCreateTab("details");
      return;
    }
    setSaving(true);
    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        taskType: meta.taskType,
        verificationType: meta.verificationType,
        xpAmount: roi.xpAmount ? parseFloat(roi.xpAmount) : 0,
        steps: steps.length > 0 ? steps.map(({ title, description }) => ({ title, description })) : undefined,
        taskLink: form.taskLink.trim() || undefined,
        taskCategory: meta.taskCategory || undefined,
        priority: meta.priority,
        deadline: meta.deadline || undefined,
        timeLimitMinutes: meta.timeLimitMinutes ? parseInt(meta.timeLimitMinutes, 10) : undefined,
        difficultyLevel: meta.difficultyLevel,
        estimatedCost: roi.estimatedCost ? parseFloat(roi.estimatedCost) : undefined,
        estimatedProfit: roi.estimatedProfit ? parseFloat(roi.estimatedProfit) : undefined,
      };
      const effectiveProjectId = lockedProjectId ?? (form.projectId ? parseInt(form.projectId, 10) : undefined);
      if (effectiveProjectId) body.projectId = effectiveProjectId;
      if (roi.rewardAmount) body.rewardAmount = parseFloat(roi.rewardAmount);

      const url = isEdit ? `${BASE}/api/tasks/${editTask!.id}` : `${BASE}/api/tasks`;
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast({ title: isEdit ? "Task updated ✓" : "Task created ✓", description: `"${form.name}"` });
        onSaved();
        onClose();
      } else {
        const d = await res.json();
        toast({ variant: "destructive", title: "Failed", description: d.error });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSaving(false);
  };

  const estimatedRoi =
    roi.estimatedCost && roi.estimatedProfit && parseFloat(roi.estimatedCost) > 0
      ? (((parseFloat(roi.estimatedProfit) - parseFloat(roi.estimatedCost)) / parseFloat(roi.estimatedCost)) * 100).toFixed(1)
      : null;

  const lockedProject = lockedProjectId ? projects.find(p => p.id === lockedProjectId) : undefined;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="bg-card border-card-border max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-primary flex items-center gap-2">
            {isEdit ? <><Pencil className="w-4 h-4" /> Edit Task</> : <><Plus className="w-4 h-4" /> New Task</>}
          </DialogTitle>
          <p className="text-xs font-mono text-muted-foreground">
            {isEdit ? `Editing: ${editTask?.name}` : "Create a new task with step-by-step guide, ROI tracking, and settings."}
          </p>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex border-b border-border overflow-x-auto -mx-1 px-1">
          {CREATE_TABS.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setCreateTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-[10px] font-mono uppercase tracking-wider border-b-2 transition-all -mb-px whitespace-nowrap",
                  createTab === t.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="w-3 h-3" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="space-y-3 py-2 max-h-[55vh] overflow-y-auto">

          {/* ── Details ── */}
          {createTab === "details" && (
            <>
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Task Name *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="e.g. Daily Check-in" />
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Project</Label>
                {lockedProjectId ? (
                  <div className="font-mono text-xs h-9 rounded-md border border-border bg-muted/20 px-3 flex items-center gap-1.5 text-foreground">
                    {lockedProject?.name ?? `Project #${lockedProjectId}`}
                    {lockedProject?.xpName && <span className="text-muted-foreground/60">({lockedProject.xpName})</span>}
                  </div>
                ) : (
                  <>
                    <Select value={form.projectId || "none"} onValueChange={v => setForm(f => ({ ...f, projectId: v === "none" ? "" : v }))}>
                      <SelectTrigger className="font-mono text-xs h-9 border-border bg-input"><SelectValue placeholder="— Individual task —" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none" className="font-mono text-xs text-muted-foreground">— Individual task (no project) —</SelectItem>
                        {projects.map(p => (
                          <SelectItem key={p.id} value={String(p.id)} className="font-mono text-xs">
                            {p.name} {p.xpName ? `(${p.xpName})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedProject?.xpName && (
                      <p className="font-mono text-[10px] text-violet-400/80">XP unit: {selectedProject.xpName} · 1 {selectedProject.xpName} = {selectedProject.xpPrice ?? 0.01} AZN</p>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Description</Label>
                <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="font-mono text-xs bg-input min-h-[70px] resize-none" placeholder="What operators need to do..." />
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                  <ExternalLink className="w-3 h-3 text-sky-400" /> Task Website Link (optional)
                </Label>
                <Input value={form.taskLink} onChange={e => setForm(f => ({ ...f, taskLink: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="https://galxe.com/..." type="url" />
                <p className="font-mono text-[10px] text-muted-foreground/50">Users will see an in-app browser to complete the task</p>
              </div>
            </>
          )}

          {/* ── Steps ── */}
          {createTab === "steps" && (
            <StepBuilder steps={steps} setSteps={setSteps} />
          )}

          {/* ── Meta ── */}
          {createTab === "meta" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Task Type</Label>
                  <Select value={meta.taskType} onValueChange={v => setMeta(m => ({ ...m, taskType: v }))}>
                    <SelectTrigger className="font-mono text-xs h-9 border-border bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["One-time", "Daily", "Weekly", "Recurring"].map(t => <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Verification</Label>
                  <Select value={meta.verificationType} onValueChange={v => setMeta(m => ({ ...m, verificationType: v }))}>
                    <SelectTrigger className="font-mono text-xs h-9 border-border bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["manual", "auto"].map(t => <SelectItem key={t} value={t} className="font-mono text-xs capitalize">{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Priority</Label>
                  <Select value={meta.priority} onValueChange={v => setMeta(m => ({ ...m, priority: v }))}>
                    <SelectTrigger className="font-mono text-xs h-9 border-border bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["urgent", "high", "normal", "low"].map(t => <SelectItem key={t} value={t} className="font-mono text-xs capitalize">{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Difficulty</Label>
                  <Select value={meta.difficultyLevel} onValueChange={v => setMeta(m => ({ ...m, difficultyLevel: v }))}>
                    <SelectTrigger className="font-mono text-xs h-9 border-border bg-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["easy", "medium", "hard", "expert"].map(t => <SelectItem key={t} value={t} className="font-mono text-xs capitalize">{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Category Tag</Label>
                <Input value={meta.taskCategory} onChange={e => setMeta(m => ({ ...m, taskCategory: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="e.g. DeFi, NFT, Social" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Deadline (optional)</Label>
                  <Input value={meta.deadline} onChange={e => setMeta(m => ({ ...m, deadline: e.target.value }))} type="date" className="font-mono text-xs h-9 bg-input" />
                </div>
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Time Limit (min)</Label>
                  <Input value={meta.timeLimitMinutes} onChange={e => setMeta(m => ({ ...m, timeLimitMinutes: e.target.value }))} type="number" className="font-mono text-xs h-9 bg-input" placeholder="e.g. 60" />
                </div>
              </div>
            </>
          )}

          {/* ── ROI ── */}
          {createTab === "roi" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                    <Zap className="w-3 h-3 text-violet-400" /> XP Reward
                  </Label>
                  <Input value={roi.xpAmount} onChange={e => setRoi(r => ({ ...r, xpAmount: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="e.g. 50" type="number" step="1" min="0" />
                </div>
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Reward (USD)</Label>
                  <Input value={roi.rewardAmount} onChange={e => setRoi(r => ({ ...r, rewardAmount: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="e.g. 5.00" type="number" step="0.01" />
                </div>
              </div>

              {roi.xpAmount && selectedProject?.xpPrice ? (
                <p className="font-mono text-[10px] text-violet-400/80 bg-violet-500/5 border border-violet-500/20 rounded px-3 py-1.5">
                  ≈ {(parseFloat(roi.xpAmount) * selectedProject.xpPrice).toFixed(4)} AZN will be auto-awarded on approval
                </p>
              ) : null}

              <div className="border-t border-border/40 pt-3 space-y-3">
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">Expected Cost & Profit (for admin reference)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="font-mono text-[10px] uppercase tracking-widest text-red-400/80">Est. Cost ($)</Label>
                    <Input value={roi.estimatedCost} onChange={e => setRoi(r => ({ ...r, estimatedCost: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="0.00" type="number" step="0.01" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-mono text-[10px] uppercase tracking-widest text-emerald-400/80">Est. Profit ($)</Label>
                    <Input value={roi.estimatedProfit} onChange={e => setRoi(r => ({ ...r, estimatedProfit: e.target.value }))} className="font-mono text-xs h-9 bg-input" placeholder="0.00" type="number" step="0.01" />
                  </div>
                </div>
                {estimatedRoi !== null && (
                  <div className={cn(
                    "rounded-lg border p-3 text-center",
                    Number(estimatedRoi) >= 0 ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"
                  )}>
                    <div className="font-mono text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Expected ROI</div>
                    <div className={cn("font-mono text-2xl font-bold", Number(estimatedRoi) >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {Number(estimatedRoi) >= 0 ? "+" : ""}{estimatedRoi}%
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-1">
                      Net: ${(parseFloat(roi.estimatedProfit || "0") - parseFloat(roi.estimatedCost || "0")).toFixed(2)}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Settings ── */}
          {createTab === "settings" && (
            <>
              <div className="space-y-3">
                <div className="flex items-center justify-between py-3 px-4 rounded-lg border border-border/40 bg-muted/10">
                  <div>
                    <div className="font-mono text-xs font-medium">Visible to Users</div>
                    <div className="font-mono text-[10px] text-muted-foreground/60">Show this task in the user task list</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSettings(s => ({ ...s, isVisible: !s.isVisible }))}
                    className={cn(
                      "w-9 h-5 rounded-full border transition-all relative",
                      settings.isVisible ? "bg-primary border-primary" : "bg-muted border-border"
                    )}
                  >
                    <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", settings.isVisible ? "left-4" : "left-0.5")} />
                  </button>
                </div>

                <div className="flex items-center justify-between py-3 px-4 rounded-lg border border-border/40 bg-muted/10">
                  <div>
                    <div className="font-mono text-xs font-medium">Allow Re-submission</div>
                    <div className="font-mono text-[10px] text-muted-foreground/60">Users can submit again after rejection</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSettings(s => ({ ...s, allowResubmit: !s.allowResubmit }))}
                    className={cn(
                      "w-9 h-5 rounded-full border transition-all relative",
                      settings.allowResubmit ? "bg-primary border-primary" : "bg-muted border-border"
                    )}
                  >
                    <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", settings.allowResubmit ? "left-4" : "left-0.5")} />
                  </button>
                </div>

                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Max Submissions (per user)</Label>
                  <Input
                    value={settings.maxSubmissions}
                    onChange={e => setSettings(s => ({ ...s, maxSubmissions: e.target.value }))}
                    className="font-mono text-xs h-9 bg-input"
                    placeholder="Unlimited"
                    type="number" min="1"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Tab nav footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border/40">
          <div className="flex gap-1">
            {CREATE_TABS.map((t, i) => (
              <button
                key={t.id}
                onClick={() => setCreateTab(t.id)}
                className={cn(
                  "w-1.5 h-1.5 rounded-full transition-all",
                  createTab === t.id ? "bg-primary" : "bg-muted-foreground/30"
                )}
                aria-label={t.label}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="font-mono text-xs">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="font-mono text-xs gap-2">
              {isEdit ? <><Pencil className="w-3 h-3" />{saving ? "Saving..." : "Save Changes"}</> : <><Plus className="w-3 h-3" />{saving ? "Creating..." : "Create Task"}</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
