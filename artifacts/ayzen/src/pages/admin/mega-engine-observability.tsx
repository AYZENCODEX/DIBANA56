/**
 * pages/admin/mega-engine-observability.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase I8: the item `mega-engine.tsx`'s own header
 * has carried forward, unchanged, since I4 first named it ("Health/
 * metrics/dead-letters/retention already have working routes on the
 * same router but no screen of their own yet either; that's carried
 * forward untouched, not folded in here") and every phase from I4
 * through I7 repeated verbatim in its own "Still open" list. All four
 * routes (`routes/admin-mega-engine.ts`) have existed since Parts E1-E3
 * — this file is their first renderer.
 *
 * Deliberately ONE page, not four, split into tabs rather than four
 * separate sidebar entries/routes — same "one screen for one coherent
 * slice of the engine" posture `mega-engine.tsx` itself set for the
 * Workflow Runs list+detail pair. Health/Metrics/Dead Letters/Retention
 * are four different reads of the same three subsystems (Event Bus,
 * Scheduler, Workflow), not four unrelated features, so one page with
 * `Tabs` keeps them next to each other the way an operator actually
 * reasons about "is the engine OK" — flip from health to metrics to
 * dead letters without losing place.
 *
 * No polling on any tab, unlike `mega-engine.tsx`'s own I5/I6/I7 —
 * intentionally out of scope for this phase's own narrow slice, same
 * "start with the Refresh button, add polling later if actually asked
 * for" posture `mega-engine.tsx`'s ORIGINAL I4 version took before I5
 * added it. Each tab has its own Refresh; nothing here auto-refreshes.
 */
import { useState, useEffect, useCallback } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Activity, RefreshCw, Loader2, HeartPulse, Gauge, MailWarning, Trash2,
  RotateCcw, Ban, Search, ChevronRight, ChevronDown, Server, ShieldCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ─── Types (mirror lib/mega-engine/engine-health.ts + */metrics.ts + */types.ts + retention.ts JSON shapes) ──

type HealthState = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "DISABLED";

interface ComponentHealth {
  state: HealthState;
  reasons: string[];
}

interface EventBusHealth {
  state: HealthState;
  outbox: ComponentHealth;
  dispatcher: ComponentHealth;
  consumers: ComponentHealth;
  dlq: ComponentHealth;
}

interface SchedulerSubsystemHealth {
  state: HealthState;
  queue: ComponentHealth;
  workers: ComponentHealth;
  lease: ComponentHealth;
  dlq: ComponentHealth;
}

interface WorkflowSubsystemHealth {
  state: HealthState;
  registry: ComponentHealth;
  runner: ComponentHealth;
  checkpoint: ComponentHealth;
  store: ComponentHealth;
}

interface EngineHealth {
  state: HealthState;
  eventBus: EventBusHealth;
  scheduler: SchedulerSubsystemHealth;
  workflow: WorkflowSubsystemHealth;
  checkedAt: string;
}

interface LatencySnapshot {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  avgMs: number | null;
}

interface EventBusMetricsSnapshot {
  published: number;
  dispatched: number;
  handlerFailures: number;
  retried: number;
  deadLettered: number;
  unknownType: number;
  publishLatencyMs: LatencySnapshot;
  handlerLatencyMs: LatencySnapshot;
}

interface SchedulerMetricsSnapshot {
  jobsScheduled: number;
  jobsExecuted: number;
  jobsFailed: number;
  jobsRetried: number;
  jobsDeadLettered: number;
  workerFailures: number;
  workerActive: boolean;
  workerLastHeartbeatAt: string | null;
  schedulerLagMs: LatencySnapshot;
  jobExecutionDurationMs: LatencySnapshot;
}

interface WorkflowMetricsSnapshot {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsTimedOut: number;
  runDurationMs: LatencySnapshot;
  stepDurationMs: LatencySnapshot;
}

interface EngineMetrics {
  eventBus: EventBusMetricsSnapshot;
  scheduler: SchedulerMetricsSnapshot;
  workflow: WorkflowMetricsSnapshot;
}

interface EngineOperations {
  checkedAt: string;
  worker: {
    eventDispatcher: { active: boolean; lastHeartbeatAt: string | null };
    scheduler: { active: boolean; lastHeartbeatAt: string | null };
  };
  queues: {
    eventOutbox: number;
    scheduler: number;
    eventDeadLetter: number;
    schedulerDeadLetter: number;
    workflowWaiting: number;
  };
  latency: { eventProcessingMs: number | null; schedulerLagMs: number | null; workflowMs: number | null };
  retryCounts: { event: number; scheduler: number; workflow: number };
  failureRate: { event: number; scheduler: number; workflow: number };
  capacity: {
    eventBatchSize: number;
    schedulerBatchSize: number;
    eventMaxInFlight: number;
    schedulerMaxInFlight: number;
    retryStormWindowMs: number;
    retryStormLimit: number;
  };
}

interface ReadinessAudit {
  ready: boolean;
  checkedAt: string;
  checks: { name: string; status: "PASS" | "FAIL" | "WARN"; detail: string }[];
}

type DeadLetterStatus = "PENDING" | "REPLAYED" | "DISCARDED";
type DeadLetterEngine = "events" | "jobs";

// Shared fields both dead-letter tables have; `eventId`/`eventType`/`consumer`/
// `envelope` only exist on events, `jobId`/`jobType`/`payload`/`attempts` only
// on jobs — see schema/event-bus.ts's `eventDeadLetterTable` vs
// schema/scheduler.ts's `scheduledJobDeadLetterTable`.
interface DeadLetterRow {
  id: number;
  eventId?: string;
  eventType?: string;
  consumer?: string | null;
  envelope?: Record<string, unknown>;
  jobId?: string;
  jobType?: string;
  payload?: Record<string, unknown> | null;
  attempts?: number;
  attemptCount?: number;
  lastError?: string | null;
  status: DeadLetterStatus;
  failedAt: string;
  resolvedAt?: string | null;
}

// RETENTION_WINDOWS_MS's own key set (retention.ts) — every value in ms.
interface RetentionWindows {
  eventOutboxPublished: number;
  eventProcessed: number;
  deadLetterResolved: number;
  workflowRunTerminal: number;
  scheduledJobAttempt: number;
}

interface RetentionSweepResult {
  eventOutboxDeleted: number;
  eventProcessedDeleted: number;
  eventDeadLetterDeleted: number;
  scheduledJobDeadLetterDeleted: number;
  scheduledJobAttemptDeleted: number;
  workflowRunsDeleted: number;
  workflowStepRunsDeleted: number;
  workflowCheckpointsDeleted: number;
  workflowVariablesDeleted: number;
  ranAt: string;
}

const HEALTH_BADGE: Record<HealthState, string> = {
  HEALTHY: "success", DEGRADED: "warning", UNHEALTHY: "destructive", DISABLED: "secondary",
};
const DLQ_BADGE: Record<DeadLetterStatus, string> = {
  PENDING: "pending", REPLAYED: "success", DISCARDED: "secondary",
};

function StatusBadge<T extends string>({ status, map }: { status: T; map: Record<string, string> }) {
  return <Badge variant={(map[status] ?? "outline") as any} className="text-[10px] font-mono">{status}</Badge>;
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function fmtWindow(ms: number) {
  const days = ms / (24 * 60 * 60 * 1000);
  return Number.isInteger(days) ? `${days} day${days === 1 ? "" : "s"}` : `${(ms / 1000).toFixed(0)}s`;
}

function fmtLatency(snap: LatencySnapshot) {
  if (snap.count === 0) return "no samples yet";
  return `${snap.count} sample${snap.count === 1 ? "" : "s"} · avg ${snap.avgMs!.toFixed(1)}ms (min ${snap.minMs!.toFixed(1)} / max ${snap.maxMs!.toFixed(1)})`;
}

const RETENTION_LABELS: Record<keyof RetentionWindows, string> = {
  eventOutboxPublished: "Event outbox (PUBLISHED rows)",
  eventProcessed: "Event idempotency records",
  deadLetterResolved: "Dead letters (REPLAYED/DISCARDED, both engines)",
  workflowRunTerminal: "Workflow runs (terminal status)",
  scheduledJobAttempt: "Scheduler attempt log rows",
};

// ─── Health leaf row ──────────────────────────────────────────────────────
function LeafRow({ label, health }: { label: string; health: ComponentHealth }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/30 last:border-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex-1" />
      <div className="flex flex-col items-end gap-1 max-w-[60%]">
        <StatusBadge status={health.state} map={HEALTH_BADGE} />
        {health.reasons.map((r, i) => (
          <div key={i} className="text-[11px] text-muted-foreground text-right">{r}</div>
        ))}
      </div>
    </div>
  );
}

function SubsystemCard({ title, state, leaves }: { title: string; state: HealthState; leaves: [string, ComponentHealth][] }) {
  return (
    <Card className="bg-card border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          {title} <StatusBadge status={state} map={HEALTH_BADGE} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {leaves.map(([label, h]) => <LeafRow key={label} label={label} health={h} />)}
      </CardContent>
    </Card>
  );
}

function MetricStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-mono">{value}</div>
    </div>
  );
}

function MetricsCard({ title, counters, latencies }: {
  title: string;
  counters: [string, number][];
  latencies: [string, LatencySnapshot][];
}) {
  return (
    <Card className="bg-card border-border/60">
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          {counters.map(([label, v]) => <MetricStat key={label} label={label} value={v} />)}
        </div>
        <div className="space-y-1.5 pt-1 border-t border-border/30">
          {latencies.map(([label, snap]) => (
            <div key={label} className="text-[11px]"><span className="text-muted-foreground">{label}:</span> {fmtLatency(snap)}</div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminMegaEngineObservabilityPage() {
  const { toast } = useToast();

  // ── Health ──────────────────────────────────────────────────────────────
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const data = await customFetch<EngineHealth>("/api/admin/mega-engine/health");
      setHealth(data);
    } catch {
      toast({ title: "Failed to load engine health", variant: "destructive" });
    } finally {
      setHealthLoading(false);
    }
  }, [toast]);
  useEffect(() => { loadHealth(); }, [loadHealth]);

  // ── Metrics ─────────────────────────────────────────────────────────────
  const [metrics, setMetrics] = useState<EngineMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const data = await customFetch<EngineMetrics>("/api/admin/mega-engine/metrics");
      setMetrics(data);
    } catch {
      toast({ title: "Failed to load engine metrics", variant: "destructive" });
    } finally {
      setMetricsLoading(false);
    }
  }, [toast]);
  useEffect(() => { loadMetrics(); }, [loadMetrics]);

  // J10/J15 — live operator snapshot and final readiness gate.
  const [operations, setOperations] = useState<EngineOperations | null>(null);
  const [readiness, setReadiness] = useState<ReadinessAudit | null>(null);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const loadOperations = useCallback(async () => {
    setOperationsLoading(true);
    try {
      const [live, audit] = await Promise.all([
        customFetch<EngineOperations>("/api/admin/mega-engine/operations"),
        customFetch<ReadinessAudit>("/api/admin/mega-engine/readiness").catch(() => null),
      ]);
      setOperations(live);
      if (audit) setReadiness(audit);
    } catch {
      toast({ title: "Failed to load live operations", variant: "destructive" });
    } finally {
      setOperationsLoading(false);
    }
  }, [toast]);
  useEffect(() => {
    loadOperations();
    const timer = setInterval(loadOperations, 5000);
    return () => clearInterval(timer);
  }, [loadOperations]);

  // ── Dead letters ────────────────────────────────────────────────────────
  const [dlEngine, setDlEngine] = useState<DeadLetterEngine>("events");
  const [dlStatus, setDlStatus] = useState<string>("PENDING");
  const [dlType, setDlType] = useState("");
  const [deadLetters, setDeadLetters] = useState<DeadLetterRow[]>([]);
  const [dlLoading, setDlLoading] = useState(true);
  const [dlActing, setDlActing] = useState<number | null>(null);

  const loadDeadLetters = useCallback(async () => {
    setDlLoading(true);
    try {
      const params = new URLSearchParams();
      if (dlStatus !== "all") params.set("status", dlStatus);
      if (dlType.trim()) params.set("type", dlType.trim());
      const data = await customFetch<{ engine: DeadLetterEngine; deadLetters: DeadLetterRow[] }>(
        `/api/admin/mega-engine/dead-letters/${dlEngine}?${params.toString()}`,
      );
      setDeadLetters(Array.isArray(data?.deadLetters) ? data.deadLetters : []);
    } catch {
      toast({ title: "Failed to load dead letters", variant: "destructive" });
      setDeadLetters([]);
    } finally {
      setDlLoading(false);
    }
  }, [dlEngine, dlStatus, dlType, toast]);
  useEffect(() => { loadDeadLetters(); }, [loadDeadLetters]);

  const replayDeadLetter = async (id: number) => {
    setDlActing(id);
    try {
      await customFetch(`/api/admin/mega-engine/dead-letters/${dlEngine}/${id}/replay`, { method: "POST" });
      toast({ title: "Replayed", description: `Dead letter #${id} re-queued as a new row.` });
      await loadDeadLetters();
    } catch (err) {
      toast({ title: "Replay failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setDlActing(null);
    }
  };

  const discardDeadLetter = async (id: number) => {
    setDlActing(id);
    try {
      await customFetch(`/api/admin/mega-engine/dead-letters/${dlEngine}/${id}/discard`, { method: "POST" });
      toast({ title: "Discarded", description: `Dead letter #${id} marked DISCARDED.` });
      await loadDeadLetters();
    } catch {
      toast({ title: "Discard failed", variant: "destructive" });
    } finally {
      setDlActing(null);
    }
  };

  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // ── Retention ───────────────────────────────────────────────────────────
  const [windowsMs, setWindowsMs] = useState<RetentionWindows | null>(null);
  const [windowsLoading, setWindowsLoading] = useState(true);
  const loadWindows = useCallback(async () => {
    setWindowsLoading(true);
    try {
      const data = await customFetch<{ windowsMs: RetentionWindows }>("/api/admin/mega-engine/retention");
      setWindowsMs(data?.windowsMs ?? null);
    } catch {
      toast({ title: "Failed to load retention windows", variant: "destructive" });
    } finally {
      setWindowsLoading(false);
    }
  }, [toast]);
  useEffect(() => { loadWindows(); }, [loadWindows]);

  const [sweepConfirmOpen, setSweepConfirmOpen] = useState(false);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [lastSweep, setLastSweep] = useState<RetentionSweepResult | null>(null);
  const runSweep = async () => {
    setSweepRunning(true);
    try {
      const result = await customFetch<RetentionSweepResult>("/api/admin/mega-engine/retention/run", { method: "POST" });
      setLastSweep(result);
      toast({ title: "Retention sweep complete" });
    } catch {
      toast({ title: "Retention sweep failed", variant: "destructive" });
    } finally {
      setSweepRunning(false);
      setSweepConfirmOpen(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" /> Mega Engine — Health &amp; Retention
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Engine health, in-process metrics, dead letters, and retention windows across the
          Event Bus, Scheduler, and Workflow engines.
        </p>
      </div>

      <Tabs defaultValue="health">
        <TabsList>
          <TabsTrigger value="health" className="gap-1.5"><HeartPulse className="w-3.5 h-3.5" /> Health</TabsTrigger>
          <TabsTrigger value="metrics" className="gap-1.5"><Gauge className="w-3.5 h-3.5" /> Metrics</TabsTrigger>
          <TabsTrigger value="operations" className="gap-1.5"><Server className="w-3.5 h-3.5" /> Operations</TabsTrigger>
          <TabsTrigger value="dead-letters" className="gap-1.5"><MailWarning className="w-3.5 h-3.5" /> Dead Letters</TabsTrigger>
          <TabsTrigger value="retention" className="gap-1.5"><Trash2 className="w-3.5 h-3.5" /> Retention</TabsTrigger>
        </TabsList>

        {/* ── Health ── */}
        <TabsContent value="health" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {health && <StatusBadge status={health.state} map={HEALTH_BADGE} />}
              <span className="text-xs text-muted-foreground">
                {health ? `Checked ${fmtDate(health.checkedAt)}` : healthLoading ? "Loading…" : "—"}
              </span>
            </div>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={loadHealth} disabled={healthLoading}>
              {healthLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
            </Button>
          </div>

          {healthLoading && !health ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : health ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SubsystemCard title="Event Bus" state={health.eventBus.state} leaves={[
                ["Outbox", health.eventBus.outbox],
                ["Dispatcher", health.eventBus.dispatcher],
                ["Consumers", health.eventBus.consumers],
                ["Dead-letter queue", health.eventBus.dlq],
              ]} />
              <SubsystemCard title="Scheduler" state={health.scheduler.state} leaves={[
                ["Queue", health.scheduler.queue],
                ["Workers", health.scheduler.workers],
                ["Lease", health.scheduler.lease],
                ["Dead-letter queue", health.scheduler.dlq],
              ]} />
              <SubsystemCard title="Workflow" state={health.workflow.state} leaves={[
                ["Registry", health.workflow.registry],
                ["Runner", health.workflow.runner],
                ["Checkpoint", health.workflow.checkpoint],
                ["Store", health.workflow.store],
              ]} />
            </div>
          ) : null}
        </TabsContent>

        {/* ── Metrics ── */}
        <TabsContent value="metrics" className="space-y-4 mt-4">
          <div className="flex items-center justify-end">
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={loadMetrics} disabled={metricsLoading}>
              {metricsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
            </Button>
          </div>

          {metricsLoading && !metrics ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : metrics ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <MetricsCard
                title="Event Bus"
                counters={[
                  ["Published", metrics.eventBus.published],
                  ["Dispatched", metrics.eventBus.dispatched],
                  ["Handler failures", metrics.eventBus.handlerFailures],
                  ["Retried", metrics.eventBus.retried],
                  ["Dead-lettered", metrics.eventBus.deadLettered],
                  ["Unknown type", metrics.eventBus.unknownType],
                ]}
                latencies={[
                  ["Publish latency", metrics.eventBus.publishLatencyMs],
                  ["Handler latency", metrics.eventBus.handlerLatencyMs],
                ]}
              />
              <MetricsCard
                title="Scheduler"
                counters={[
                  ["Scheduled", metrics.scheduler.jobsScheduled],
                  ["Executed", metrics.scheduler.jobsExecuted],
                  ["Failed", metrics.scheduler.jobsFailed],
                  ["Retried", metrics.scheduler.jobsRetried],
                  ["Dead-lettered", metrics.scheduler.jobsDeadLettered],
                  ["Worker failures", metrics.scheduler.workerFailures],
                ]}
                latencies={[
                  ["Scheduler lag", metrics.scheduler.schedulerLagMs],
                  ["Job execution", metrics.scheduler.jobExecutionDurationMs],
                ]}
              />
              <MetricsCard
                title="Workflow"
                counters={[
                  ["Started", metrics.workflow.runsStarted],
                  ["Completed", metrics.workflow.runsCompleted],
                  ["Failed", metrics.workflow.runsFailed],
                  ["Timed out", metrics.workflow.runsTimedOut],
                ]}
                latencies={[
                  ["Run duration", metrics.workflow.runDurationMs],
                  ["Step duration", metrics.workflow.stepDurationMs],
                ]}
              />
              <Card className="bg-card border-border/60 md:col-span-3">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Scheduler worker</CardTitle></CardHeader>
                <CardContent className="flex items-center gap-6">
                  <MetricStat label="Active right now" value={metrics.scheduler.workerActive ? "yes" : "no"} />
                  <MetricStat label="Last heartbeat" value={fmtDate(metrics.scheduler.workerLastHeartbeatAt)} />
                </CardContent>
              </Card>
            </div>
          ) : null}
        </TabsContent>

        {/* ── Operations / readiness ── */}
        <TabsContent value="operations" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {operations ? `Updated ${fmtDate(operations.checkedAt)}` : operationsLoading ? "Loading…" : "—"}
            </div>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={loadOperations} disabled={operationsLoading}>
              {operationsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
            </Button>
          </div>
          {operations ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {([
                  ["Event outbox", operations.queues.eventOutbox],
                  ["Scheduler queue", operations.queues.scheduler],
                  ["Waiting workflows", operations.queues.workflowWaiting],
                  ["Event DLQ", operations.queues.eventDeadLetter],
                  ["Job DLQ", operations.queues.schedulerDeadLetter],
                ] as [string, number][]).map(([label, value]) => (
                  <Card key={label} className="bg-card border-border/60">
                    <CardContent className="pt-4"><MetricStat label={label} value={value} /></CardContent>
                  </Card>
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="bg-card border-border/60">
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Workers and latency</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <div className="flex justify-between"><span>Event dispatcher</span><StatusBadge status={operations.worker.eventDispatcher.active ? "ACTIVE" : "IDLE"} map={{ ACTIVE: "success", IDLE: "secondary" }} /></div>
                    <div className="flex justify-between"><span>Scheduler worker</span><StatusBadge status={operations.worker.scheduler.active ? "ACTIVE" : "IDLE"} map={{ ACTIVE: "success", IDLE: "secondary" }} /></div>
                    <div className="flex justify-between"><span>Event processing</span><span className="font-mono">{operations.latency.eventProcessingMs == null ? "—" : `${operations.latency.eventProcessingMs.toFixed(1)} ms`}</span></div>
                    <div className="flex justify-between"><span>Scheduler lag</span><span className="font-mono">{operations.latency.schedulerLagMs == null ? "—" : `${operations.latency.schedulerLagMs.toFixed(1)} ms`}</span></div>
                    <div className="flex justify-between"><span>Workflow latency</span><span className="font-mono">{operations.latency.workflowMs == null ? "—" : `${operations.latency.workflowMs.toFixed(1)} ms`}</span></div>
                  </CardContent>
                </Card>
                <Card className="bg-card border-border/60">
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Capacity and failure rate</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <div className="flex justify-between"><span>Event / scheduler batch</span><span className="font-mono">{operations.capacity.eventBatchSize} / {operations.capacity.schedulerBatchSize}</span></div>
                    <div className="flex justify-between"><span>Retries (event / job / workflow)</span><span className="font-mono">{operations.retryCounts.event} / {operations.retryCounts.scheduler} / {operations.retryCounts.workflow}</span></div>
                    <div className="flex justify-between"><span>Failure rate</span><span className="font-mono">{(operations.failureRate.event * 100).toFixed(1)}% / {(operations.failureRate.scheduler * 100).toFixed(1)}% / {(operations.failureRate.workflow * 100).toFixed(1)}%</span></div>
                    <div className="flex justify-between"><span>Retry storm limit</span><span className="font-mono">{operations.capacity.retryStormLimit} / {operations.capacity.retryStormWindowMs}ms</span></div>
                  </CardContent>
                </Card>
              </div>
              {readiness && (
                <Card className="bg-card border-border/60">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> Production readiness audit <StatusBadge status={readiness.ready ? "READY" : "BLOCKED"} map={{ READY: "success", BLOCKED: "destructive" }} /></CardTitle></CardHeader>
                  <CardContent className="space-y-1.5">
                    {readiness.checks.map(check => (
                      <div key={check.name} className="flex items-start gap-2 text-xs">
                        <StatusBadge status={check.status} map={{ PASS: "success", WARN: "warning", FAIL: "destructive" }} />
                        <span className="font-mono w-28">{check.name}</span>
                        <span className="text-muted-foreground">{check.detail}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          ) : operationsLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : null}
        </TabsContent>

        {/* ── Dead letters ── */}
        <TabsContent value="dead-letters" className="space-y-4 mt-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={dlEngine} onValueChange={(v) => setDlEngine(v as DeadLetterEngine)}>
              <SelectTrigger className="h-9 text-sm w-[140px] bg-background/50"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="events">Events</SelectItem>
                <SelectItem value="jobs">Jobs</SelectItem>
              </SelectContent>
            </Select>
            <Select value={dlStatus} onValueChange={setDlStatus}>
              <SelectTrigger className="h-9 text-sm w-[160px] bg-background/50"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="PENDING" className="font-mono text-xs">PENDING</SelectItem>
                <SelectItem value="REPLAYED" className="font-mono text-xs">REPLAYED</SelectItem>
                <SelectItem value="DISCARDED" className="font-mono text-xs">DISCARDED</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={dlType}
                onChange={e => setDlType(e.target.value)}
                placeholder={dlEngine === "events" ? "Filter by event type" : "Filter by job type"}
                className="h-9 text-sm pl-8 w-[220px] bg-background/50"
              />
            </div>
            <Button size="sm" variant="outline" className="h-9 gap-1.5 ml-auto" onClick={loadDeadLetters} disabled={dlLoading}>
              {dlLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
            </Button>
          </div>

          {dlLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : deadLetters.length === 0 ? (
            <div className="text-center py-16 text-sm text-muted-foreground">No dead letters match these filters.</div>
          ) : (
            <div className="border border-border/40 rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>ID</TableHead>
                    <TableHead>{dlEngine === "events" ? "Event type" : "Job type"}</TableHead>
                    {dlEngine === "events" && <TableHead>Consumer</TableHead>}
                    <TableHead>Attempts</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Failed</TableHead>
                    <TableHead>Resolved</TableHead>
                    <TableHead className="w-40" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deadLetters.map(row => (
                    <>
                      <TableRow key={row.id} className="cursor-pointer hover-elevate" onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}>
                        <TableCell>{expandedRow === row.id ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}</TableCell>
                        <TableCell className="font-mono text-xs">{row.id}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{dlEngine === "events" ? row.eventType : row.jobType}</TableCell>
                        {dlEngine === "events" && <TableCell className="font-mono text-xs text-muted-foreground">{row.consumer ?? "—"}</TableCell>}
                        <TableCell className="text-xs">{row.attemptCount ?? row.attempts ?? "—"}</TableCell>
                        <TableCell><StatusBadge status={row.status} map={DLQ_BADGE} /></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(row.failedAt)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(row.resolvedAt)}</TableCell>
                        <TableCell onClick={e => e.stopPropagation()}>
                          {row.status === "PENDING" && (
                            <div className="flex items-center gap-1.5 justify-end">
                              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={dlActing === row.id} onClick={() => replayDeadLetter(row.id)}>
                                {dlActing === row.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Replay
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={dlActing === row.id} onClick={() => discardDeadLetter(row.id)}>
                                {dlActing === row.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Discard
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {expandedRow === row.id && (
                        <TableRow key={`${row.id}-detail`}>
                          <TableCell colSpan={dlEngine === "events" ? 9 : 8} className="bg-background/40">
                            <div className="space-y-2 py-1">
                              {row.lastError && (
                                <div className="text-xs text-red-400 break-all"><span className="text-muted-foreground">Last error:</span> {row.lastError}</div>
                              )}
                              <pre className="text-[11px] font-mono bg-black/20 rounded-md p-2.5 overflow-x-auto max-h-64">
                                {JSON.stringify(dlEngine === "events" ? row.envelope : row.payload, null, 2)}
                              </pre>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ── Retention ── */}
        <TabsContent value="retention" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Configured windows</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={loadWindows} disabled={windowsLoading}>
                {windowsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
              </Button>
              <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={sweepRunning} onClick={() => setSweepConfirmOpen(true)}>
                {sweepRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Run sweep now
              </Button>
            </div>
          </div>

          {windowsLoading && !windowsMs ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : windowsMs ? (
            <div className="border border-border/40 rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Table</TableHead><TableHead>Window</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {(Object.keys(RETENTION_LABELS) as (keyof RetentionWindows)[]).map(key => (
                    <TableRow key={key}>
                      <TableCell className="text-xs">{RETENTION_LABELS[key]}</TableCell>
                      <TableCell className="text-xs font-mono">{fmtWindow(windowsMs[key])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {lastSweep && (
            <Card className="bg-card border-border/60">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Last sweep — {fmtDate(lastSweep.ranAt)}</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricStat label="Event outbox rows" value={lastSweep.eventOutboxDeleted} />
                <MetricStat label="Event idempotency rows" value={lastSweep.eventProcessedDeleted} />
                <MetricStat label="Event dead letters" value={lastSweep.eventDeadLetterDeleted} />
                <MetricStat label="Job dead letters" value={lastSweep.scheduledJobDeadLetterDeleted} />
                <MetricStat label="Job attempt rows" value={lastSweep.scheduledJobAttemptDeleted} />
                <MetricStat label="Workflow runs" value={lastSweep.workflowRunsDeleted} />
                <MetricStat label="Workflow step runs" value={lastSweep.workflowStepRunsDeleted} />
                <MetricStat label="Workflow checkpoints" value={lastSweep.workflowCheckpointsDeleted} />
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={sweepConfirmOpen} onOpenChange={setSweepConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Run retention sweep now?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              Permanently deletes every row past its own configured window across all three engines
              (see the windows above). This is the same sweep that already runs daily at 03:00 UTC —
              this just triggers it out-of-band. Audit records are never touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runSweep} className="text-xs bg-red-500/90 hover:bg-red-500 text-white">Run sweep</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
