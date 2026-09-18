import { useState, useCallback, useRef, useEffect } from "react";
import { useListTasks, useGetMe, useListVaultEntries } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Play, CheckCircle2, Clock, XCircle, Loader2,
  Filter, Search, Zap, Trophy, Send, DollarSign,
  Star, Settings2, Info, X, Download, AlertTriangle, ArrowUp, TimerIcon,
  Plus, Trash2, BookOpen, CheckSquare, Link2, ExternalLink, Globe, CheckCheck,
} from "lucide-react";
import StatsBar from "@/components/stats-bar";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import confetti from "canvas-confetti";
import { COST_CATEGORIES, PROFIT_CATEGORIES } from "@/config/tasks";

const PRIORITY_CONFIG = {
  urgent: { label: "URGENT", color: "text-red-400 border-red-400/30 bg-red-400/5" },
  high:   { label: "HIGH",   color: "text-orange-400 border-orange-400/30 bg-orange-400/5" },
  normal: { label: "NORMAL", color: "text-muted-foreground border-border/40" },
  low:    { label: "LOW",    color: "text-muted-foreground/50 border-border/20" },
} as const;

function exportTasksCSV(tasks: Task[]) {
  const headers = ["ID","Name","Project","Type","Status","XP","Reward","Cost","Profit","ROI%"];
  const rows = tasks.map(t => [
    t.id,
    `"${(t.name ?? "").replace(/"/g, '""')}"`,
    `"${(t.projectName ?? "General").replace(/"/g, '""')}"`,
    t.taskType,
    t.userStatus ?? "available",
    t.xpAmount ?? 0,
    t.rewardAmount ?? 0,
    t.cost ?? 0,
    t.profit ?? 0,
    t.cost && t.profit ? (((t.profit - t.cost) / t.cost) * 100).toFixed(1) : 0,
  ]);
  const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `ayzen-tasks-${new Date().toISOString().split("T")[0]}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function TaskTimer() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (running) {
      startRef.current = Date.now() - elapsed * 1000;
      const tick = () => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [running]);

  const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2,"0")}:${String(Math.floor((s % 3600) / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;

  return (
    <div className="flex items-center gap-2 bg-card border border-card-border rounded-xl px-3 py-2">
      <TimerIcon className={cn("w-3.5 h-3.5 flex-shrink-0", running ? "text-primary animate-pulse" : "text-muted-foreground/50")} />
      <span className="font-mono text-sm tabular-nums text-foreground">{fmt(elapsed)}</span>
      <button
        onClick={() => setRunning(v => !v)}
        className={cn("font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded transition-all border", running ? "text-red-400 border-red-400/30 hover:bg-red-400/10" : "text-primary border-primary/30 hover:bg-primary/10")}
      >
        {running ? "Stop" : "Start"}
      </button>
      {!running && elapsed > 0 && (
        <button onClick={() => setElapsed(0)} className="font-mono text-[9px] text-muted-foreground/40 hover:text-muted-foreground">Reset</button>
      )}
    </div>
  );
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const STATUS_CONFIG = {
  approved:  { label: "Completed", icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
  pending:   { label: "Pending",   icon: Clock,        color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/20" },
  rejected:  { label: "Rejected",  icon: XCircle,      color: "text-red-400",     bg: "bg-red-500/10 border-red-500/20" },
};

const TYPE_COLOR: Record<string, string> = {
  "One-time": "border-primary/30 text-primary",
  "Daily":    "border-violet-400/30 text-violet-400",
  "Weekly":   "border-amber-400/30 text-amber-400",
};

interface Task {
  id: number;
  name: string;
  description?: string | null;
  taskType: string;
  rewardAmount?: number | null;
  verificationType: string;
  projectName?: string | null;
  userStatus?: string | null;
  xpAmount?: number | null;
  cost?: number | null;
  profit?: number | null;
  taskCategory?: string | null;
  category?: string | null;
  deadline?: string | null;
  timeLimitMinutes?: number | null;
  taskLink?: string | null;
  steps?: { title: string; description?: string }[];
}

function LinkBrowserModal({ task, onClose, onSubmit }: {
  task: Task;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [iframeError, setIframeError] = useState(false);
  const [visited, setVisited] = useState(false);
  const [marking, setMarking] = useState(false);
  const { toast } = useToast();
  const token = localStorage.getItem("ayzen_token") ?? "";

  const markVisited = async () => {
    setMarking(true);
    try {
      await fetch(`${BASE}/api/tasks/${task.id}/visit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setVisited(true);
      toast({ title: "✅ Visit recorded", description: "You can now submit your proof." });
    } catch {
      setVisited(true);
    }
    setMarking(false);
  };

  const openExternal = () => {
    window.open(task.taskLink!, "_blank", "noopener,noreferrer");
    setTimeout(markVisited, 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-card border border-card-border rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent" />

        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <span className="font-mono text-xs uppercase tracking-widest text-primary font-bold">Link Task</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Task info */}
        <div className="px-5 py-4 border-b border-border/50">
          <p className="font-mono font-semibold text-sm text-foreground mb-1">{task.name}</p>
          {task.description && (
            <p className="font-mono text-xs text-muted-foreground/70">{task.description}</p>
          )}
        </div>

        {/* URL display */}
        <div className="px-5 py-4 border-b border-border/50">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1">
            <Link2 className="w-3 h-3" /> Task Website
          </div>
          <div className="flex items-center gap-2 bg-background/60 border border-border/60 rounded-lg px-3 py-2">
            <span className="font-mono text-xs text-primary/80 truncate flex-1">{task.taskLink}</span>
            <button
              onClick={openExternal}
              className="flex items-center gap-1.5 text-[10px] font-mono text-primary hover:text-primary/80 transition-colors shrink-0"
            >
              <ExternalLink className="w-3 h-3" /> Open
            </button>
          </div>
        </div>

        {/* Iframe attempt */}
        <div className="relative bg-background/30" style={{ height: "280px" }}>
          {!iframeError ? (
            <>
              <iframe
                src={task.taskLink!}
                className="w-full h-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onError={() => setIframeError(true)}
                title="Task Website"
              />
              <div className="absolute inset-0 pointer-events-none flex items-end justify-center pb-3">
                <div className="bg-black/60 backdrop-blur-sm rounded-lg px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                  If blocked, use the Open button above ↑
                </div>
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-8">
              <Globe className="w-10 h-10 text-muted-foreground/30" />
              <div>
                <p className="font-mono text-sm text-muted-foreground">This site can't be embedded</p>
                <p className="font-mono text-[11px] text-muted-foreground/50 mt-1">Click "Open" to visit in a new tab</p>
              </div>
              <button
                onClick={openExternal}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary font-mono text-xs hover:bg-primary/20 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open Task Website
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex items-center gap-3">
          {!visited ? (
            <Button
              variant="outline"
              className="flex-1 font-mono text-xs h-10 border-border gap-2"
              onClick={openExternal}
              disabled={marking}
            >
              {marking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
              Open Website
            </Button>
          ) : (
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 font-mono text-xs text-emerald-400">
              <CheckCheck className="w-3.5 h-3.5" /> Website visited
            </div>
          )}
          <Button
            className="flex-1 font-mono text-xs h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={onSubmit}
          >
            <Send className="w-3.5 h-3.5" /> Submit Proof
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CostEntry {
  id: string;
  type: "cost" | "profit";
  category: string;
  label: string;
  amount: string;
}

function newEntry(type: "cost" | "profit"): CostEntry {
  return { id: Math.random().toString(36).slice(2), type, category: "", label: "", amount: "" };
}

type SubmitTab = "details" | "guide" | "cost-roi" | "points" | "settings";

function SubmitModal({ task, onClose, onDone }: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const steps: { title: string; description?: string }[] = Array.isArray(task.steps) ? task.steps : [];
  const hasSteps = steps.length > 0;

  const [tab, setTab] = useState<SubmitTab>(hasSteps ? "guide" : "details");
  const [proofUrl, setProofUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [costEntries, setCostEntries] = useState<CostEntry[]>([]);
  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(new Set());
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const { data: vaultData } = useListVaultEntries();

  const token = localStorage.getItem("ayzen_token") ?? "";
  const vaultEntries = Array.isArray(vaultData) ? vaultData : [];

  const totalCost = costEntries.filter(e => e.type === "cost").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalProfit = costEntries.filter(e => e.type === "profit").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const roi = totalCost > 0 && totalProfit > 0
    ? (((totalProfit - totalCost) / totalCost) * 100).toFixed(1)
    : null;

  const addEntry = (type: "cost" | "profit") => setCostEntries(e => [...e, newEntry(type)]);
  const removeEntry = (id: string) => setCostEntries(e => e.filter(x => x.id !== id));
  const updateEntry = (id: string, patch: Partial<CostEntry>) =>
    setCostEntries(e => e.map(x => x.id === id ? { ...x, ...patch } : x));

  const toggleStep = (i: number) => setCheckedSteps(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const toggleEntity = (id: number) => {
    setSelectedEntityIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/tasks/${task.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          proofUrl: proofUrl.trim() || undefined,
          notes: notes.trim() || undefined,
          costEntries: costEntries.length > 0 ? costEntries.map(({ id: _id, ...rest }) => ({ ...rest, amount: Number(rest.amount) || 0 })) : undefined,
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
        onDone();
      } else {
        toast({ variant: "destructive", title: "Submit failed", description: data.error ?? "Try again." });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setLoading(false);
  };

  const TABS: { id: SubmitTab; label: string; icon: React.ElementType }[] = [
    ...(hasSteps ? [{ id: "guide" as SubmitTab, label: "Guide", icon: BookOpen }] : []),
    { id: "details",  label: "Details",   icon: Info },
    { id: "cost-roi", label: "Cost / ROI", icon: DollarSign },
    { id: "points",   label: "Points",    icon: Star },
    { id: "settings", label: "Settings",  icon: Settings2 },
  ];

  return (
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
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="font-mono font-semibold text-foreground text-sm mt-1.5">{task.name}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <Badge variant="outline" className={cn("font-mono text-[10px] uppercase", TYPE_COLOR[task.taskType] ?? "border-muted-foreground/30 text-muted-foreground")}>
              {task.taskType}
            </Badge>
            {task.taskCategory && (
              <Badge variant="outline" className="font-mono text-[10px] uppercase border-violet-400/30 text-violet-400">
                {task.taskCategory}
              </Badge>
            )}
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
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2.5 text-[10px] font-mono uppercase tracking-wider border-b-2 transition-all -mb-px whitespace-nowrap",
                  tab === t.id
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
        <div className="p-5 space-y-4 min-h-[200px] max-h-[60vh] overflow-y-auto">

          {/* ── Guide ────────────────────────────────────────────── */}
          {tab === "guide" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">
                Follow the step-by-step guide below. Check off each step as you complete it.
              </p>
              {steps.length === 0 ? (
                <div className="text-center py-8 font-mono text-muted-foreground/40 text-sm">
                  No steps configured for this task.
                </div>
              ) : (
                <div className="space-y-2">
                  {steps.map((step, i) => {
                    const done = checkedSteps.has(i);
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => toggleStep(i)}
                        className={cn(
                          "w-full text-left rounded-lg border p-3 transition-all",
                          done
                            ? "bg-emerald-500/5 border-emerald-500/30"
                            : "bg-muted/20 border-border/40 hover:border-primary/30"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            "mt-0.5 w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-all",
                            done ? "bg-emerald-500 border-emerald-500" : "border-border/60"
                          )}>
                            {done && <span className="text-white text-[9px] font-bold">✓</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={cn("font-mono text-xs font-bold", done && "line-through text-muted-foreground")}>
                              Step {i + 1}: {step.title}
                            </div>
                            {step.description && (
                              <div className="font-mono text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">
                                {step.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {checkedSteps.size === steps.length && (
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-4 py-3 text-center font-mono text-xs text-emerald-400">
                      ✅ All steps completed! Head to Details to submit proof.
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Details ──────────────────────────────────────────── */}
          {tab === "details" && (
            <>
              {task.description && (
                <p className="text-[11px] font-mono text-muted-foreground bg-muted/20 rounded px-3 py-2 leading-relaxed">
                  {task.description}
                </p>
              )}
              <div>
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 block">
                  Proof URL / TX Hash — optional
                </label>
                <Input
                  placeholder="https://... or 0x..."
                  value={proofUrl}
                  onChange={e => setProofUrl(e.target.value)}
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                />
              </div>
              <div>
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 block">
                  Notes — optional
                </label>
                <Textarea
                  placeholder="Notes for the reviewer..."
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  className="font-mono text-xs bg-input border-border focus-visible:ring-primary/50 resize-none"
                />
              </div>

              {/* Vault entity multi-select */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Select Entities — optional
                  </label>
                  {selectedEntityIds.size > 0 && (
                    <span className="text-[10px] font-mono text-primary">
                      {selectedEntityIds.size} selected
                    </span>
                  )}
                </div>
                {vaultEntries.length === 0 ? (
                  <p className="text-[10px] font-mono text-muted-foreground/50 py-2 text-center bg-muted/20 rounded border border-border">
                    No vault entities yet. Add entities in the Vault.
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                    {vaultEntries.map((entry: any) => {
                      const serial = `AYZNA-${String(entry.id).padStart(4, "0")}`;
                      const selected = selectedEntityIds.has(entry.id);
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => toggleEntity(entry.id)}
                          className={cn(
                            "w-full flex items-center gap-2.5 px-3 py-2 rounded border text-left transition-all",
                            selected
                              ? "bg-primary/10 border-primary/40 text-primary"
                              : "bg-muted/20 border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                          )}
                        >
                          <div className={cn(
                            "w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-all",
                            selected ? "bg-primary border-primary" : "border-border/60"
                          )}>
                            {selected && <span className="text-primary-foreground text-[8px] font-bold">✓</span>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[11px] font-medium truncate">
                              {entry.projectName || serial}
                            </div>
                            <div className="font-mono text-[9px] text-muted-foreground/60 truncate">
                              {serial} · {entry.category ?? "General"}
                              {entry.twitterUsername && ` · @${entry.twitterUsername}`}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Cost / ROI ───────────────────────────────────────── */}
          {tab === "cost-roi" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">
                Track your spending and earnings for this task. Add multiple entries per category.
              </p>

              {/* Cost entries */}
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-red-400 font-bold">
                    Costs {totalCost > 0 && <span className="ml-1 opacity-70">(${totalCost.toFixed(2)})</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => addEntry("cost")}
                    className="flex items-center gap-1 font-mono text-[10px] text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 rounded px-2 py-1 transition-all"
                  >
                    <Plus className="w-3 h-3" /> Add Cost
                  </button>
                </div>

                {costEntries.filter(e => e.type === "cost").length === 0 ? (
                  <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-1">No cost entries yet</p>
                ) : (
                  <div className="space-y-2">
                    {costEntries.filter(e => e.type === "cost").map(entry => (
                      <div key={entry.id} className="space-y-2 p-2 rounded bg-black/20 border border-red-500/10">
                        <div className="flex flex-wrap gap-1">
                          {COST_CATEGORIES.map(cat => (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => updateEntry(entry.id, { category: cat })}
                              className={cn(
                                "px-2 py-0.5 rounded-full font-mono text-[9px] border transition-all",
                                entry.category === cat
                                  ? "bg-red-500/20 border-red-500/50 text-red-400 font-bold"
                                  : "border-border/40 text-muted-foreground/60 hover:border-red-500/30"
                              )}
                            >{cat}</button>
                          ))}
                        </div>
                        {entry.category === "Manual" && (
                          <Input
                            placeholder="Custom name..."
                            value={entry.label}
                            onChange={e => updateEntry(entry.id, { label: e.target.value })}
                            className="font-mono text-[10px] h-7 bg-input border-border"
                          />
                        )}
                        <div className="flex gap-2 items-center">
                          <div className="relative flex-1">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-[10px]">$</span>
                            <Input
                              type="text" inputMode="decimal" placeholder="0.00"
                              value={entry.amount}
                              onChange={e => updateEntry(entry.id, { amount: e.target.value })}
                              className="font-mono text-[10px] h-7 bg-input border-border pl-5"
                            />
                          </div>
                          <button onClick={() => removeEntry(entry.id)} className="text-muted-foreground/40 hover:text-red-400 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Profit entries */}
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-emerald-400 font-bold">
                    Profit / Return {totalProfit > 0 && <span className="ml-1 opacity-70">(${totalProfit.toFixed(2)})</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => addEntry("profit")}
                    className="flex items-center gap-1 font-mono text-[10px] text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 hover:border-emerald-400/50 rounded px-2 py-1 transition-all"
                  >
                    <Plus className="w-3 h-3" /> Add Profit
                  </button>
                </div>

                {costEntries.filter(e => e.type === "profit").length === 0 ? (
                  <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-1">No profit entries yet</p>
                ) : (
                  <div className="space-y-2">
                    {costEntries.filter(e => e.type === "profit").map(entry => (
                      <div key={entry.id} className="space-y-2 p-2 rounded bg-black/20 border border-emerald-500/10">
                        <div className="flex flex-wrap gap-1">
                          {PROFIT_CATEGORIES.map(cat => (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => updateEntry(entry.id, { category: cat })}
                              className={cn(
                                "px-2 py-0.5 rounded-full font-mono text-[9px] border transition-all",
                                entry.category === cat
                                  ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400 font-bold"
                                  : "border-border/40 text-muted-foreground/60 hover:border-emerald-500/30"
                              )}
                            >{cat}</button>
                          ))}
                        </div>
                        {entry.category === "Manual" && (
                          <Input
                            placeholder="Custom name..."
                            value={entry.label}
                            onChange={e => updateEntry(entry.id, { label: e.target.value })}
                            className="font-mono text-[10px] h-7 bg-input border-border"
                          />
                        )}
                        <div className="flex gap-2 items-center">
                          <div className="relative flex-1">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-[10px]">$</span>
                            <Input
                              type="text" inputMode="decimal" placeholder="0.00"
                              value={entry.amount}
                              onChange={e => updateEntry(entry.id, { amount: e.target.value })}
                              className="font-mono text-[10px] h-7 bg-input border-border pl-5"
                            />
                          </div>
                          <button onClick={() => removeEntry(entry.id)} className="text-muted-foreground/40 hover:text-red-400 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ROI auto-calc */}
              <div className={cn(
                "rounded-lg border p-4 text-center transition-all",
                roi
                  ? Number(roi) >= 0 ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"
                  : "border-border bg-muted/20"
              )}>
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Calculated ROI</div>
                <div className={cn(
                  "font-mono text-3xl font-bold",
                  roi
                    ? Number(roi) >= 0 ? "text-emerald-400" : "text-red-400"
                    : "text-muted-foreground/40"
                )}>
                  {roi ? `${Number(roi) >= 0 ? "+" : ""}${roi}%` : "—"}
                </div>
                {totalCost > 0 && totalProfit > 0 && (
                  <div className="font-mono text-[10px] text-muted-foreground mt-1">
                    Net: ${(totalProfit - totalCost).toFixed(2)}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Points ───────────────────────────────────────────── */}
          {tab === "points" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">
                Rewards you'll earn upon successful verification of this task.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">XP Points</div>
                  <div className="font-mono text-2xl font-bold text-primary">
                    {task.xpAmount ? `+${task.xpAmount}` : "—"}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground/60 mt-1">XP</div>
                </div>
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 text-center">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Reward</div>
                  <div className="font-mono text-2xl font-bold text-amber-400">
                    {task.rewardAmount ? `$${task.rewardAmount}` : "—"}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground/60 mt-1">USD</div>
                </div>
              </div>
              <div className="bg-muted/20 border border-border rounded-lg divide-y divide-border">
                {[
                  { label: "Task Category", value: task.taskCategory ?? task.category ?? "General" },
                  { label: "Type", value: task.taskType },
                  { label: "Verification", value: task.verificationType === "auto" ? "⚡ Automatic" : "👤 Manual review" },
                ].map(row => (
                  <div key={row.label} className="flex justify-between items-center px-4 py-2.5">
                    <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">{row.label}</span>
                    <span className="font-mono text-[10px] text-foreground">{row.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Settings ─────────────────────────────────────────── */}
          {tab === "settings" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">
                Task configuration and constraints set by the admin.
              </p>
              <div className="bg-muted/20 border border-border rounded-lg divide-y divide-border">
                {[
                  { label: "Task ID", value: `#${task.id}` },
                  { label: "Project", value: task.projectName ?? "General" },
                  { label: "Task Category", value: task.taskCategory ?? task.category ?? "—" },
                  { label: "Task Type", value: task.taskType },
                  { label: "Verification", value: task.verificationType === "auto" ? "Automatic" : "Manual review" },
                  { label: "Time Limit", value: task.timeLimitMinutes ? `${task.timeLimitMinutes} min` : "No limit" },
                  { label: "Deadline", value: task.deadline ? new Date(task.deadline).toLocaleDateString() : "None" },
                  { label: "Steps Guide", value: hasSteps ? `${steps.length} steps` : "Not configured" },
                ].map(row => (
                  <div key={row.label} className="flex justify-between items-center px-4 py-2.5">
                    <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">{row.label}</span>
                    <span className="font-mono text-[10px] text-foreground">{row.value}</span>
                  </div>
                ))}
              </div>
              {task.verificationType !== "auto" && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3">
                  <p className="font-mono text-[10px] text-amber-400">
                    ℹ️ Manual review required. You'll receive a notification when the admin approves your submission.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-4 flex gap-3">
          <Button
            variant="outline"
            className="flex-1 font-mono text-xs h-10 border-border"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 font-mono text-xs h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={submit}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {loading ? "Submitting…" : "Submit Task"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function UserTasks() {
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { data, isLoading, refetch } = useListTasks(undefined, {
    query: { queryKey: ["tasks", me?.id] },
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "completed" | "available">("all");
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [linkTask, setLinkTask] = useState<Task | null>(null);
  const { toast } = useToast();

  const tasks: Task[] = (Array.isArray(data) ? data : []) as Task[];

  const filtered = tasks.filter(t => {
    const q = search.toLowerCase();
    if (q && !t.name.toLowerCase().includes(q) && !(t.projectName ?? "").toLowerCase().includes(q)) return false;
    if (filter === "completed") return t.userStatus === "approved";
    if (filter === "pending")   return t.userStatus === "pending";
    if (filter === "available") return !t.userStatus;
    return true;
  });

  const counts = {
    all:       tasks.length,
    available: tasks.filter(t => !t.userStatus).length,
    pending:   tasks.filter(t => t.userStatus === "pending").length,
    completed: tasks.filter(t => t.userStatus === "approved").length,
  };

  const handleDone = useCallback(async () => {
    setActiveTask(null);
    await refetch();
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["user-stats"] });
  }, [refetch, queryClient]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        exportTasksCSV(tasks);
        toast({ title: "📊 Exported", description: `${tasks.length} tasks exported to CSV` });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tasks]);

  const handleExecute = (task: Task) => {
    if (task.userStatus === "approved") {
      toast({ title: "Already completed", description: "You already earned rewards for this task." });
      return;
    }
    if (task.userStatus === "pending") {
      toast({ title: "Under review", description: "Your submission is awaiting admin verification." });
      return;
    }
    if (task.taskLink) {
      setLinkTask(task);
    } else {
      setActiveTask(task);
    }
  };

  return (
    <div className="space-y-6">
      <StatsBar />

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Task Center</h1>
          <p className="text-muted-foreground font-mono text-sm">Pending executions and active operations</p>
        </div>
        <div className="flex items-center gap-3">
          <TaskTimer />
          <button
            onClick={() => exportTasksCSV(filtered)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border/40 text-muted-foreground hover:text-primary hover:border-primary/30 transition-all font-mono text-[10px] uppercase tracking-wider"
            title="Export to CSV (⌘E)"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            <span className="font-mono text-xs text-muted-foreground">
              <span className="text-emerald-400 font-bold">{counts.completed}</span> / {counts.all} completed
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "available", "pending", "completed"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-all border",
              filter === f
                ? "bg-primary/15 text-primary border-primary/30"
                : "text-muted-foreground border-muted/30 hover:border-muted-foreground/30"
            )}
          >
            {f} <span className="opacity-60">({counts[f]})</span>
          </button>
        ))}
        <div className="ml-auto relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-7 h-8 w-44 text-xs font-mono bg-input border-border"
          />
        </div>
      </div>

      <div className="grid gap-3">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="bg-card border-card-border shadow-none">
              <CardContent className="p-5"><Skeleton className="h-14 w-full" /></CardContent>
            </Card>
          ))
        ) : filtered.length === 0 ? (
          <div className="py-14 text-center font-mono text-muted-foreground bg-card border border-card-border rounded-xl">
            <Filter className="w-8 h-8 mx-auto mb-3 opacity-30" />
            {search ? "No tasks match your search." : "No tasks in this category."}
          </div>
        ) : (
          filtered.map(task => {
            const statusCfg = task.userStatus ? STATUS_CONFIG[task.userStatus as keyof typeof STATUS_CONFIG] : null;
            const StatusIcon = statusCfg?.icon;
            const isDone = task.userStatus === "approved";
            const isPending = task.userStatus === "pending";
            const hasTaskSteps = Array.isArray(task.steps) && task.steps.length > 0;

            return (
              <Card
                key={task.id}
                className={cn(
                  "bg-card border-card-border shadow-none transition-all duration-200",
                  isDone ? "opacity-70" : "hover:border-primary/40"
                )}
              >
                <CardContent className="p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={cn("font-mono font-bold truncate", isDone ? "text-muted-foreground line-through" : "text-foreground")}>
                        {task.name}
                      </h3>
                      <Badge variant="outline" className={cn("font-mono text-[10px] uppercase rounded-sm shrink-0", TYPE_COLOR[task.taskType] ?? "border-muted-foreground/30 text-muted-foreground")}>
                        {task.taskType}
                      </Badge>
                      {task.taskCategory && (
                        <Badge variant="outline" className="font-mono text-[10px] uppercase rounded-sm shrink-0 border-violet-400/30 text-violet-400">
                          {task.taskCategory}
                        </Badge>
                      )}
                      {hasTaskSteps && (
                        <Badge variant="outline" className="font-mono text-[10px] rounded-sm shrink-0 border-primary/30 text-primary flex items-center gap-1">
                          <BookOpen className="w-2.5 h-2.5" /> {task.steps!.length} steps
                        </Badge>
                      )}
                      {task.taskLink && (
                        <Badge variant="outline" className="font-mono text-[10px] rounded-sm shrink-0 border-sky-400/40 text-sky-400 flex items-center gap-1">
                          <Link2 className="w-2.5 h-2.5" /> Website
                        </Badge>
                      )}
                      {(task as any).priority && (task as any).priority !== "normal" && (
                        <Badge variant="outline" className={cn("font-mono text-[9px] uppercase rounded-sm shrink-0", PRIORITY_CONFIG[(task as any).priority as keyof typeof PRIORITY_CONFIG]?.color)}>
                          {PRIORITY_CONFIG[(task as any).priority as keyof typeof PRIORITY_CONFIG]?.label ?? (task as any).priority}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <p className="text-xs font-mono text-muted-foreground/70">{task.projectName ?? "General"}</p>
                      {task.verificationType === "auto" && (
                        <span className="text-[9px] font-mono text-emerald-400 uppercase tracking-wider flex items-center gap-0.5">
                          <Zap className="w-2.5 h-2.5" /> auto
                        </span>
                      )}
                    </div>
                    {task.description && (
                      <p className="text-[11px] font-mono text-muted-foreground/50 leading-relaxed line-clamp-1">{task.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-3 w-full sm:w-auto shrink-0">
                    {(task.rewardAmount || task.xpAmount) && (
                      <div className="text-right flex-1 sm:flex-none">
                        {task.rewardAmount && (
                          <>
                            <div className="text-[9px] uppercase font-mono text-muted-foreground mb-0.5">Reward</div>
                            <div className="font-bold font-mono text-base text-primary">${task.rewardAmount}</div>
                          </>
                        )}
                        {task.xpAmount && (
                          <div className="font-mono text-[10px] text-muted-foreground/60">+{task.xpAmount} XP</div>
                        )}
                      </div>
                    )}

                    {statusCfg && StatusIcon ? (
                      <div className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-mono", statusCfg.bg, statusCfg.color)}>
                        <StatusIcon className="w-3.5 h-3.5" />
                        {statusCfg.label}
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        className="font-mono uppercase text-xs gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-9"
                        onClick={() => handleExecute(task)}
                      >
                        <Play className="h-3 w-3" /> Execute
                      </Button>
                    )}

                    {isPending && (
                      <button
                        className="text-[10px] font-mono text-muted-foreground hover:text-foreground underline"
                        onClick={() => setActiveTask(task)}
                        title="Resubmit"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {linkTask && (
        <LinkBrowserModal
          task={linkTask}
          onClose={() => setLinkTask(null)}
          onSubmit={() => { setActiveTask(linkTask); setLinkTask(null); }}
        />
      )}

      {activeTask && (
        <SubmitModal
          task={activeTask}
          onClose={() => setActiveTask(null)}
          onDone={handleDone}
        />
      )}
    </div>
  );
}
