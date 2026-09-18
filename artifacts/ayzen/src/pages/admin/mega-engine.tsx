/**
 * pages/admin/mega-engine.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase I4: first admin-UI screen for the Workflow
 * engine. `routes/admin-mega-engine.ts` has had a full read/write API
 * since Part F1 (list/get/cancel/replay runs) and Part I3 widened the
 * run-detail response with `resumeJobs` — but nothing in this app has
 * ever rendered any of it (see I3's own "Still open" list: "no frontend
 * page renders `resumeJobs` yet" / "admin-UI screens generally").
 *
 * Scope is deliberately narrow, same posture every phase since I1 has
 * used: this page is the Workflow Runs list + detail view only — the
 * exact surface I3 flagged. Health/metrics/dead-letters/retention
 * already have working routes on the same router but no screen of their
 * own yet either; that's carried forward untouched, not folded in here.
 *
 * Extended in Phase I5: the detail dialog now polls
 * (`NON_TERMINAL`/`DETAIL_POLL_MS` below) while the open run is still
 * PENDING/RUNNING/WAITING/COMPENSATING, closing the exact "no
 * auto-refresh/polling" gap I4's own "Still open" list named. No new
 * backend surface — same `GET .../workflow/runs/:id` this page already
 * called on open, just called again on a timer.
 *
 * Extended in Phase I6: the list view itself now detects new activity
 * in the background too — the other half of the gap I4 first named and
 * I5's own "Still open" list carried forward verbatim ("an operator
 * watching the list itself ... still needs the page-level Refresh
 * button to see a brand-new run appear or an existing row's status
 * change"). Deliberately NOT the detail dialog's own shape (blind
 * swap-and-rerender on a timer) — I5's "Scope" section already gave the
 * reason that shape was left out for the list specifically: silently
 * replacing `runs` out from under an operator mid-scan re-sorts/re-pages
 * rows they were reading, for a benefit nobody asked for. This phase
 * closes the actual gap (no way to know something changed without
 * manually hitting Refresh) without reintroducing that one: see
 * `LIST_POLL_MS`/`runsDiffer`/`listUpdateAvailable` below.
 *
 * Extended in Phase I7: neither poll now runs while the browser tab
 * itself is backgrounded — the item I5 first named against its own
 * detail poll ("a dialog left open in a hidden tab keeps polling ...
 * not bandwidth/battery-optimal") and I6 carried forward untouched a
 * second time, now against its own list poll too. `isTabVisible`
 * below tracks `document.visibilityState` once, for both polls — see
 * that state and its `visibilitychange` listener.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Workflow, RefreshCw, Loader2, Ban, RotateCcw, Search, ChevronRight,
  Clock, AlertTriangle, ListTree, Timer, Sparkles,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ─── Types (mirror lib/workflow/types.ts + lib/scheduler/types.ts JSON shapes) ──

type WorkflowRunStatus =
  | "PENDING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED"
  | "CANCELLED" | "TIMED_OUT" | "COMPENSATING" | "COMPENSATED" | "DEAD_LETTER";

type WorkflowStepRunStatus =
  | "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED" | "COMPENSATING" | "COMPENSATED";

type JobStatus =
  | "SCHEDULED" | "READY" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELLED" | "DEAD_LETTER";

interface WorkflowRun {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: WorkflowRunStatus;
  currentStepId?: string;
  context?: { userId?: number; organizationId?: number; resourceId?: string; correlationId?: string; input?: Record<string, unknown> };
  correlationId?: string;
  causationId?: string;
  maxRuntimeMs?: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
  nextResumeAt?: string;
  createdAt: string;
}

interface WorkflowStepRun {
  id: number;
  runId: string;
  stepId: string;
  attempt: number;
  status: WorkflowStepRunStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

interface ResumeJob {
  id: string;
  jobType: string;
  runAt: string;
  status: JobStatus;
  correlationId?: string;
  causationId?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
}

interface RunDetail {
  run: WorkflowRun;
  stepRuns: WorkflowStepRun[];
  resumeJobs: ResumeJob[];
}

const RUN_STATUSES: WorkflowRunStatus[] = [
  "PENDING", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "COMPENSATING", "COMPENSATED", "DEAD_LETTER",
];

// run-store.ts's cancelRun(): `UPDATE ... WHERE status IN (PENDING, RUNNING, WAITING)`.
const CANCELLABLE: ReadonlySet<WorkflowRunStatus> = new Set(["PENDING", "RUNNING", "WAITING"]);
// replay.ts's own REPLAYABLE_STATUSES.
const REPLAYABLE: ReadonlySet<WorkflowRunStatus> = new Set(["FAILED", "TIMED_OUT", "CANCELLED", "DEAD_LETTER"]);
// Phase I5 — mirrors state-machine.ts's own isTerminalRunStatus(): the
// four statuses whose RUN_TRANSITIONS entry is non-empty. Polling only
// makes sense while a run could still change under the operator —
// once it's terminal there is nothing left to wait for.
const NON_TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set(["PENDING", "RUNNING", "WAITING", "COMPENSATING"]);
// How often the open detail dialog re-polls a non-terminal run. Not
// configurable — this is an operator console, not a dashboard with
// varied audiences/load concerns; one sane constant matches every
// other fixed interval already hard-coded in this codebase's admin UI
// (see e.g. developer.tsx's own polling intervals).
const DETAIL_POLL_MS = 3000;
// Phase I6 — how often the list view quietly checks for new activity in
// the background. A longer interval than DETAIL_POLL_MS on purpose: the
// detail poll re-fetches one row by id, this re-fetches the whole
// filtered list (up to 200 rows per admin-mega-engine.ts's own cap) —
// coarser data doesn't need as tight a loop, and this one only ever
// flips a boolean, never touches what's on screen (see runsDiffer below).
const LIST_POLL_MS = 5000;

const RUN_BADGE: Record<WorkflowRunStatus, string> = {
  PENDING: "pending", RUNNING: "info", WAITING: "warning", COMPLETED: "success",
  FAILED: "destructive", CANCELLED: "secondary", TIMED_OUT: "destructive",
  COMPENSATING: "warning", COMPENSATED: "outline", DEAD_LETTER: "destructive",
};

const STEP_BADGE: Record<WorkflowStepRunStatus, string> = {
  PENDING: "pending", RUNNING: "info", COMPLETED: "success", FAILED: "destructive",
  SKIPPED: "secondary", COMPENSATING: "warning", COMPENSATED: "outline",
};

const JOB_BADGE: Record<JobStatus, string> = {
  SCHEDULED: "info", READY: "pending", RUNNING: "info", RETRYING: "warning",
  COMPLETED: "success", FAILED: "destructive", CANCELLED: "secondary", DEAD_LETTER: "destructive",
};

function StatusBadge<T extends string>({ status, map }: { status: T; map: Record<string, string> }) {
  return <Badge variant={(map[status] ?? "outline") as any} className="text-[10px] font-mono">{status}</Badge>;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Phase I6 — "did the list change" for exactly the two things I5's own
// carried-forward text named: a run appearing/disappearing from the
// filtered window (length, or same length but a different id set — e.g.
// one run aged out of `limit` the same tick a new one arrived) or an
// existing row's status changing. Deliberately not a deep-equal of the
// full WorkflowRun shape — currentStepId/lastError/etc. changing without
// the status itself changing isn't something an operator scanning the
// list (as opposed to an open detail dialog, which I5 already polls in
// full) would notice missing, so it isn't worth flagging here.
function runsDiffer(fetched: WorkflowRun[], current: WorkflowRun[]): boolean {
  if (fetched.length !== current.length) return true;
  const currentStatusById = new Map(current.map(r => [r.id, r.status]));
  return fetched.some(r => currentStatusById.get(r.id) !== r.status);
}

export default function AdminMegaEnginePage() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [definitionId, setDefinitionId] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const { toast } = useToast();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState(false);

  // Phase I6 — set when a background poll (see below) has seen the list
  // change since it was last actually loaded onto the screen. Purely a
  // "there's something to refresh for" flag, never itself a source of
  // row data — the banner it drives calls the exact same loadRuns() the
  // header's own Refresh button always has.
  const [listUpdateAvailable, setListUpdateAvailable] = useState(false);
  // Lets the background poll (whose interval is set up once per
  // filter-change, not once per fetch) always diff against whatever is
  // currently on screen without itself being a reason to tear down and
  // recreate that interval every time `runs` changes.
  const runsRef = useRef<WorkflowRun[]>([]);
  useEffect(() => { runsRef.current = runs; }, [runs]);

  // Phase I7 — the one thing both I5's detail poll and I6's list poll
  // independently carried forward as "still open": neither checked
  // whether the tab was even visible before firing. Tracked once, here,
  // for both — read by the two poll `useEffect`s below as an extra
  // guard alongside their existing ones. Initialized from the current
  // value rather than assuming `true`, so a page that's opened in an
  // already-backgrounded tab (e.g. restored by the browser) doesn't
  // start polling for the split second before the listener's first
  // event would otherwise correct it.
  const [isTabVisible, setIsTabVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const handleVisibilityChange = () => setIsTabVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (definitionId.trim()) params.set("definitionId", definitionId.trim());
      if (correlationId.trim()) params.set("correlationId", correlationId.trim());
      params.set("limit", "100");
      const data = await customFetch<{ runs: WorkflowRun[] }>(`/api/admin/mega-engine/workflow/runs?${params.toString()}`);
      setRuns(Array.isArray(data?.runs) ? data.runs : []);
      // Whatever's now on screen is current by definition — any pending
      // "new activity" banner is stale the moment this succeeds, whether
      // it got here via the header button, a filter change, or the
      // operator clicking the banner itself.
      setListUpdateAvailable(false);
    } catch {
      toast({ title: "Failed to load workflow runs", variant: "destructive" });
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, definitionId, correlationId, toast]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Phase I6 — the background half of the poll. Same request loadRuns()
  // makes (same filters, same limit) but never touches `loading`/`runs`
  // itself and never toasts on failure: nothing here was asked for by
  // the operator, so a transient failure just means the next tick tries
  // again, same as if this poll hadn't run at all.
  const pollRunsInBackground = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (definitionId.trim()) params.set("definitionId", definitionId.trim());
      if (correlationId.trim()) params.set("correlationId", correlationId.trim());
      params.set("limit", "100");
      const data = await customFetch<{ runs: WorkflowRun[] }>(`/api/admin/mega-engine/workflow/runs?${params.toString()}`);
      const fetched = Array.isArray(data?.runs) ? data.runs : [];
      if (runsDiffer(fetched, runsRef.current)) setListUpdateAvailable(true);
    } catch { /* silent — see comment above; the next tick retries */ }
  }, [statusFilter, definitionId, correlationId]);

  // Only runs while the detail dialog is closed: with it open, the
  // operator's attention (and I5's own poll) is already on that one run,
  // not the list underneath it, and a banner they can't see appearing
  // behind the dialog would do nothing but fire a wasted extra request
  // every LIST_POLL_MS on top of the detail poll already running.
  // Phase I7 — and only while the tab itself is visible; a hidden tab
  // has no operator to show a "new activity" banner to either.
  useEffect(() => {
    if (selectedRunId || !isTabVisible) return;
    const timer = setInterval(() => { pollRunsInBackground(); }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [selectedRunId, pollRunsInBackground, isTabVisible]);

  const openRun = async (id: string) => {
    setSelectedRunId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await customFetch<RunDetail>(`/api/admin/mega-engine/workflow/runs/${id}`);
      setDetail(data);
    } catch {
      toast({ title: "Failed to load run detail", variant: "destructive" });
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async (id: string) => {
    try {
      const data = await customFetch<RunDetail>(`/api/admin/mega-engine/workflow/runs/${id}`);
      setDetail(data);
    } catch { /* row still shows the pre-action state; not worth a second toast */ }
  };

  // Phase I5 — the gap I4's own "Still open" list named: an operator
  // watching a RUNNING/WAITING run had to close and reopen the dialog
  // (or hit the page-level Refresh) to see new step rows or a newly
  // (re-)scheduled workflow.resume job. Polls only while the dialog is
  // open AND the run is one of NON_TERMINAL — a run that's already
  // COMPLETED/FAILED/CANCELLED/etc. can't produce anything new to see,
  // so the interval is never even set for one, and stops itself the
  // moment a poll observes the run has become terminal (no separate
  // "did it just finish" check needed — the effect's own dependency
  // array re-evaluates on every `detail` update and simply doesn't
  // reschedule once `NON_TERMINAL.has(status)` is false).
  // Phase I7 — and only while the tab itself is visible; nothing about
  // a hidden tab lets the operator see the new rows this poll fetches
  // anyway, so there's nothing gained by fetching them.
  useEffect(() => {
    if (!selectedRunId || !detail || !NON_TERMINAL.has(detail.run.status) || !isTabVisible) return;
    const timer = setInterval(() => { refreshDetail(selectedRunId); }, DETAIL_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshDetail is stable per render; polling keys off id + status + tab visibility only
  }, [selectedRunId, detail?.run.status, isTabVisible]);

  const cancel = async (id: string) => {
    setActing(true);
    try {
      const result = await customFetch<{ runId: string; cancelled: boolean }>(
        `/api/admin/mega-engine/workflow/runs/${id}/cancel`, { method: "POST" },
      );
      toast({ title: result.cancelled ? "Run cancelled" : "Run was no longer cancellable", variant: result.cancelled ? undefined : "destructive" });
      await Promise.all([loadRuns(), refreshDetail(id)]);
    } catch {
      toast({ title: "Cancel failed", variant: "destructive" });
    } finally {
      setActing(false);
    }
  };

  const replay = async (id: string) => {
    setActing(true);
    try {
      const result = await customFetch<{ runId: string; newRunId: string }>(
        `/api/admin/mega-engine/workflow/runs/${id}/replay`, { method: "POST" },
      );
      toast({ title: "Replay started", description: `New run: ${result.newRunId}` });
      await loadRuns();
      await openRun(result.newRunId);
    } catch (err) {
      toast({ title: "Replay failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Workflow className="w-5 h-5 text-primary" /> Mega Engine — Workflow Runs
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Inspect, cancel, and replay Workflow engine runs. Each run's step history and
            scheduled <span className="font-mono text-[11px]">workflow.resume</span> wakeup jobs are shown on the detail view.
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-9 gap-2" onClick={loadRuns} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 text-sm w-[180px] bg-background/50"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {RUN_STATUSES.map(s => <SelectItem key={s} value={s} className="font-mono text-xs">{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={definitionId}
            onChange={e => setDefinitionId(e.target.value)}
            placeholder="Filter by definition id"
            className="h-9 text-sm pl-8 w-[220px] bg-background/50"
          />
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={correlationId}
            onChange={e => setCorrelationId(e.target.value)}
            placeholder="Filter by correlation id"
            className="h-9 text-sm pl-8 w-[220px] bg-background/50"
          />
        </div>
      </div>

      {listUpdateAvailable && !loading && (
        <button
          type="button"
          onClick={loadRuns}
          className="w-full flex items-center gap-2 p-2.5 rounded-md border border-primary/20 bg-primary/5 text-xs text-primary hover-elevate text-left"
        >
          <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
          New activity — a run appeared or changed status since this list was last loaded.
          <span className="ml-auto font-medium whitespace-nowrap">Refresh now</span>
        </button>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : runs.length === 0 ? (
        <div className="text-center py-16 text-sm text-muted-foreground">No workflow runs match these filters.</div>
      ) : (
        <div className="border border-border/40 rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Definition</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Current step</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map(r => (
                <TableRow key={r.id} className="cursor-pointer hover-elevate" onClick={() => openRun(r.id)}>
                  <TableCell className="font-mono text-xs">{r.id}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.definitionId} <span className="opacity-60">v{r.definitionVersion}</span></TableCell>
                  <TableCell><StatusBadge status={r.status} map={RUN_BADGE} /></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.currentStepId ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(r.createdAt)}</TableCell>
                  <TableCell><ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={selectedRunId !== null} onOpenChange={(open) => { if (!open) { setSelectedRunId(null); setDetail(null); } }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              <Workflow className="w-4 h-4 text-primary" /> {selectedRunId}
            </DialogTitle>
          </DialogHeader>

          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={detail.run.status} map={RUN_BADGE} />
                <span className="text-xs text-muted-foreground font-mono">{detail.run.definitionId} v{detail.run.definitionVersion}</span>
                {CANCELLABLE.has(detail.run.status) && (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 ml-auto" disabled={acting} onClick={() => cancel(detail.run.id)}>
                    {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} Cancel
                  </Button>
                )}
                {REPLAYABLE.has(detail.run.status) && (
                  <Button size="sm" variant="outline" className={cn("h-7 gap-1.5", !CANCELLABLE.has(detail.run.status) && "ml-auto")} disabled={acting} onClick={() => replay(detail.run.id)}>
                    {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Replay
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div><span className="text-muted-foreground">Current step</span><div className="font-mono">{detail.run.currentStepId ?? "—"}</div></div>
                <div><span className="text-muted-foreground">Correlation id</span><div className="font-mono truncate">{detail.run.correlationId ?? "—"}</div></div>
                <div><span className="text-muted-foreground">Created</span><div>{fmtDate(detail.run.createdAt)}</div></div>
                <div><span className="text-muted-foreground">Started</span><div>{fmtDate(detail.run.startedAt)}</div></div>
                <div><span className="text-muted-foreground">Completed</span><div>{fmtDate(detail.run.completedAt)}</div></div>
                <div><span className="text-muted-foreground">Next resume</span><div>{fmtDate(detail.run.nextResumeAt)}</div></div>
                <div><span className="text-muted-foreground">Causation id</span><div className="font-mono truncate">{detail.run.causationId ?? "—"}</div></div>
                <div><span className="text-muted-foreground">Max runtime</span><div>{detail.run.maxRuntimeMs ? `${detail.run.maxRuntimeMs} ms` : "—"}</div></div>
              </div>

              {detail.run.lastError && (
                <div className="flex items-start gap-2 p-2.5 rounded-md border border-red-500/20 bg-red-400/5 text-xs text-red-400">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> <span className="break-all">{detail.run.lastError}</span>
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5 mb-1.5"><ListTree className="w-3.5 h-3.5" /> Step history</h3>
                {detail.stepRuns.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No step runs recorded yet.</p>
                ) : (
                  <div className="border border-border/40 rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="h-8 text-[11px]">Step</TableHead>
                          <TableHead className="h-8 text-[11px]">Attempt</TableHead>
                          <TableHead className="h-8 text-[11px]">Status</TableHead>
                          <TableHead className="h-8 text-[11px]">Started</TableHead>
                          <TableHead className="h-8 text-[11px]">Finished</TableHead>
                          <TableHead className="h-8 text-[11px]">Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.stepRuns.map(s => (
                          <TableRow key={s.id}>
                            <TableCell className="font-mono text-[11px]">{s.stepId}</TableCell>
                            <TableCell className="text-[11px]">{s.attempt}</TableCell>
                            <TableCell><StatusBadge status={s.status} map={STEP_BADGE} /></TableCell>
                            <TableCell className="text-[11px] text-muted-foreground">{fmtDate(s.startedAt)}</TableCell>
                            <TableCell className="text-[11px] text-muted-foreground">{fmtDate(s.finishedAt)}</TableCell>
                            <TableCell className="text-[11px] text-red-400 max-w-[160px] truncate" title={s.error}>{s.error ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5 mb-1.5"><Timer className="w-3.5 h-3.5" /> workflow.resume jobs</h3>
                {detail.resumeJobs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">This run has never been WAITING — no wakeup job has been scheduled.</p>
                ) : (
                  <div className="border border-border/40 rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="h-8 text-[11px]">Job</TableHead>
                          <TableHead className="h-8 text-[11px]">Status</TableHead>
                          <TableHead className="h-8 text-[11px]">Run at</TableHead>
                          <TableHead className="h-8 text-[11px]">Attempts</TableHead>
                          <TableHead className="h-8 text-[11px]">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.resumeJobs.map(j => (
                          <TableRow key={j.id}>
                            <TableCell className="font-mono text-[11px]">{j.id}</TableCell>
                            <TableCell><StatusBadge status={j.status} map={JOB_BADGE} /></TableCell>
                            <TableCell className="text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDate(j.runAt)}</TableCell>
                            <TableCell className="text-[11px]">{j.attempts} / {j.maxAttempts}</TableCell>
                            <TableCell className="text-[11px] text-muted-foreground">{fmtDate(j.createdAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
