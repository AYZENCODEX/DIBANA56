import { useState, useEffect } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Plus, CheckSquare, ClipboardList, Check, X, ExternalLink, RefreshCw, Pencil, Zap, Sparkles,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { TaskFormDialog, type TFDProject as Project, type TFDTaskRow as TaskRow } from "@/components/task-form-dialog";
import { ReceiptLinkDialog } from "@/components/receipt-link-dialog";
import { taskReceiptApi } from "@/lib/receipt-api";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Submission {
  id: number; taskId: number; taskName: string | null; userId: number;
  username: string | null; status: string; proofUrl: string | null;
  notes: string | null; submittedAt: string; reviewedAt: string | null;
}

type Tab = "tasks" | "submissions";
export default function AdminTasks() {
  const { data, isLoading, refetch } = useListTasks();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("tasks");
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<TaskRow | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [verifying, setVerifying] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectDialog, setRejectDialog] = useState<Submission | null>(null);
  const [receiptSub, setReceiptSub] = useState<Submission | null>(null);

  useEffect(() => { loadSubmissions("pending"); }, []);

  useEffect(() => {
    const token = localStorage.getItem("ayzen_token") ?? "";
    fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.projects) setProjects(d.projects); })
      .catch(() => {});
  }, []);

  const loadSubmissions = async (status = statusFilter) => {
    setSubsLoading(true);
    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const res = await fetch(`${BASE}/api/tasks/submissions?status=${status}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setSubmissions(await res.json());
    } catch { toast({ variant: "destructive", title: "Failed to load submissions" }); }
    setSubsLoading(false);
  };

  const handleTabChange = (t: Tab) => { setTab(t); if (t === "submissions") loadSubmissions(); };
  const handleFilterChange = (status: string) => { setStatusFilter(status); loadSubmissions(status); };

  const handleApprove = async (sub: Submission) => {
    setVerifying(sub.id);
    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const res = await fetch(`${BASE}/api/tasks/${sub.taskId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ submissionId: sub.id, approved: true }),
      });
      if (res.ok) {
        toast({ title: "Approved ✓", description: `Task "${sub.taskName}" approved for ${sub.username ?? `User #${sub.userId}`}` });
        loadSubmissions(); queryClient.invalidateQueries();
      } else {
        const d = await res.json();
        toast({ variant: "destructive", title: "Failed", description: d.error });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setVerifying(null);
  };

  const handleReject = async () => {
    if (!rejectDialog) return;
    setVerifying(rejectDialog.id);
    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const res = await fetch(`${BASE}/api/tasks/${rejectDialog.taskId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ submissionId: rejectDialog.id, approved: false, rejectionReason: rejectReason || "Rejected by admin" }),
      });
      if (res.ok) {
        toast({ title: "Rejected", description: `Submission rejected for ${rejectDialog.username ?? `User #${rejectDialog.userId}`}` });
        setRejectDialog(null); setRejectReason(""); loadSubmissions();
      } else {
        const d = await res.json(); toast({ variant: "destructive", title: "Failed", description: d.error });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setVerifying(null);
  };

  const statusColor: Record<string, string> = {
    pending: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10",
    approved: "text-green-400 border-green-400/30 bg-green-400/10",
    rejected: "text-red-400 border-red-400/30 bg-red-400/10",
  };

  const openCreate = () => { setEditTask(null); setFormOpen(true); };
  const openEdit = (task: TaskRow) => { setEditTask(task); setFormOpen(true); };
  const handleSaved = () => { queryClient.invalidateQueries(); refetch(); };

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <CheckSquare className="w-6 h-6 text-primary" /> Task Execution
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Define, monitor, and verify protocol operations</p>
        </div>
        {tab === "tasks" && (
          <Button className="font-mono uppercase text-xs tracking-wider gap-2 animate-glow-pulse" onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Task
          </Button>
        )}
        {tab === "submissions" && (
          <Button variant="outline" className="font-mono uppercase text-xs tracking-wider gap-2" onClick={() => loadSubmissions()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-card border border-card-border rounded-lg p-1 w-fit">
        {(["tasks", "submissions"] as Tab[]).map(t => (
          <button key={t} onClick={() => handleTabChange(t)}
            className={`px-4 py-2 rounded-md font-mono text-xs uppercase tracking-wider transition-colors ${tab === t ? "bg-primary text-black font-bold" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t === "tasks"
              ? <span className="flex items-center gap-1.5"><CheckSquare className="w-3.5 h-3.5" /> Tasks</span>
              : <span className="flex items-center gap-1.5"><ClipboardList className="w-3.5 h-3.5" /> Submissions {submissions.filter(s => s.status === "pending").length > 0 ? <span className="bg-yellow-400 text-black rounded-full w-4 h-4 flex items-center justify-center text-[9px] font-bold">{submissions.filter(s => s.status === "pending").length}</span> : null}</span>}
          </button>
        ))}
      </div>

      {/* Tasks Tab */}
      {tab === "tasks" && (
        <div className="border border-card-border rounded-xl bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-card-border hover:bg-transparent">
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">ID</TableHead>
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Task Name</TableHead>
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Protocol</TableHead>
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Type</TableHead>
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Verification</TableHead>
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground text-right">XP / Reward</TableHead>
                <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i} className="border-card-border">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : !data || data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-14 font-mono text-muted-foreground/50">
                    <div className="flex flex-col items-center gap-3">
                      <CheckSquare className="w-8 h-8 opacity-20" />
                      <span className="text-sm">No tasks yet — click New Task to create one</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                data.map((task: any) => (
                  <TableRow key={task.id} className="border-card-border hover:bg-primary/3 transition-colors group">
                    <TableCell className="font-mono text-[10px] text-muted-foreground/60 w-20">
                      {task.taskId ?? `#TSK-${String(task.id).padStart(4, "0")}`}
                    </TableCell>
                    <TableCell className="font-mono font-medium text-sm">
                      <div>{task.name}</div>
                      {task.taskCategory && (
                        <span className="font-mono text-[9px] text-violet-400/70 uppercase tracking-wider">{task.taskCategory}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">
                      {task.projectName ?? (task.projectId ? `#${task.projectId}` : <span className="text-muted-foreground/40">Individual</span>)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px] uppercase rounded-sm border-primary/20 text-primary/70">
                        {task.taskType}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[10px] uppercase rounded-sm">
                        {task.verificationType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      <div className="flex items-center justify-end gap-2">
                        {task.xpAmount > 0 && (
                          <span className="text-violet-400 flex items-center gap-0.5">
                            <Zap className="w-3 h-3" />{task.xpAmount} XP
                          </span>
                        )}
                        {task.rewardAmount ? (
                          <span className="font-bold text-primary">${task.rewardAmount}</span>
                        ) : !task.xpAmount ? "—" : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => openEdit(task as TaskRow)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary"
                        title="Edit task"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Submissions Tab */}
      {tab === "submissions" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap justify-between">
            <div className="flex gap-2 flex-wrap">
              {["pending", "approved", "rejected"].map(s => (
                <button key={s} onClick={() => handleFilterChange(s)}
                  className={`px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-widest border transition-colors ${statusFilter === s ? statusColor[s] : "border-border text-muted-foreground hover:border-primary/30"}`}
                >
                  {s}
                  {s === "pending" && submissions.filter(x => x.status === "pending").length > 0 && statusFilter !== "pending" && (
                    <span className="ml-1.5 bg-yellow-400 text-black rounded-full px-1.5 text-[9px] font-bold">{submissions.filter(x => x.status === "pending").length}</span>
                  )}
                </button>
              ))}
            </div>
            {statusFilter === "pending" && submissions.filter(s => s.status === "pending").length > 1 && (
              <Button size="sm" variant="outline" className="font-mono text-[10px] uppercase gap-1.5 h-7 border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10"
                onClick={async () => {
                  const pending = submissions.filter(s => s.status === "pending");
                  for (const sub of pending) { await handleApprove(sub); }
                }}>
                <Check className="w-3 h-3" /> Approve All ({submissions.filter(s => s.status === "pending").length})
              </Button>
            )}
          </div>

          <div className="border border-card-border rounded-xl bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-card-border hover:bg-transparent">
                  <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">User</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Task</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Proof / Notes</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Submitted</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Status</TableHead>
                  <TableHead className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subsLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i} className="border-card-border">
                      {Array.from({ length: 6 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                    </TableRow>
                  ))
                ) : submissions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-14 font-mono text-muted-foreground/50">
                      <div className="flex flex-col items-center gap-3">
                        <ClipboardList className="w-8 h-8 opacity-20" />
                        <span className="text-sm">No {statusFilter} submissions</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  submissions.map((sub) => (
                    <TableRow key={sub.id} className="border-card-border hover:bg-primary/3 transition-colors">
                      <TableCell className="font-mono text-sm font-medium">{sub.username ?? `#${sub.userId}`}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{sub.taskName ?? `Task #${sub.taskId}`}</TableCell>
                      <TableCell className="max-w-[200px]">
                        {sub.proofUrl ? (
                          <a href={sub.proofUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary flex items-center gap-1 hover:underline truncate">
                            <ExternalLink className="w-3 h-3 flex-shrink-0" /><span className="truncate">{sub.proofUrl}</span>
                          </a>
                        ) : sub.notes ? (
                          <span className="font-mono text-xs text-muted-foreground truncate">{sub.notes}</span>
                        ) : (
                          <span className="text-muted-foreground/30 font-mono text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {new Date(sub.submittedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </TableCell>
                      <TableCell>
                        <span className={`px-2 py-0.5 rounded font-mono text-[10px] uppercase border ${statusColor[sub.status] ?? "border-border text-muted-foreground"}`}>
                          {sub.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {statusFilter === "pending" && (
                            <>
                              <Button size="sm" variant="ghost" className="h-7 px-2.5 font-mono text-[10px] text-green-400 hover:text-green-300 hover:bg-green-400/10 gap-1" disabled={verifying === sub.id} onClick={() => handleApprove(sub)}>
                                <Check className="w-3 h-3" /> Approve
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2.5 font-mono text-[10px] text-red-400 hover:text-red-300 hover:bg-red-400/10 gap-1" disabled={verifying === sub.id} onClick={() => { setRejectDialog(sub); setRejectReason(""); }}>
                                <X className="w-3 h-3" /> Reject
                              </Button>
                            </>
                          )}
                          <Button size="sm" variant="ghost" className="h-7 px-2.5 font-mono text-[10px] text-primary hover:text-primary hover:bg-primary/10 gap-1" onClick={() => setReceiptSub(sub)}>
                            <Sparkles className="w-3 h-3" /> Receipt
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Task Form Dialog (Create + Edit) */}
      <TaskFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        editTask={editTask}
        projects={projects}
        onSaved={handleSaved}
      />

      {/* Reject Dialog */}
      <Dialog open={!!rejectDialog} onOpenChange={o => { if (!o) { setRejectDialog(null); setRejectReason(""); } }}>
        <DialogContent className="bg-card border-card-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase tracking-wider text-red-400 flex items-center gap-2">
              <X className="w-4 h-4" /> Reject Submission
            </DialogTitle>
            <p className="text-xs font-mono text-muted-foreground">
              Rejecting <strong>{rejectDialog?.username}</strong>'s submission for "{rejectDialog?.taskName}"
            </p>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Reason (optional)</Label>
            <Textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} className="font-mono text-xs bg-input resize-none min-h-[80px]" placeholder="e.g. Proof not valid, wrong wallet, etc." />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setRejectDialog(null); setRejectReason(""); }} className="font-mono text-xs">Cancel</Button>
            <Button onClick={handleReject} disabled={verifying === rejectDialog?.id} className="font-mono text-xs gap-2 bg-red-500 hover:bg-red-600 text-white">
              <X className="w-3 h-3" /> Confirm Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt Dialog — public shareable receipt for a task submission */}
      <ReceiptLinkDialog
        open={!!receiptSub}
        onOpenChange={o => { if (!o) setReceiptSub(null); }}
        itemId={receiptSub?.id ?? null}
        itemLabel={receiptSub ? `${receiptSub.username ?? `User #${receiptSub.userId}`}'s "${receiptSub.taskName ?? "task"}" submission` : undefined}
        api={taskReceiptApi}
        title="Share Task Submission Receipt"
      />
    </div>
  );
}
