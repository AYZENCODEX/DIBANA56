import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { BarChart, Bar, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useGetProject, useListVaultEntries } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft, ExternalLink, UserPlus, Hash, CheckCircle2, Clock, Twitter,
  MessageCircle, Wallet, Trash2, ChevronRight, ChevronDown, Zap, Link2, Plus,
  LayoutDashboard, ListTodo, Users, Settings, DollarSign, TrendingUp,
  TrendingDown, AlertCircle, Shield, Copy, Check, Edit3, Globe, Star, X,
  Send, Loader2, Info, BookOpen, Settings2, IdCard, Sparkles,
} from "lucide-react";
import confetti from "canvas-confetti";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { ReceiptLinkDialog } from "@/components/receipt-link-dialog";
import { projectPnlReceiptApi } from "@/lib/receipt-api";
import { TaskCategoryBadge } from "@/components/ui/task-category-badge";
import { ProjectBadgeList } from "@/components/project/project-badge-list";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { EnrollDialog } from "@/pages/user/project-entities";
import { KycEntityEnrollDialog } from "@/components/vault/kyc-entity-enroll-dialog";
import { getMetaByTypeKey } from "@/config/projects";
import { CountdownTimer } from "@/components/ui/countdown-timer";
import { COST_CATEGORIES, PROFIT_CATEGORIES } from "@/config/tasks";
import type { TutorialStep } from "@/components/schema/SchemaForm";
import { DataActivityHeatmap as ActivityHeatmap } from "@/components/data-activity-heatmap";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface CostEntry { id: string; type: "cost" | "profit"; category: string; label: string; amount: string; }
function newCostEntry(type: "cost" | "profit"): CostEntry {
  return { id: Math.random().toString(36).slice(2), type, category: "", label: "", amount: "" };
}
type SubmitTab = "guide" | "details" | "cost-roi" | "points" | "settings";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Task {
  id: number; name: string; description?: string;
  rewardAmount?: number; verificationType: string; taskType: string;
  cost: number; profit: number; completionCount: number;
  userStatus?: string | null;
  taskCategory?: string; category?: string;
  deadline?: string | null; timeLimitMinutes?: number | null;
  steps?: { title: string; description?: string }[];
  xpAmount?: number | null;
  projectName?: string | null;
  taskLink?: string | null;
}

interface EntityTaskStatus {
  taskId: number; taskName: string; taskType: string;
  rewardAmount?: number; cost: number; profit: number;
  status: string | null;
}

interface EntityWithTasks {
  enrollmentId: number; vaultEntryId: number;
  entitySerial?: string; entityName?: string;
  category?: string; email?: string;
  twitterUsername?: string; discordUsername?: string;
  status: string; tasks: EntityTaskStatus[];
  completedTasks: number; totalTasks: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { copyText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground/60 hover:text-primary transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      <span className={copied ? "text-emerald-400" : ""}>{value}</span>
    </button>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-[9px] font-mono text-muted-foreground/40 uppercase">—</span>;
  const cfg: Record<string, string> = {
    approved: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5",
    completed: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5",
    pending: "text-yellow-400 border-yellow-400/30 bg-yellow-400/5",
    rejected: "text-red-400 border-red-400/30 bg-red-400/5",
  };
  return (
    <Badge variant="outline" className={cn("text-[9px] font-mono", cfg[status] ?? "")}>
      {status}
    </Badge>
  );
}

// ─── Task Submit Dialog ───────────────────────────────────────────────────────
function TaskSubmitDialog({
  task, projectId, onDone, token,
}: {
  task: Task; projectId: number; onDone: () => void; token: string;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { data: vaultData } = useListVaultEntries();
  const vaultEntries = Array.isArray(vaultData) ? vaultData : [];

  const isDone = task.userStatus === "approved" || task.userStatus === "completed" || task.userStatus === "pending";

  const steps: { title: string; description?: string }[] = Array.isArray(task.steps) ? task.steps : [];
  const hasSteps = steps.length > 0;

  const [activeTab, setActiveTab] = useState<SubmitTab>(hasSteps ? "guide" : "details");
  const [proofUrl, setProofUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [costEntries, setCostEntries] = useState<CostEntry[]>([]);
  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(new Set());
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const totalCost = costEntries.filter(e => e.type === "cost").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalProfit = costEntries.filter(e => e.type === "profit").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const roi = totalCost > 0 && totalProfit > 0
    ? (((totalProfit - totalCost) / totalCost) * 100).toFixed(1) : null;

  const addEntry = (type: "cost" | "profit") => setCostEntries(e => [...e, newCostEntry(type)]);
  const removeEntry = (id: string) => setCostEntries(e => e.filter(x => x.id !== id));
  const updateEntry = (id: string, patch: Partial<CostEntry>) =>
    setCostEntries(e => e.map(x => x.id === id ? { ...x, ...patch } : x));

  const toggleStep = (i: number) => setCheckedSteps(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const toggleEntity = (id: number) => setSelectedEntityIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const resetState = () => {
    setProofUrl(""); setNotes(""); setCostEntries([]);
    setCheckedSteps(new Set()); setSelectedEntityIds(new Set());
    setActiveTab(hasSteps ? "guide" : "details");
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/tasks/${task.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          proofUrl: proofUrl.trim() || undefined,
          notes: notes.trim() || undefined,
          costEntries: costEntries.length > 0
            ? costEntries.map(({ id: _id, ...rest }) => ({ ...rest, amount: Number(rest.amount) || 0 }))
            : undefined,
          entityIds: selectedEntityIds.size > 0 ? [...selectedEntityIds] : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.status === "approved") {
          toast({ title: "✅ Auto-verified!", description: `Reward credited for "${task.name}"` });
          confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors: ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24"] });
        } else {
          toast({ title: "📨 Submitted for review", description: "Admin will verify shortly." });
          confetti({ particleCount: 60, spread: 50, origin: { y: 0.6 }, colors: ["#22d3ee", "#a78bfa"] });
        }
        setOpen(false); resetState(); onDone();
      } else {
        toast({ variant: "destructive", title: data.error ?? "Submission failed" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setLoading(false);
  };

  const TABS: { id: SubmitTab; label: string; icon: React.ElementType }[] = [
    ...(hasSteps ? [{ id: "guide" as SubmitTab, label: "Guide", icon: BookOpen }] : []),
    { id: "details",  label: "Details",   icon: Info },
    { id: "cost-roi", label: "Cost/ROI",  icon: DollarSign },
    { id: "points",   label: "Points",    icon: Star },
    { id: "settings", label: "Settings",  icon: Settings2 },
  ];

  return (
    <>
      {/* Trigger row */}
      <button
        onClick={() => { if (!isDone) { setOpen(true); } }}
        className="flex-1 flex items-center justify-between px-4 py-3 hover:bg-muted/10 transition-colors text-left group"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn("flex-shrink-0", isDone ? "text-emerald-400" : "text-muted-foreground/40")}>
            {isDone ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-medium truncate">{task.name}</span>
              <TaskCategoryBadge category={task.taskCategory ?? task.category ?? "B1"} />
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[9px] font-mono text-muted-foreground/50 uppercase">{task.taskType} · {task.verificationType}</span>
              {task.rewardAmount ? <span className="text-[9px] font-mono text-primary font-bold">${task.rewardAmount}</span> : null}
              {task.cost > 0 && <span className="text-[9px] font-mono text-red-400">Cost: ${task.cost}</span>}
              {task.profit > 0 && <span className="text-[9px] font-mono text-emerald-400">Profit: ${task.profit}</span>}
            </div>
            {task.deadline && <CountdownTimer deadline={task.deadline} compact className="mt-1" />}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={task.userStatus ?? null} />
          {!isDone && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />}
        </div>
      </button>

      {/* Full multilayer modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-card border border-card-border rounded-xl w-full max-w-lg shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent" />

            {/* Header */}
            <div className="px-5 pt-5 pb-0">
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Send className="w-4 h-4 text-primary" />
                  <span className="font-mono text-xs uppercase tracking-widest text-primary font-bold">Execute Task</span>
                </div>
                <button onClick={() => { setOpen(false); resetState(); }} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="font-mono font-semibold text-foreground text-sm mt-1.5">{task.name}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <Badge variant="outline" className="font-mono text-[10px] uppercase border-primary/30 text-primary/80">{task.taskType}</Badge>
                {task.taskCategory && <Badge variant="outline" className="font-mono text-[10px] uppercase border-violet-400/30 text-violet-400">{task.taskCategory}</Badge>}
                <Badge variant="outline" className="font-mono text-[10px] border-muted-foreground/30 text-muted-foreground">
                  {task.verificationType === "auto" ? "⚡ Auto" : "👤 Manual"}
                </Badge>
                {hasSteps && (
                  <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">
                    {checkedSteps.size}/{steps.length} steps
                  </Badge>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border mt-4 px-5 overflow-x-auto">
              {TABS.map(t => {
                const Icon = t.icon;
                return (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2.5 text-[10px] font-mono uppercase tracking-wider border-b-2 transition-all -mb-px whitespace-nowrap",
                      activeTab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="w-3 h-3" />{t.label}
                  </button>
                );
              })}
            </div>

            {/* Tab content */}
            <div className="p-5 space-y-4 min-h-[200px] max-h-[55vh] overflow-y-auto">

              {/* Guide */}
              {activeTab === "guide" && (
                <>
                  <p className="text-[11px] font-mono text-muted-foreground">Follow these steps. Check each one off as you complete it.</p>
                  {steps.map((step, i) => {
                    const done = checkedSteps.has(i);
                    return (
                      <button key={i} type="button" onClick={() => toggleStep(i)}
                        className={cn("w-full text-left rounded-lg border p-3 transition-all", done ? "bg-emerald-500/5 border-emerald-500/30" : "bg-muted/20 border-border/40 hover:border-primary/30")}
                      >
                        <div className="flex items-start gap-3">
                          <div className={cn("mt-0.5 w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-all", done ? "bg-emerald-500 border-emerald-500" : "border-border/60")}>
                            {done && <span className="text-white text-[9px] font-bold">✓</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={cn("font-mono text-xs font-bold", done && "line-through text-muted-foreground")}>Step {i + 1}: {step.title}</div>
                            {step.description && <div className="font-mono text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">{step.description}</div>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {checkedSteps.size === steps.length && steps.length > 0 && (
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-4 py-3 text-center font-mono text-xs text-emerald-400">
                      ✅ All steps done! Go to Details to submit.
                    </div>
                  )}
                </>
              )}

              {/* Details */}
              {activeTab === "details" && (
                <>
                  {task.description && <p className="text-[11px] font-mono text-muted-foreground bg-muted/20 rounded px-3 py-2">{task.description}</p>}
                  <div>
                    <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 block">Proof URL / TX Hash — optional</label>
                    <Input placeholder="https://... or 0x..." value={proofUrl} onChange={e => setProofUrl(e.target.value)} className="font-mono text-xs h-10 bg-input border-border" />
                  </div>
                  <div>
                    <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 block">Notes — optional</label>
                    <Textarea placeholder="Notes for the reviewer..." value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="font-mono text-xs bg-input border-border resize-none" />
                  </div>
                  {vaultEntries.length > 0 && (
                    <div>
                      <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 block">Select Entities — optional</label>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {vaultEntries.map((entry: any) => {
                          const serial = `AYZNA-${String(entry.id).padStart(4, "0")}`;
                          const sel = selectedEntityIds.has(entry.id);
                          return (
                            <button key={entry.id} type="button" onClick={() => toggleEntity(entry.id)}
                              className={cn("w-full flex items-center gap-2.5 px-3 py-2 rounded border text-left transition-all", sel ? "bg-primary/10 border-primary/40 text-primary" : "bg-muted/20 border-border/40 text-muted-foreground hover:border-border")}
                            >
                              <div className={cn("w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center", sel ? "bg-primary border-primary" : "border-border/60")}>
                                {sel && <span className="text-primary-foreground text-[8px] font-bold">✓</span>}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-[11px] font-medium truncate">{entry.projectName || serial}</div>
                                <div className="font-mono text-[9px] text-muted-foreground/60 truncate">{serial} · {entry.category ?? "General"}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Cost/ROI */}
              {activeTab === "cost-roi" && (
                <>
                  <p className="text-[11px] font-mono text-muted-foreground">Track your spending and earnings for this task.</p>

                  {/* Cost */}
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-red-400 font-bold">Costs {totalCost > 0 && `(${totalCost.toFixed(2)})`}</span>
                      <button type="button" onClick={() => addEntry("cost")} className="flex items-center gap-1 font-mono text-[10px] text-red-400 border border-red-500/30 rounded px-2 py-1 hover:border-red-400/50 transition-all">
                        <Plus className="w-3 h-3" /> Add
                      </button>
                    </div>
                    {costEntries.filter(e => e.type === "cost").length === 0
                      ? <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-1">No cost entries yet</p>
                      : costEntries.filter(e => e.type === "cost").map(entry => (
                        <div key={entry.id} className="space-y-2 p-2 rounded bg-black/20 border border-red-500/10">
                          <div className="flex flex-wrap gap-1">
                            {COST_CATEGORIES.map(cat => (
                              <button key={cat} type="button" onClick={() => updateEntry(entry.id, { category: cat })}
                                className={cn("px-2 py-0.5 rounded-full font-mono text-[9px] border transition-all", entry.category === cat ? "bg-red-500/20 border-red-500/50 text-red-400 font-bold" : "border-border/40 text-muted-foreground/60 hover:border-red-500/30")}
                              >{cat}</button>
                            ))}
                          </div>
                          {entry.category === "Manual" && (
                            <Input placeholder="Custom name..." value={entry.label} onChange={e => updateEntry(entry.id, { label: e.target.value })} className="font-mono text-[10px] h-7 bg-input border-border" />
                          )}
                          <div className="flex gap-2 items-center">
                            <div className="relative flex-1">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-[10px]">$</span>
                              <Input type="text" inputMode="decimal" placeholder="0.00" value={entry.amount} onChange={e => updateEntry(entry.id, { amount: e.target.value })} className="font-mono text-[10px] h-7 bg-input border-border pl-5" />
                            </div>
                            <button onClick={() => removeEntry(entry.id)} className="text-muted-foreground/40 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      ))
                    }
                  </div>

                  {/* Profit */}
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-emerald-400 font-bold">Profit {totalProfit > 0 && `(${totalProfit.toFixed(2)})`}</span>
                      <button type="button" onClick={() => addEntry("profit")} className="flex items-center gap-1 font-mono text-[10px] text-emerald-400 border border-emerald-500/30 rounded px-2 py-1 hover:border-emerald-400/50 transition-all">
                        <Plus className="w-3 h-3" /> Add
                      </button>
                    </div>
                    {costEntries.filter(e => e.type === "profit").length === 0
                      ? <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-1">No profit entries yet</p>
                      : costEntries.filter(e => e.type === "profit").map(entry => (
                        <div key={entry.id} className="space-y-2 p-2 rounded bg-black/20 border border-emerald-500/10">
                          <div className="flex flex-wrap gap-1">
                            {PROFIT_CATEGORIES.map(cat => (
                              <button key={cat} type="button" onClick={() => updateEntry(entry.id, { category: cat })}
                                className={cn("px-2 py-0.5 rounded-full font-mono text-[9px] border transition-all", entry.category === cat ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400 font-bold" : "border-border/40 text-muted-foreground/60 hover:border-emerald-500/30")}
                              >{cat}</button>
                            ))}
                          </div>
                          {entry.category === "Manual" && (
                            <Input placeholder="Custom name..." value={entry.label} onChange={e => updateEntry(entry.id, { label: e.target.value })} className="font-mono text-[10px] h-7 bg-input border-border" />
                          )}
                          <div className="flex gap-2 items-center">
                            <div className="relative flex-1">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-[10px]">$</span>
                              <Input type="text" inputMode="decimal" placeholder="0.00" value={entry.amount} onChange={e => updateEntry(entry.id, { amount: e.target.value })} className="font-mono text-[10px] h-7 bg-input border-border pl-5" />
                            </div>
                            <button onClick={() => removeEntry(entry.id)} className="text-muted-foreground/40 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      ))
                    }
                  </div>

                  {/* ROI calc */}
                  <div className={cn("rounded-lg border p-4 text-center transition-all", roi ? (Number(roi) >= 0 ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5") : "border-border bg-muted/20")}>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">ROI</div>
                    <div className={cn("font-mono text-3xl font-bold", roi ? (Number(roi) >= 0 ? "text-emerald-400" : "text-red-400") : "text-muted-foreground/40")}>
                      {roi ? `${Number(roi) >= 0 ? "+" : ""}${roi}%` : "—"}
                    </div>
                    {totalCost > 0 && totalProfit > 0 && <div className="font-mono text-[10px] text-muted-foreground mt-1">Net: ${(totalProfit - totalCost).toFixed(2)}</div>}
                  </div>
                </>
              )}

              {/* Points */}
              {activeTab === "points" && (
                <>
                  <p className="text-[11px] font-mono text-muted-foreground">Rewards you'll earn upon successful verification.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">XP Points</div>
                      <div className="font-mono text-2xl font-bold text-primary">{task.xpAmount ? `+${task.xpAmount}` : "—"}</div>
                    </div>
                    <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 text-center">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Reward</div>
                      <div className="font-mono text-2xl font-bold text-amber-400">{task.rewardAmount ? `${task.rewardAmount}` : "—"}</div>
                    </div>
                  </div>
                  <div className="bg-muted/20 border border-border rounded-lg divide-y divide-border">
                    {[
                      { label: "Type", value: task.taskType },
                      { label: "Verification", value: task.verificationType === "auto" ? "⚡ Automatic" : "👤 Manual review" },
                      { label: "Category", value: task.taskCategory ?? task.category ?? "General" },
                    ].map(row => (
                      <div key={row.label} className="flex justify-between items-center px-4 py-2.5">
                        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">{row.label}</span>
                        <span className="font-mono text-[10px] text-foreground">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Settings */}
              {activeTab === "settings" && (
                <>
                  <p className="text-[11px] font-mono text-muted-foreground">Task configuration set by the admin.</p>
                  <div className="bg-muted/20 border border-border rounded-lg divide-y divide-border">
                    {[
                      { label: "Task ID", value: `#${task.id}` },
                      { label: "Project", value: task.projectName ?? "General" },
                      { label: "Type", value: task.taskType },
                      { label: "Verification", value: task.verificationType === "auto" ? "Automatic" : "Manual review" },
                      { label: "Steps", value: hasSteps ? `${steps.length} steps` : "Not configured" },
                      { label: "Deadline", value: task.deadline ? new Date(task.deadline).toLocaleDateString() : "None" },
                    ].map(row => (
                      <div key={row.label} className="flex justify-between items-center px-4 py-2.5">
                        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">{row.label}</span>
                        <span className="font-mono text-[10px] text-foreground">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-border px-5 py-4 flex gap-3">
              <Button variant="outline" className="flex-1 font-mono text-xs h-10" onClick={() => { setOpen(false); resetState(); }} disabled={loading}>
                Cancel
              </Button>
              <Button className="flex-1 font-mono text-xs h-10 gap-2" onClick={handleSubmit} disabled={loading || isDone}>
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {loading ? "Submitting…" : "Submit Task"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Create Task Dialog ───────────────────────────────────────────────────────
// Uses the same rich, tabbed task-creation UI as the Task sidebar
// (admin/tasks.tsx), locked to this project so it always creates the task
// here instead of showing a project picker.
function CreateTaskDialog({
  projectId, projectName, xpName, xpPrice, onCreated,
}: {
  projectId: number; projectName?: string; xpName?: string | null; xpPrice?: number; onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" className="font-mono text-[10px] uppercase tracking-wider gap-1.5 h-8" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" /> Add Task
      </Button>
      <TaskFormDialog
        open={open}
        onClose={() => setOpen(false)}
        editTask={null}
        projects={[{ id: projectId, name: projectName ?? `Project #${projectId}`, xpName, xpPrice }]}
        lockedProjectId={projectId}
        onSaved={onCreated}
      />
    </>
  );
}

// ─── Tutorial Steps (consumer render) ──────────────────────────────────────────
// Phase 7-era numbered checklist, extended in Phase 8B: a step whose "full step
// details" toggle was enabled at authoring time (Phase 8A) gets an expand/
// collapse control revealing the extra content (long text/images/sub-steps).
// Steps left off render exactly as before — same markup, no control shown.
function parseTutorialSteps(raw: unknown): TutorialStep[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed.filter((s: any) => s && s.title);
  } catch { /* ignore malformed data */ }
  return [];
}

function TutorialStepsCard({ rawSteps }: { rawSteps: unknown }) {
  const steps = parseTutorialSteps(rawSteps);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  if (steps.length === 0) return null;

  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-violet-400" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary/60">Tutorial Steps</span>
      </div>
      <div className="space-y-2">
        {steps.map((step, i) => {
          const showFullDetails = !!step.fullDetailsEnabled;
          const isOpen = showFullDetails && expanded.has(i);
          const fd = step.fullDetails;
          const hasText = !!fd?.text?.trim();
          const hasImages = !!fd?.images && fd.images.length > 0;
          const hasSubSteps = !!fd?.subSteps && fd.subSteps.length > 0;

          return (
            <div key={i} className="rounded-lg bg-muted/10 border border-border/30 overflow-hidden">
              <div className="flex gap-3 p-2.5">
                <div className="w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="font-mono text-[9px] font-bold text-violet-300">{i + 1}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-mono text-xs font-bold text-foreground">{step.title}</p>
                    {showFullDetails && (
                      <button
                        type="button"
                        onClick={() => toggle(i)}
                        className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-violet-400 hover:text-violet-200 transition-colors flex-shrink-0 mt-0.5"
                      >
                        {isOpen ? "Hide" : "Full"} details
                        <ChevronDown className={cn("w-3 h-3 transition-transform", isOpen && "rotate-180")} />
                      </button>
                    )}
                  </div>
                  {step.description && (
                    <p className="font-mono text-[11px] text-muted-foreground mt-0.5 whitespace-pre-wrap">{step.description}</p>
                  )}
                  {step.link && (
                    <a href={step.link} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-violet-400 hover:text-violet-200 transition-colors mt-1">
                      <Link2 className="w-2.5 h-2.5" /> {step.link}
                    </a>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-border/20 bg-violet-500/5 px-2.5 py-3 ml-8 space-y-3">
                  {hasText && (
                    <p className="font-mono text-[11px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                      {fd!.text}
                    </p>
                  )}
                  {hasImages && (
                    <div className="flex flex-wrap gap-1.5">
                      {fd!.images!.map((src, imgIdx) => (
                        <img
                          key={imgIdx}
                          src={src}
                          alt={`${step.title} — detail ${imgIdx + 1}`}
                          className="w-20 h-20 rounded-lg object-cover border border-border/40"
                        />
                      ))}
                    </div>
                  )}
                  {hasSubSteps && (
                    <div className="space-y-1.5">
                      {fd!.subSteps!.map((sub, subIdx) => (
                        <div key={subIdx} className="flex gap-2">
                          <span className="font-mono text-[9px] text-violet-400/60 flex-shrink-0 mt-0.5">{i + 1}.{subIdx + 1}</span>
                          <div className="min-w-0">
                            <p className="font-mono text-[11px] font-bold text-foreground/90">{sub.title}</p>
                            {sub.description && (
                              <p className="font-mono text-[10px] text-muted-foreground mt-0.5 whitespace-pre-wrap">{sub.description}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {!hasText && !hasImages && !hasSubSteps && (
                    <p className="font-mono text-[10px] text-muted-foreground/40">No additional details added yet.</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function UserProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"dashboard" | "tasks" | "entities" | "settings">("dashboard");

  const { data: project, isLoading, refetch: refetchProject } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: ["project", projectId] },
  });
  const { data: vaultEntries } = useListVaultEntries();

  // ── SSE live refresh for this project ──────────────────────────────────────
  const sseRef = useRef<EventSource | null>(null);
  const sseRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseRetries = useRef(0);

  useEffect(() => {
    if (!projectId) return;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      const tok = localStorage.getItem("ayzen_token") ?? "";
      const url = `${BASE}/api/events?projectId=${projectId}&token=${encodeURIComponent(tok)}`;
      const es = new EventSource(url);
      sseRef.current = es;

      const refresh = () => { refetchProject(); };
      const refreshEntity = () => { if (activeTab === "entities") loadEntityData(); };

      es.addEventListener("tasks_updated", refresh);
      es.addEventListener("submissions_updated", () => { refresh(); refreshEntity(); });
      es.addEventListener("projects_updated", refresh);
      es.addEventListener("presence_updated", () => {}); // handled by presence bar if needed

      es.onerror = () => {
        es.close();
        sseRef.current = null;
        if (unmounted) return;
        const delay = Math.min(1000 * Math.pow(2, sseRetries.current++), 30_000);
        sseRetry.current = setTimeout(connect, delay);
      };

      es.addEventListener("connected", () => { sseRetries.current = 0; });
    };

    connect();

    return () => {
      unmounted = true;
      if (sseRetry.current) clearTimeout(sseRetry.current);
      sseRef.current?.close();
      sseRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const token = localStorage.getItem("ayzen_token") || "";
  const xpName = (project as any)?.xpName;
  const tasks: Task[] = (project as any)?.tasks ?? [];

  // Enrollments
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [kycEnrollOpen, setKycEnrollOpen] = useState(false);
  const [loadingEnroll, setLoadingEnroll] = useState<number | null>(null);

  // Exchange enroll shortcut — Binance/Bitget/Kucoin/Bybit projects can be
  // enrolled straight from a matching-platform KYC Entity (no form); the
  // top-level "Other" exchange node (subcategory === category) and every
  // non-Exchange category stay manual-only. See kyc-entity-enroll-dialog.tsx.
  const projectMeta = getMetaByTypeKey((project as any)?.projectType);
  const exchangePlatform = projectMeta?.category === "Exchange" && projectMeta.subcategory !== "Exchange"
    ? projectMeta.subcategory
    : null;
  const showDataEntity = projectMeta?.category === "Exchange";

  // Entity tasks (for Entities tab)
  const [entityData, setEntityData] = useState<{ tasks: any[]; entities: EntityWithTasks[] } | null>(null);
  const [loadingEntityData, setLoadingEntityData] = useState(false);

  // ROI attribution — per-entity cost/profit/ROI% for THIS project, derived from the
  // same approved/completed task submissions the Entities tab already shows (mirrors
  // the entity-leaderboard pattern, scoped to one project instead of all projects).
  // ROI% is undefined (excluded from the chart) when cost is 0 — same convention as
  // computeEntityProfitPct in lib/entity-worth.ts.
  const entityRoiRows = useMemo(() => {
    const entities = entityData?.entities ?? [];
    return entities.map(entity => {
      const totalProfit = entity.tasks.reduce((s, t) => s + (t.status === "approved" || t.status === "completed" ? t.profit : 0), 0);
      const totalCost = entity.tasks.reduce((s, t) => s + (t.status === "approved" || t.status === "completed" ? t.cost : 0), 0);
      const roiPct = totalCost > 0 ? ((totalProfit - totalCost) / totalCost) * 100 : null;
      return {
        vaultEntryId: entity.vaultEntryId,
        name: entity.entitySerial || entity.entityName || `#${entity.vaultEntryId}`,
        totalCost, totalProfit,
        net: totalProfit - totalCost,
        roiPct,
      };
    });
  }, [entityData]);

  const entityRoiChartData = useMemo(() => (
    [...entityRoiRows]
      .filter(r => r.roiPct !== null)
      .sort((a, b) => (b.roiPct as number) - (a.roiPct as number))
      .map(r => ({ name: r.name, roi: Number((r.roiPct as number).toFixed(1)), net: r.net }))
  ), [entityRoiRows]);

  const roiAttributionSummary = useMemo(() => {
    const totalCost = entityRoiRows.reduce((s, r) => s + r.totalCost, 0);
    const totalProfit = entityRoiRows.reduce((s, r) => s + r.totalProfit, 0);
    return { totalCost, totalProfit, net: totalProfit - totalCost };
  }, [entityRoiRows]);

  // Entity cross-project overview dialog
  const [entityOverviewOpen, setEntityOverviewOpen] = useState(false);
  const [entityOverviewTarget, setEntityOverviewTarget] = useState<EntityWithTasks | null>(null);
  const [entityOverview, setEntityOverview] = useState<any>(null);
  const [loadingEntityOverview, setLoadingEntityOverview] = useState(false);
  const [entityLeaderboard, setEntityLeaderboard] = useState<any[] | null>(null);

  const openEntityOverview = async (entity: EntityWithTasks) => {
    setEntityOverviewTarget(entity);
    setEntityOverviewOpen(true);
    setEntityOverview(null);
    setEntityLeaderboard(null);
    setLoadingEntityOverview(true);
    try {
      const [overviewRes, lbRes] = await Promise.all([
        fetch(`${BASE}/api/projects/entity/${entity.vaultEntryId}/overview`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${BASE}/api/projects/entity-leaderboard`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (overviewRes.ok) setEntityOverview(await overviewRes.json());
      if (lbRes.ok) setEntityLeaderboard(await lbRes.json());
    } catch {} finally { setLoadingEntityOverview(false); }
  };

  // Settings form
  const [settingsForm, setSettingsForm] = useState<any>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const loadEnrollments = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}/enrollments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setEnrollments(await res.json());
    } catch {}
  }, [projectId, token]);

  const loadEntityData = useCallback(async () => {
    setLoadingEntityData(true);
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}/entity-tasks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setEntityData(await res.json());
    } catch {} finally { setLoadingEntityData(false); }
  }, [projectId, token]);

  useEffect(() => { loadEnrollments(); }, [loadEnrollments]);

  useEffect(() => {
    if (activeTab === "entities") loadEntityData();
  }, [activeTab, loadEntityData]);

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
      });
    }
  }, [project, settingsForm]);

  const handleEnroll = async (vaultEntryId: number) => {
    setLoadingEnroll(vaultEntryId);
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vaultEntryId }),
      });
      const data = await res.json();
      if (!res.ok) { toast({ variant: "destructive", title: data.error || "Enrollment failed" }); return; }
      toast({ title: "Entity enrolled!" });
      await loadEnrollments();
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    finally { setLoadingEnroll(null); }
  };

  const handleUnenroll = async (enrollmentId: number) => {
    try {
      await fetch(`${BASE}/api/projects/${projectId}/enrollments/${enrollmentId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      setEnrollments(e => e.filter(x => x.id !== enrollmentId));
      toast({ title: "Entity removed from project" });
    } catch { toast({ variant: "destructive", title: "Failed to remove" }); }
  };

  const handleSaveSettings = async () => {
    if (!settingsForm) return;
    setSavingSettings(true);
    try {
      const res = await fetch(`${BASE}/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(settingsForm),
      });
      if (!res.ok) { toast({ variant: "destructive", title: "Save failed" }); return; }
      toast({ title: "Project settings saved!" });
      refetchProject();
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    finally { setSavingSettings(false); }
  };

  const handleDeleteProject = async () => {
    setDeletingProject(true);
    try {
      await fetch(`${BASE}/api/projects/${projectId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      toast({ title: "Project deleted" });
      window.location.href = `${BASE}/projects`;
    } catch { toast({ variant: "destructive", title: "Delete failed" }); }
    finally { setDeletingProject(false); setDeleteConfirmOpen(false); }
  };

  const enrolledIds = new Set(enrollments.map((e: any) => e.vaultEntryId));
  const completedTasks = tasks.filter(t => t.userStatus === "approved" || t.userStatus === "completed").length;
  const progress = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;

  const TABS = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "tasks", label: "Tasks", icon: ListTodo },
    { id: "entities", label: "Entities", icon: Users },
    { id: "settings", label: "Settings", icon: Settings },
  ] as const;

  if (isLoading) return (
    <div className="space-y-6 page-enter">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-32 w-full" />
    </div>
  );

  if (!project) return (
    <div className="py-20 text-center font-mono text-muted-foreground">
      Project not found.{" "}
      <Link href="/projects" className="text-primary hover:underline">Back to projects</Link>
    </div>
  );

  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setSettingsForm((p: any) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="space-y-4 page-enter">
      {/* ── Banner ── */}
      {(project as any).bannerUrl && (
        <div className="rounded-xl overflow-hidden border border-card-border h-32 sm:h-40">
          <img src={(project as any).bannerUrl} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        <Link href="/projects">
          <Button variant="ghost" size="icon" className="h-8 w-8 mt-0.5 flex-shrink-0"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        {(project as any).thumbnailUrl && (
          <img src={(project as any).thumbnailUrl} alt="" className="w-9 h-9 rounded-lg object-cover border border-card-border flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold font-mono tracking-tighter uppercase truncate">
              {(project as any).name}
            </h1>
            {xpName && (
              <Badge variant="outline" className="font-mono text-[10px] border-yellow-500/30 text-yellow-400 bg-yellow-400/5 flex items-center gap-1 flex-shrink-0">
                <Zap className="w-2.5 h-2.5" />{xpName}
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-[9px] border-primary/20 text-primary/60 flex-shrink-0">
              T{(project as any).tier}
            </Badge>
            {/* Phase 7B — badges/tags (7A data) */}
            <ProjectBadgeList badges={(project as any).badges} />
          </div>
          {/* Project ID */}
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <CopyId value={`#PRJ-${String(projectId).padStart(4, "0")}`} />
            <span className="text-[10px] font-mono text-muted-foreground/40">·</span>
            <span className="text-[10px] font-mono text-muted-foreground/50">{enrollments.length} entit{enrollments.length !== 1 ? "ies" : "y"} enrolled</span>
            {tasks.length > 0 && (
              <>
                <span className="text-[10px] font-mono text-muted-foreground/40">·</span>
                <span className="text-[10px] font-mono text-primary/60 font-bold">{completedTasks}/{tasks.length} tasks done</span>
              </>
            )}
          </div>
        </div>
        {exchangePlatform ? (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button
              onClick={() => setKycEnrollOpen(true)}
              className="font-mono text-xs gap-1.5 uppercase" size="sm"
            >
              <IdCard className="w-3.5 h-3.5" /> KYC Entity
            </Button>
            <Button
              onClick={() => setEnrollOpen(true)}
              variant="outline"
              className="font-mono text-xs gap-1.5 uppercase" size="sm"
            >
              <UserPlus className="w-3.5 h-3.5" /> Manual
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => setEnrollOpen(true)}
            className="font-mono text-xs gap-2 uppercase flex-shrink-0" size="sm"
          >
            <UserPlus className="w-3.5 h-3.5" /> Enroll Entity
          </Button>
        )}
      </div>

      {/* ── Progress bar (always visible) ── */}
      {tasks.length > 0 && (
        <div className="bg-card border border-card-border rounded-xl px-4 py-3 flex items-center gap-4">
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Overall Progress</span>
              <span className="font-mono text-sm font-bold text-primary">{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
          <div className="text-right">
            <div className="font-mono text-xs font-bold">{completedTasks}/{tasks.length}</div>
            <div className="font-mono text-[9px] text-muted-foreground/50">tasks done</div>
          </div>
        </div>
      )}

      {/* ── Tab Nav ── */}
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

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ── TAB: DASHBOARD ── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "dashboard" && (
        <div className="space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Est. Reward", value: `$${(project as any).rewardEstimate?.toLocaleString() ?? 0}`, color: "text-primary" },
              { label: "Funding", value: `$${(project as any).fundingAmount?.toLocaleString() ?? 0}`, color: "text-muted-foreground" },
              { label: "Members", value: (project as any).activeUserCount ?? 0, color: "text-cyan-400" },
              { label: "Total Tasks", value: tasks.length, color: "text-purple-400" },
            ].map(s => (
              <div key={s.label} className="bg-card border border-card-border rounded-xl p-4">
                <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50 mb-1">{s.label}</div>
                <div className={cn("font-mono text-xl font-bold", s.color)}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Description */}
          <div className="bg-card border border-card-border rounded-xl p-4">
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary/60 mb-2">Protocol Intel</div>
            <p className="font-mono text-sm text-muted-foreground leading-relaxed">
              {(project as any).description || "No description available."}
            </p>
          </div>

          {/* Tutorial Link */}
          {(project as any).tutorialLink && (
            <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl p-4 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
                <Link2 className="w-4 h-4 text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-wider text-violet-400/70 mb-0.5">Tutorial / Guide</div>
                <a href={(project as any).tutorialLink} target="_blank" rel="noreferrer"
                  className="font-mono text-xs text-violet-300 hover:text-violet-100 transition-colors truncate block">
                  {(project as any).tutorialLink}
                </a>
              </div>
              <a href={(project as any).tutorialLink} target="_blank" rel="noreferrer"
                className="font-mono text-[10px] border border-violet-500/30 text-violet-400 hover:bg-violet-500/10 rounded px-2 py-1 transition-colors flex-shrink-0">
                Open →
              </a>
            </div>
          )}

          {/* Tutorial Steps — structured step-by-step walkthrough built by the admin.
              Phase 8B — steps with "full step details" enabled (Phase 8A) get a
              working expand/collapse control; steps without it render unchanged. */}
          <TutorialStepsCard rawSteps={(project as any).tutorialSteps} />

          {/* Links */}
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary/60 mb-2">Links</div>
            {(project as any).websiteUrl && (
              <a href={(project as any).websiteUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
                <Globe className="w-3.5 h-3.5" /> Website
              </a>
            )}
            {(project as any).twitterHandle && (
              <a href={`https://twitter.com/${(project as any).twitterHandle.replace("@", "")}`} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-sky-400 transition-colors">
                <Twitter className="w-3.5 h-3.5" /> {(project as any).twitterHandle}
              </a>
            )}
            {(project as any).discordUrl && (
              <a href={(project as any).discordUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-indigo-400 transition-colors">
                <MessageCircle className="w-3.5 h-3.5" /> Discord
              </a>
            )}
          </div>

          {/* Enrolled Entities mini-summary */}
          {enrollments.length > 0 && (
            <div className="bg-card border border-card-border rounded-xl p-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-primary/60 mb-3">Enrolled Entities</div>
              <div className="space-y-2">
                {enrollments.map((enr: any) => (
                  <div key={enr.id} className="flex items-center gap-3 p-2 bg-muted/10 rounded-md">
                    <Hash className="w-3.5 h-3.5 text-primary/40 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs font-bold text-primary truncate">{enr.entity?.entitySerial || `#${enr.vaultEntryId}`}</div>
                      <div className="font-mono text-[9px] text-muted-foreground/50 truncate">{enr.entity?.projectName}</div>
                    </div>
                    <Badge variant="outline" className="font-mono text-[8px] border-emerald-500/20 text-emerald-400">{enr.status}</Badge>
                    <button onClick={() => handleUnenroll(enr.id)} className="text-muted-foreground/30 hover:text-red-400 transition-colors">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ── TAB: TASKS ── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "tasks" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono font-bold text-sm">Tasks</div>
              <div className="font-mono text-[10px] text-muted-foreground/50">{tasks.length} task{tasks.length !== 1 ? "s" : ""} · {completedTasks} completed</div>
            </div>
            <CreateTaskDialog
              projectId={projectId}
              projectName={(project as any)?.name}
              xpName={xpName}
              xpPrice={(project as any)?.xpPrice}
              onCreated={() => refetchProject()}
            />
          </div>

          {tasks.length === 0 ? (
            <div className="py-16 flex flex-col items-center gap-4 border border-dashed border-primary/15 rounded-xl bg-primary/2">
              <ListTodo className="w-8 h-8 text-primary/20" />
              <div className="text-center">
                <div className="font-mono font-bold text-muted-foreground/50 text-sm">No tasks yet</div>
                <div className="font-mono text-[10px] text-muted-foreground/30 mt-0.5">Create the first task for this project</div>
              </div>
            </div>
          ) : (
            <div className="bg-card border border-card-border rounded-xl overflow-hidden divide-y divide-card-border">
              {tasks.map((task) => (
                <TaskSubmitDialog
                  key={task.id}
                  task={task}
                  projectId={projectId}
                  token={token}
                  onDone={() => refetchProject()}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ── TAB: ENTITIES ── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "entities" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono font-bold text-sm">Entity Progress</div>
              <div className="font-mono text-[10px] text-muted-foreground/50">Per-entity task completion status</div>
            </div>
            {exchangePlatform ? (
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={() => setKycEnrollOpen(true)} className="font-mono text-[10px] h-8 gap-1.5 uppercase">
                  <IdCard className="w-3 h-3" /> KYC Entity
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEnrollOpen(true)} className="font-mono text-[10px] h-8 gap-1.5 uppercase">
                  <UserPlus className="w-3 h-3" /> Manual
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEnrollOpen(true)} className="font-mono text-[10px] h-8 gap-1.5 uppercase">
                <UserPlus className="w-3 h-3" /> Enroll
              </Button>
            )}
          </div>

          {/* ROI Attribution — which entity is actually profitable in this project */}
          {!loadingEntityData && entityRoiChartData.length > 0 && (
            <div className="bg-card border border-card-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">ROI Attribution</div>
                  <div className="font-mono text-[9px] text-muted-foreground/30">Per-entity ROI% for this project</div>
                </div>
                <div className="flex items-center gap-3 font-mono text-[10px]">
                  {roiAttributionSummary.totalCost > 0 && <span className="text-red-400">-${roiAttributionSummary.totalCost.toFixed(2)}</span>}
                  {roiAttributionSummary.totalProfit > 0 && <span className="text-emerald-400">+${roiAttributionSummary.totalProfit.toFixed(2)}</span>}
                  <span className={cn("font-bold", roiAttributionSummary.net >= 0 ? "text-emerald-400" : "text-red-400")}>
                    Net: {roiAttributionSummary.net >= 0 ? "+" : ""}${roiAttributionSummary.net.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={entityRoiChartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 8, fontFamily: "monospace" }} interval={0} angle={-25} textAnchor="end" height={40} />
                    <YAxis tick={{ fontSize: 9, fontFamily: "monospace" }} width={36} tickFormatter={(v) => `${v}%`} />
                    <Bar dataKey="roi" radius={[3, 3, 0, 0]}>
                      {entityRoiChartData.map((d, i) => <Cell key={i} fill={d.roi >= 0 ? "#34d399" : "#f87171"} />)}
                    </Bar>
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 10, fontFamily: "monospace" }}
                      formatter={(value: any, _name: any, item: any) => [`${value}% (net $${item?.payload?.net?.toFixed(2) ?? "0.00"})`, "ROI"]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {entityRoiRows.some(r => r.roiPct === null) && (
                <div className="font-mono text-[9px] text-muted-foreground/30 mt-1">
                  {entityRoiRows.filter(r => r.roiPct === null).length} entit{entityRoiRows.filter(r => r.roiPct === null).length === 1 ? "y" : "ies"} with no recorded cost excluded (ROI% undefined)
                </div>
              )}
            </div>
          )}

          {loadingEntityData ? (
            <div className="space-y-3">{[1, 2].map(i => <div key={i} className="h-32 bg-card border border-card-border rounded-xl animate-pulse" />)}</div>
          ) : !entityData || entityData.entities.length === 0 ? (
            <div className="py-16 flex flex-col items-center gap-4 border border-dashed border-primary/15 rounded-xl bg-primary/2">
              <Users className="w-8 h-8 text-primary/20" />
              <div className="text-center">
                <div className="font-mono font-bold text-muted-foreground/50 text-sm">No entities enrolled</div>
                <div className="font-mono text-[10px] text-muted-foreground/30">Enroll vault entities to track per-account progress</div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {entityData.entities.map((entity) => {
                const prog = entity.totalTasks > 0 ? Math.round((entity.completedTasks / entity.totalTasks) * 100) : 0;
                const totalProfit = entity.tasks.reduce((s, t) => s + (t.status === "approved" || t.status === "completed" ? t.profit : 0), 0);
                const totalCost = entity.tasks.reduce((s, t) => s + (t.status === "approved" || t.status === "completed" ? t.cost : 0), 0);
                return (
                  <div key={entity.enrollmentId} className="bg-card border border-card-border rounded-xl overflow-hidden">
                    {/* Entity header */}
                    <div className="bg-gradient-to-r from-primary/8 to-transparent border-b border-card-border px-4 py-3">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <Shield className="w-3.5 h-3.5 text-primary/50" />
                          <div>
                            <div className="font-mono font-bold text-sm text-primary">{entity.entitySerial || `#${entity.vaultEntryId}`}</div>
                            <div className="font-mono text-[9px] text-muted-foreground/50">{entity.entityName} · {entity.category}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                          {totalCost > 0 && <div className="font-mono text-[10px] text-red-400">-${totalCost.toFixed(2)}</div>}
                          {totalProfit > 0 && <div className="font-mono text-[10px] text-emerald-400">+${totalProfit.toFixed(2)}</div>}
                          <div className="font-mono text-[10px] font-bold text-primary">{prog}%</div>
                          <Progress value={prog} className="w-16 h-1.5" />
                          <button
                            onClick={() => openEntityOverview(entity)}
                            className="font-mono text-[9px] px-2 py-0.5 rounded border border-primary/20 text-primary/60 hover:border-primary/50 hover:text-primary transition-all"
                            title="View cross-project overview"
                          >
                            Overview
                          </button>
                          <button onClick={() => handleUnenroll(entity.enrollmentId)} className="text-muted-foreground/30 hover:text-red-400 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Task list for this entity */}
                    {entity.totalTasks === 0 ? (
                      <div className="px-4 py-3 font-mono text-[10px] text-muted-foreground/40">No tasks in this project yet.</div>
                    ) : (
                      <div className="divide-y divide-border/20">
                        {entity.tasks.map((task) => {
                          const done = task.status === "approved" || task.status === "completed";
                          const pending = task.status === "pending";
                          return (
                            <div key={task.taskId} className="px-4 py-2.5 flex items-center gap-3">
                              <div className={cn("flex-shrink-0", done ? "text-emerald-400" : pending ? "text-yellow-400" : "text-muted-foreground/30")}>
                                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : pending ? <Clock className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-mono text-xs truncate">{task.taskName}</div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[9px] font-mono text-muted-foreground/40 uppercase">{task.taskType}</span>
                                  {task.cost > 0 && <span className="text-[9px] font-mono text-red-400/70">-${task.cost}</span>}
                                  {task.profit > 0 && <span className="text-[9px] font-mono text-emerald-400/70">+${task.profit}</span>}
                                </div>
                              </div>
                              <StatusBadge status={task.status} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ── TAB: SETTINGS ── */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "settings" && settingsForm && (
        <div className="space-y-4 max-w-xl">
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary/60 mb-1">Project Details</div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Name</Label>
              <Input value={settingsForm.name} onChange={sf("name")} className="font-mono text-xs h-9 bg-input" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Description</Label>
              <Textarea value={settingsForm.description} onChange={sf("description")} className="font-mono text-xs bg-input min-h-[80px] resize-none" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <Zap className="w-2.5 h-2.5 text-yellow-400" /> XP Token Name
              </Label>
              <Input value={settingsForm.xpName} onChange={sf("xpName")} className="font-mono text-xs h-9 bg-input" placeholder="e.g. POINTS, XP, $TOKEN" />
            </div>
          </div>

          <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary/60 mb-1">Links</div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1"><Globe className="w-2.5 h-2.5" /> Website</Label>
              <Input value={settingsForm.websiteUrl} onChange={sf("websiteUrl")} className="font-mono text-xs h-9 bg-input" placeholder="https://..." />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1"><Twitter className="w-2.5 h-2.5" /> Twitter</Label>
              <Input value={settingsForm.twitterHandle} onChange={sf("twitterHandle")} className="font-mono text-xs h-9 bg-input" placeholder="@handle" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1"><MessageCircle className="w-2.5 h-2.5" /> Discord</Label>
              <Input value={settingsForm.discordUrl} onChange={sf("discordUrl")} className="font-mono text-xs h-9 bg-input" placeholder="https://discord.gg/..." />
            </div>
          </div>

          <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary/60 mb-1">Protocol Params</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Tier</Label>
                <Select value={settingsForm.tier} onValueChange={v => setSettingsForm((p: any) => ({ ...p, tier: v }))}>
                  <SelectTrigger className="font-mono text-xs h-9 bg-input"><SelectValue /></SelectTrigger>
                  <SelectContent>{["1","2","3","4"].map(t => <SelectItem key={t} value={t} className="font-mono text-xs">Tier {t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Difficulty</Label>
                <Select value={settingsForm.experienceLevel} onValueChange={v => setSettingsForm((p: any) => ({ ...p, experienceLevel: v }))}>
                  <SelectTrigger className="font-mono text-xs h-9 bg-input"><SelectValue /></SelectTrigger>
                  <SelectContent>{["Beginner","Intermediate","Advanced"].map(l => <SelectItem key={l} value={l} className="font-mono text-xs">{l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Funding ($)</Label>
                <Input type="number" value={settingsForm.fundingAmount} onChange={sf("fundingAmount")} className="font-mono text-xs h-9 bg-input" />
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Est. Reward ($)</Label>
                <Input type="number" value={settingsForm.rewardEstimate} onChange={sf("rewardEstimate")} className="font-mono text-xs h-9 bg-input" />
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <Button onClick={handleSaveSettings} disabled={savingSettings} className="font-mono text-xs uppercase tracking-wider gap-2">
              {savingSettings ? "Saving..." : <><Edit3 className="w-3.5 h-3.5" /> Save Changes</>}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setDeleteConfirmOpen(true)}
              className="font-mono text-xs uppercase tracking-wider gap-2 ml-auto"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete Project
            </Button>
          </div>

          {/* Project ID display in settings */}
          <div className="bg-muted/20 border border-border/30 rounded-xl p-3">
            <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/40 mb-1">Project ID</div>
            <CopyId value={`#PRJ-${String(projectId).padStart(4, "0")} (DB ID: ${projectId})`} />
          </div>
        </div>
      )}

      {/* ── Enroll Entity Modal — full picker + Main/Info/Recovery form ── */}
      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        projectId={projectId}
        alreadyEnrolledIds={enrolledIds}
        onEnrolled={loadEnrollments}
        showDataEntity={showDataEntity}
      />

      {/* ── Exchange enroll shortcut — pick a matching-platform KYC entity, no form ── */}
      {exchangePlatform && (
        <KycEntityEnrollDialog
          open={kycEnrollOpen}
          onOpenChange={setKycEnrollOpen}
          projectId={projectId}
          platform={exchangePlatform}
          alreadyEnrolledIds={enrolledIds}
          onEnrolled={loadEnrollments}
        />
      )}

      {/* ── Entity Cross-Project Overview Dialog ── */}
      {entityOverviewOpen && entityOverviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setEntityOverviewOpen(false)}>
          <div className="bg-card border border-card-border rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent" />
            <div className="flex items-center justify-between px-4 py-3 border-b border-card-border shrink-0">
              <div>
                <div className="font-mono font-bold text-sm text-primary">{entityOverviewTarget.entitySerial ?? `Entity #${entityOverviewTarget.vaultEntryId}`}</div>
                <div className="font-mono text-[9px] text-muted-foreground/50 uppercase tracking-widest">All-Project Overview</div>
              </div>
              <button onClick={() => setEntityOverviewOpen(false)} className="text-muted-foreground/50 hover:text-foreground p-1 rounded hover:bg-muted/20 transition-all">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-4">
              {loadingEntityOverview ? (
                <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-muted/10 rounded-lg animate-pulse" />)}</div>
              ) : entityOverview ? (
                <>
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label: "Projects", value: entityOverview.summary.totalProjects, color: "text-primary" },
                      { label: "Profit",   value: `+$${entityOverview.summary.totalProfit.toFixed(2)}`,  color: "text-emerald-400" },
                      { label: "Cost",     value: `-$${entityOverview.summary.totalCost.toFixed(2)}`,    color: "text-red-400" },
                      { label: "Net ROI",  value: `${entityOverview.summary.totalRoi >= 0 ? "+" : ""}$${entityOverview.summary.totalRoi.toFixed(2)}`, color: entityOverview.summary.totalRoi >= 0 ? "text-emerald-400" : "text-red-400" },
                    ].map(card => (
                      <div key={card.label} className="bg-muted/10 border border-card-border rounded-lg p-3 text-center">
                        <div className={cn("font-mono text-lg font-bold", card.color)}>{card.value}</div>
                        <div className="font-mono text-[9px] text-muted-foreground/50 uppercase tracking-widest">{card.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Activity heatmap */}
                  {entityOverview.activity && (
                    <ActivityHeatmap activity={entityOverview.activity} />
                  )}

                  {/* Entity Leaderboard */}
                  {entityLeaderboard && entityLeaderboard.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">Entity Leaderboard</div>
                        <div className="font-mono text-[9px] text-muted-foreground/40">{entityLeaderboard.length} entities</div>
                      </div>
                      <div className="space-y-1">
                        {entityLeaderboard.map((e: any) => {
                          const isCurrent = e.vaultEntryId === entityOverviewTarget?.vaultEntryId;
                          const rank = e.rank as number;
                          const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
                          return (
                            <div
                              key={e.vaultEntryId}
                              className={cn(
                                "flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all",
                                isCurrent
                                  ? "border-primary/50 bg-primary/8 ring-1 ring-primary/20"
                                  : "border-card-border bg-muted/5 hover:bg-muted/10"
                              )}
                            >
                              {/* Rank */}
                              <div className="flex-shrink-0 w-7 text-center">
                                {medal
                                  ? <span className="text-base leading-none">{medal}</span>
                                  : <span className="font-mono text-[10px] text-muted-foreground/40">#{rank}</span>
                                }
                              </div>
                              {/* Entity info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-xs font-medium truncate">
                                    {e.entitySerial ?? `Entity #${e.vaultEntryId}`}
                                  </span>
                                  {isCurrent && (
                                    <span className="font-mono text-[8px] px-1 py-0.5 rounded bg-primary/15 text-primary border border-primary/20 flex-shrink-0">YOU</span>
                                  )}
                                </div>
                                <div className="font-mono text-[9px] text-muted-foreground/40">
                                  {e.totalProjects}p · {e.totalCompletions} tasks · {e.category ?? "–"}
                                </div>
                              </div>
                              {/* ROI bar */}
                              <div className="flex-shrink-0 text-right min-w-[52px]">
                                <div className={cn(
                                  "font-mono text-xs font-bold",
                                  e.totalRoi > 0 ? "text-emerald-400" : e.totalRoi < 0 ? "text-red-400" : "text-muted-foreground/40"
                                )}>
                                  {e.totalRoi >= 0 ? "+" : ""}${e.totalRoi.toFixed(2)}
                                </div>
                                {/* Mini ROI bar relative to #1 entity */}
                                {entityLeaderboard[0] && entityLeaderboard[0].totalRoi > 0 && (
                                  <div className="h-0.5 bg-muted/20 rounded-full mt-0.5 overflow-hidden">
                                    <div
                                      className={cn("h-full rounded-full", e.totalRoi > 0 ? "bg-emerald-400/70" : "bg-red-400/50")}
                                      style={{ width: `${Math.max(4, Math.min(100, (e.totalRoi / entityLeaderboard[0].totalRoi) * 100))}%` }}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Per-project breakdown */}
                  <div className="space-y-2">
                    <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">Project Breakdown</div>
                    {entityOverview.projects.length === 0 ? (
                      <div className="py-8 text-center font-mono text-sm text-muted-foreground/40">No projects enrolled yet</div>
                    ) : (
                      entityOverview.projects.map((proj: any) => (
                        <div key={proj.projectId} className="bg-card/50 border border-card-border rounded-lg p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="font-mono text-xs font-bold">{proj.projectName}</div>
                              <div className="font-mono text-[9px] text-muted-foreground/40 capitalize">{proj.projectType ?? "protocol"}</div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className={cn("font-mono text-xs font-bold", proj.roi >= 0 ? "text-emerald-400" : "text-red-400")}>
                                {proj.roi >= 0 ? "+" : ""}${proj.roi.toFixed(2)} ROI
                              </div>
                              <div className="font-mono text-[9px] text-muted-foreground/40">{proj.completedTasks}/{proj.totalTasks} tasks</div>
                            </div>
                          </div>
                          {/* Progress bar */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex gap-3">
                                {proj.totalCost > 0 && <span className="font-mono text-[9px] text-red-400">-${proj.totalCost.toFixed(2)}</span>}
                                {proj.totalProfit > 0 && <span className="font-mono text-[9px] text-emerald-400">+${proj.totalProfit.toFixed(2)}</span>}
                              </div>
                              <span className="font-mono text-[9px] text-primary">{proj.progress}%</span>
                            </div>
                            <div className="h-1.5 bg-muted/20 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-primary/50 to-primary transition-all duration-700"
                                style={{ width: `${proj.progress}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="py-8 text-center font-mono text-sm text-muted-foreground/40">Failed to load overview</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm ── */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-card border-card-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-red-400 flex items-center gap-2">
              <Trash2 className="w-4 h-4" /> Delete Project?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-mono text-muted-foreground">
            This will permanently delete <strong className="text-foreground">{(project as any).name}</strong> and all its tasks.
            This cannot be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteProject} disabled={deletingProject} className="font-mono text-xs">
              {deletingProject ? "Deleting..." : "Delete Forever"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
