import { useEffect, useMemo, useState } from "react";
import { useListVaultEntries } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  Shield, TrendingUp, TrendingDown, CheckCircle2, Clock, DollarSign, Loader2, Layers,
  AlertTriangle, Flag, ShieldAlert, ShieldCheck, RefreshCw, Percent,
  History, ChevronDown, ChevronUp, Gift, LogIn, LogOut, Ban, XCircle,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
  LineChart, Line, CartesianGrid,
} from "recharts";
import {
  computeEntityWorth, computeEntityBuyValue, computeEntityProfit, computeEntityProfitPct,
} from "@/lib/entity-worth";
import { ValuePnlPanel } from "@/components/value-pnl-panel";

type EntryAny = any;

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";

async function getJson(path: string) {
  try {
    const res = await fetch(`${BASE}/api${path}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function postJson(path: string, body?: unknown) {
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const PIE_COLORS = ["#34d399", "#fbbf24", "#f87171", "#60a5fa", "#a78bfa", "#f472b6"];

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

// ─── Overview tab ─────────────────────────────────────────────────────────────
function OverviewTab({ entries, leaderboard, loading }: { entries: EntryAny[]; leaderboard: any[] | null; loading: boolean }) {
  const totalValue = entries.reduce((s, e) => s + computeEntityWorth(e), 0);
  const completedProjects = (leaderboard ?? []).reduce((s, e) => s + (e.completedProjects ?? 0), 0);
  const ongoingProjects = (leaderboard ?? []).reduce((s, e) => s + (e.ongoingProjects ?? 0), 0);

  const pieData = [
    { name: "Completed", value: completedProjects },
    { name: "Ongoing", value: ongoingProjects },
  ].filter(d => d.value > 0);

  const barData = [...(leaderboard ?? [])]
    .sort((a, b) => (b.totalRoi ?? 0) - (a.totalRoi ?? 0))
    .slice(0, 8)
    .map(e => ({ name: e.entityName ?? e.entitySerial ?? `#${e.vaultEntryId}`, roi: Number((e.totalRoi ?? 0).toFixed(2)) }));

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ValuePnlPanel />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Enrolled Entities" value={String(entries.length)} icon={Shield} color="text-primary" />
        <StatCard label="Completed Projects" value={String(completedProjects)} icon={CheckCircle2} color="text-emerald-400" />
        <StatCard label="Ongoing Projects" value={String(ongoingProjects)} icon={Clock} color="text-amber-400" />
        <StatCard label="Total Value" value={`$${totalValue.toFixed(0)}`} icon={DollarSign} color="text-cyan-400" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {pieData.length > 0 && (
          <div className="bg-card border border-card-border rounded-xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Project Progress</p>
            <div className="flex items-center gap-4">
              <div className="w-[110px] h-[110px] flex-shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" innerRadius={34} outerRadius={52} paddingAngle={3} strokeWidth={0}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.name === "Completed" ? "#34d399" : "#fbbf24"} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 10, fontFamily: "monospace" }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-1.5">
                {pieData.map(d => (
                  <div key={d.name} className="flex items-center gap-1.5 font-mono text-[10px]">
                    <span className={cn("w-2 h-2 rounded-full", d.name === "Completed" ? "bg-emerald-400" : "bg-amber-400")} />
                    <span className="text-muted-foreground/70">{d.name}</span>
                    <span className="font-bold text-foreground">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {barData.length > 0 && (
          <div className="bg-card border border-card-border rounded-xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">ROI by Entity (top 8)</p>
            <div className="h-[110px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <XAxis dataKey="name" hide />
                  <Bar dataKey="roi" radius={[3, 3, 0, 0]}>
                    {barData.map((d, i) => <Cell key={i} fill={d.roi >= 0 ? "#34d399" : "#f87171"} />)}
                  </Bar>
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 10, fontFamily: "monospace" }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {entries.length === 0 && (
        <div className="text-center py-16 text-muted-foreground/50 font-mono text-xs">No entities enrolled yet</div>
      )}
    </div>
  );
}

// ─── Activity log timeline (Phase 4) ───────────────────────────────────────
// Renders the enrolled/left/reward event history for one entity↔project
// enrollment, plus totals (days active, total reward, reward/day) — all
// computed server-side from the shared activity_log table, never stored.
const ACTIVITY_ACTION_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  enrolled: { label: "Enrolled", icon: LogIn, color: "text-sky-400" },
  left: { label: "Left project", icon: LogOut, color: "text-muted-foreground" },
  reward: { label: "Reward", icon: Gift, color: "text-emerald-400" },
  disqualified: { label: "Disqualified", icon: XCircle, color: "text-amber-400" },
  banned: { label: "Banned", icon: Ban, color: "text-red-400" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "text-muted-foreground" },
};

function ActivityLogPanel({ enrollmentId }: { enrollmentId: number }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson(`/projects/enrollments/${enrollmentId}/activity`).then(d => {
      if (!cancelled) { setData(d); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [enrollmentId]);

  if (loading) {
    return <div className="flex items-center justify-center py-6"><Loader2 className="w-4 h-4 text-primary animate-spin" /></div>;
  }
  if (!data || !data.entries?.length) {
    return <p className="font-mono text-[9px] text-muted-foreground/40 py-3 text-center">No activity recorded yet</p>;
  }

  const { entries, totals } = data;

  return (
    <div className="pt-3 mt-3 border-t border-card-border/60 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-background/40 rounded-lg p-2 text-center">
          <p className="font-mono text-xs font-bold text-foreground">{totals.daysActive}</p>
          <p className="font-mono text-[8px] text-muted-foreground/50 uppercase">Days active</p>
        </div>
        <div className="bg-background/40 rounded-lg p-2 text-center">
          <p className="font-mono text-xs font-bold text-emerald-400">${totals.totalReward.toFixed(2)}</p>
          <p className="font-mono text-[8px] text-muted-foreground/50 uppercase">Total reward</p>
        </div>
        <div className="bg-background/40 rounded-lg p-2 text-center">
          <p className="font-mono text-xs font-bold text-primary">{totals.rewardPerDay === null ? "—" : `$${totals.rewardPerDay.toFixed(2)}`}</p>
          <p className="font-mono text-[8px] text-muted-foreground/50 uppercase">Reward / day</p>
        </div>
      </div>
      <div className="space-y-1.5 max-h-56 overflow-y-auto">
        {[...entries].reverse().map((e: any) => {
          const meta = ACTIVITY_ACTION_META[e.action] ?? { label: e.action, icon: History, color: "text-muted-foreground" };
          const Icon = meta.icon;
          return (
            <div key={e.id} className="flex items-center gap-2 font-mono text-[9px]">
              <Icon className={cn("w-3 h-3 flex-shrink-0", meta.color)} />
              <span className="text-foreground/70 flex-1">{meta.label}</span>
              {e.amount !== null && <span className="text-emerald-400">+${Number(e.amount).toFixed(2)}</span>}
              <span className="text-muted-foreground/40">{new Date(e.createdAt).toLocaleDateString()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Project tab ──────────────────────────────────────────────────────────────
function ProjectTab({ vaultEntryId, leaderboard, loading }: { vaultEntryId?: number; leaderboard: any[] | null; loading: boolean }) {
  const [projects, setProjects] = useState<any[] | null>(null);
  const [projLoading, setProjLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpanded = (projectId: number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
    return next;
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setProjLoading(true);
      if (vaultEntryId) {
        const data = await getJson(`/projects/entity/${vaultEntryId}/overview`);
        if (!cancelled) setProjects(data?.projects ?? []);
      } else {
        // Aggregate across every entity — roll up per project across the whole vault.
        const rows = leaderboard ?? [];
        const overviews = await Promise.all(rows.map(r => getJson(`/projects/entity/${r.vaultEntryId}/overview`)));
        if (cancelled) return;
        const byProject = new Map<number, any>();
        overviews.forEach(o => {
          for (const p of (o?.projects ?? [])) {
            const existing = byProject.get(p.projectId);
            if (existing) {
              existing.entities += 1;
              existing.completedTasks += p.completedTasks;
              existing.totalTasks += p.totalTasks;
              existing.totalProfit += p.totalProfit;
              existing.totalCost += p.totalCost;
            } else {
              byProject.set(p.projectId, { ...p, entities: 1 });
            }
          }
        });
        setProjects([...byProject.values()].map(p => ({
          ...p,
          progress: p.totalTasks > 0 ? Math.round((p.completedTasks / p.totalTasks) * 100) : 0,
        })));
      }
      setProjLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [vaultEntryId, leaderboard]);

  if (loading || projLoading || projects === null) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;

  if (projects.length === 0) {
    return <div className="text-center py-16 text-muted-foreground/50 font-mono text-xs">No project enrollments yet</div>;
  }

  return (
    <div className="space-y-2">
      {[...projects].sort((a, b) => b.progress - a.progress).map(p => (
        <div key={p.projectId} className="bg-card border border-card-border rounded-xl p-3.5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-bold text-foreground truncate">{p.projectName}</p>
              <p className="font-mono text-[9px] text-muted-foreground/50">
                {p.category ?? "—"} · {p.completedTasks}/{p.totalTasks} tasks
                {p.entities ? ` · ${p.entities} ${p.entities === 1 ? "entity" : "entities"}` : ""}
                {p.enrollmentStatus && (
                  <Badge variant="outline" className={cn("ml-1.5 font-mono text-[8px] px-1 py-0 border", p.enrollmentStatus === "completed" ? "text-emerald-400 border-emerald-400/30" : "text-amber-400 border-amber-400/30")}>
                    {p.enrollmentStatus === "completed" ? "Completed" : "Ongoing"}
                  </Badge>
                )}
              </p>
            </div>
            <span className={cn("font-mono text-xs font-bold flex-shrink-0", p.progress >= 100 ? "text-emerald-400" : "text-primary")}>{p.progress}%</span>
          </div>
          <Progress value={p.progress} className="h-1.5" />
          <div className="flex items-center gap-3 mt-2 font-mono text-[9px]">
            <span className="text-emerald-400">+${Number(p.totalProfit ?? 0).toFixed(2)}</span>
            <span className="text-red-400">-${Number(p.totalCost ?? 0).toFixed(2)}</span>
            <span className={cn("font-bold", (p.totalProfit - p.totalCost) >= 0 ? "text-emerald-400" : "text-red-400")}>
              ROI {(p.totalProfit - p.totalCost) >= 0 ? "+" : ""}${(p.totalProfit - p.totalCost).toFixed(2)}
            </span>
            {/* Phase 4 — per-entity activity log (enroll/leave/reward history + totals).
                Only meaningful in single-entity mode, where one project row maps to
                exactly one enrollment; the aggregate (all-entities) view skips this. */}
            {vaultEntryId && p.enrollmentId && (
              <button
                onClick={() => toggleExpanded(p.projectId)}
                className="ml-auto flex items-center gap-1 text-muted-foreground/50 hover:text-foreground transition-colors"
              >
                <History className="w-3 h-3" />
                {expanded.has(p.projectId) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
          </div>
          {vaultEntryId && p.enrollmentId && expanded.has(p.projectId) && (
            <ActivityLogPanel enrollmentId={p.enrollmentId} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── PnL tab ──────────────────────────────────────────────────────────────────
function PnlTab({ entries }: { entries: EntryAny[] }) {
  const totalBuy = entries.reduce((s, e) => s + computeEntityBuyValue(e), 0);
  const totalWorth = entries.reduce((s, e) => s + computeEntityWorth(e), 0);
  const totalProfit = totalWorth - totalBuy;
  const totalPct = totalBuy > 0 ? (totalProfit / totalBuy) * 100 : null;

  const byProject = useMemo(() => {
    const map = new Map<string, { buy: number; worth: number }>();
    for (const e of entries) {
      const key = e.projectName ?? "Untitled";
      const cur = map.get(key) ?? { buy: 0, worth: 0 };
      cur.buy += computeEntityBuyValue(e);
      cur.worth += computeEntityWorth(e);
      map.set(key, cur);
    }
    return [...map.entries()].map(([projectName, v]) => ({
      projectName, ...v, profit: v.worth - v.buy,
      pct: v.buy > 0 ? ((v.worth - v.buy) / v.buy) * 100 : null,
    })).sort((a, b) => b.profit - a.profit);
  }, [entries]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Buy Value" value={`$${totalBuy.toFixed(0)}`} icon={DollarSign} color="text-muted-foreground" />
        <StatCard label="Present Value" value={`$${totalWorth.toFixed(0)}`} icon={DollarSign} color="text-amber-400" />
        <StatCard
          label="Total Profit"
          value={`${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(0)}`}
          icon={totalProfit >= 0 ? TrendingUp : TrendingDown}
          color={totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}
        />
        <StatCard
          label="PnL %"
          value={totalPct === null ? "—" : `${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(1)}%`}
          icon={Layers}
          color={totalPct === null ? "text-muted-foreground" : totalPct >= 0 ? "text-emerald-400" : "text-red-400"}
        />
      </div>

      <div className="bg-card border border-card-border rounded-xl p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-3">PnL by Project</p>
        {byProject.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground/50 text-center py-6">No buy value / worth recorded yet</p>
        ) : (
          <div className="space-y-2.5">
            {byProject.map(c => (
              <div key={c.projectName} className="flex items-center gap-3">
                <span className="font-mono text-[10px] text-foreground/80 w-24 truncate flex-shrink-0">{c.projectName}</span>
                <div className="flex-1 h-1.5 bg-muted/20 rounded-full overflow-hidden">
                  <div
                    className={cn("h-full rounded-full", c.profit >= 0 ? "bg-emerald-400" : "bg-red-400")}
                    style={{ width: `${Math.min(100, Math.abs(c.pct ?? 0))}%` }}
                  />
                </div>
                <span className={cn("font-mono text-[10px] font-bold w-20 text-right flex-shrink-0", c.profit >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {c.profit >= 0 ? "+" : ""}${c.profit.toFixed(0)} {c.pct !== null ? `(${c.pct >= 0 ? "+" : ""}${c.pct.toFixed(0)}%)` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">Per-Entity PnL</p>
          {entries.map(e => {
            const buy = computeEntityBuyValue(e);
            const worth = computeEntityWorth(e);
            const profit = computeEntityProfit(e);
            const pct = computeEntityProfitPct(e);
            return (
              <div key={e.id} className="flex items-center gap-3 bg-card border border-card-border rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs font-medium text-foreground truncate">{e.projectName}</p>
                  <p className="font-mono text-[9px] text-muted-foreground/50">Buy ${buy.toFixed(0)} → Worth ${worth.toFixed(0)}</p>
                </div>
                <span className={cn("font-mono text-xs font-bold flex-shrink-0", profit >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {profit >= 0 ? "+" : ""}${profit.toFixed(0)}{pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Health tab ────────────────────────────────────────────────────────────────
const SEVERITY_STYLE: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  alert: { icon: ShieldAlert, color: "text-red-400 border-red-400/30 bg-red-400/5", label: "Alert" },
  warn: { icon: AlertTriangle, color: "text-amber-400 border-amber-400/30 bg-amber-400/5", label: "Warning" },
  flag: { icon: Flag, color: "text-muted-foreground border-border bg-muted/10", label: "Flag" },
};

function HealthTab() {
  const [report, setReport] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await getJson("/vault/health-report");
    setReport(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const runCheck = async () => {
    setChecking(true);
    await postJson("/vault/health-check");
    await load();
    setChecking(false);
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  if (!report) return <div className="text-center py-16 text-muted-foreground/50 font-mono text-xs">Health report unavailable</div>;

  const { totalEntries, counts, flaggedEntries } = report;
  const healthyCount = Math.max(0, totalEntries - (flaggedEntries?.length ?? 0));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
          {healthyCount}/{totalEntries} entities healthy
        </p>
        <Button size="sm" variant="outline" onClick={runCheck} disabled={checking} className="font-mono text-xs gap-1.5 h-7">
          {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Run Health Check
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Low Score" value={String(counts.lowScore)} icon={ShieldAlert} color={counts.lowScore > 0 ? "text-red-400" : "text-emerald-400"} />
        <StatCard label="Missing 2FA" value={String(counts.missing2fa)} icon={Flag} color={counts.missing2fa > 0 ? "text-amber-400" : "text-emerald-400"} />
        <StatCard label="Inactive 30d+" value={String(counts.inactive30d)} icon={Clock} color={counts.inactive30d > 0 ? "text-amber-400" : "text-emerald-400"} />
        <StatCard label="Banned/Suspended" value={String(counts.bannedOrSuspended)} icon={AlertTriangle} color={counts.bannedOrSuspended > 0 ? "text-red-400" : "text-emerald-400"} />
      </div>

      {(!flaggedEntries || flaggedEntries.length === 0) ? (
        <div className="text-center py-14 space-y-2">
          <ShieldCheck className="w-8 h-8 text-emerald-400/60 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/60">All entities are healthy — nothing flagged</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">Flagged Entities</p>
          {flaggedEntries.map((f: any) => (
            <div key={f.id} className="bg-card border border-card-border rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-bold text-foreground truncate">{f.projectName}</p>
                  <p className="font-mono text-[9px] text-muted-foreground/50">{f.entitySerial} · score {f.score}/10</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {f.hits.map((h: any) => {
                  const s = SEVERITY_STYLE[h.severity] ?? SEVERITY_STYLE.flag;
                  const Icon = s.icon;
                  return (
                    <Badge key={h.id} variant="outline" className={cn("font-mono text-[9px] gap-1 px-1.5 py-0.5 border", s.color)}>
                      <Icon className="w-2.5 h-2.5" /> {h.message}
                    </Badge>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Analytics tab ──────────────────────────────────────────────────────────────
function AnalyticsTab() {
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getJson("/vault/analytics"), getJson("/vault/analytics/value-history")]).then(([a, h]) => {
      if (cancelled) return;
      setAnalytics(a);
      setHistory(Array.isArray(h) ? h : []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  if (!analytics) return <div className="text-center py-16 text-muted-foreground/50 font-mono text-xs">Analytics unavailable</div>;

  const { overview, byProject, perPlatform, bestPerforming, worstPerforming } = analytics;

  const projectData = Object.entries(byProject ?? {}).map(([name, v]: [string, any]) => ({
    name, totalValue: Math.round(v.totalValue), count: v.count,
  })).sort((a, b) => b.totalValue - a.totalValue);

  const platformData = [
    { name: "Twitter", ...perPlatform.twitter },
    { name: "Discord", ...perPlatform.discord },
    { name: "Telegram", ...perPlatform.telegram },
  ].filter(p => p.count > 0);

  const historyData = (history ?? [])
    .filter(h => h.metric === "value" || !h.metric)
    .map(h => ({ date: new Date(h.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: Number(h.value) }))
    .slice(-30);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="Total Vault Worth" value={`$${overview.totalVaultWorth.toFixed(0)}`} icon={DollarSign} color="text-amber-400" />
        <StatCard
          label="Net P&L"
          value={`${overview.netPnl >= 0 ? "+" : ""}$${overview.netPnl.toFixed(0)}`}
          icon={overview.netPnl >= 0 ? TrendingUp : TrendingDown}
          color={overview.netPnl >= 0 ? "text-emerald-400" : "text-red-400"}
        />
        <StatCard label="Avg Health Score" value={`${overview.avgScore}/10`} icon={Shield} color="text-primary" />
        <StatCard label="2FA Coverage" value={`${overview.twofaCoveragePct}%`} icon={Percent} color={overview.twofaCoveragePct >= 70 ? "text-emerald-400" : "text-amber-400"} />
        <StatCard label="Total Buy Value" value={`$${overview.totalBuyValue.toFixed(0)}`} icon={DollarSign} color="text-muted-foreground" />
        <StatCard label="Total Entities" value={String(overview.totalEntries)} icon={Layers} color="text-cyan-400" />
      </div>

      {historyData.length > 1 && (
        <div className="bg-card border border-card-border rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Portfolio Value Trend</p>
          <div className="h-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={historyData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis dataKey="date" tick={{ fontSize: 9, fontFamily: "monospace" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fontFamily: "monospace" }} width={40} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 10, fontFamily: "monospace" }} />
                <Line type="monotone" dataKey="value" stroke="#34d399" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {projectData.length > 0 && (
          <div className="bg-card border border-card-border rounded-xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Worth by Project</p>
            <div className="h-[130px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={projectData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 8, fontFamily: "monospace" }} />
                  <Bar dataKey="totalValue" radius={[3, 3, 0, 0]} fill="#60a5fa" />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 10, fontFamily: "monospace" }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {platformData.length > 0 && (
          <div className="bg-card border border-card-border rounded-xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Per-Platform Worth</p>
            <div className="space-y-2 mt-3">
              {platformData.map((p, i) => (
                <div key={p.name} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground/70 w-16 flex-shrink-0">{p.name}</span>
                  <div className="flex-1 h-1.5 bg-muted/20 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, (p.totalWorth / Math.max(...platformData.map(x => x.totalWorth), 1)) * 100)}%`, background: PIE_COLORS[i % PIE_COLORS.length] }}
                    />
                  </div>
                  <span className="font-mono text-[10px] font-bold text-foreground w-16 text-right flex-shrink-0">${p.totalWorth.toFixed(0)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-card border border-card-border rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-emerald-400/60 mb-2 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Best Performing</p>
          {(!bestPerforming || bestPerforming.length === 0) ? (
            <p className="font-mono text-xs text-muted-foreground/50 text-center py-4">No ROI data yet</p>
          ) : (
            <div className="space-y-1.5">
              {bestPerforming.map((e: any) => (
                <div key={e.id} className="flex items-center justify-between font-mono text-[10px]">
                  <span className="text-foreground truncate">{e.projectName}</span>
                  <span className="text-emerald-400 font-bold flex-shrink-0">+{e.roiPct.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bg-card border border-card-border rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-red-400/60 mb-2 flex items-center gap-1"><TrendingDown className="w-3 h-3" /> Worst Performing</p>
          {(!worstPerforming || worstPerforming.length === 0) ? (
            <p className="font-mono text-xs text-muted-foreground/50 text-center py-4">No ROI data yet</p>
          ) : (
            <div className="space-y-1.5">
              {worstPerforming.map((e: any) => (
                <div key={e.id} className="flex items-center justify-between font-mono text-[10px]">
                  <span className="text-foreground truncate">{e.projectName}</span>
                  <span className={cn("font-bold flex-shrink-0", e.roiPct >= 0 ? "text-emerald-400" : "text-red-400")}>{e.roiPct >= 0 ? "+" : ""}{e.roiPct.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Section switcher ───────────────────────────────────────────────────────
// Replaces the old shadcn horizontal <Tabs>/<TabsList> underline bar with a
// compact animated pill/segmented control — same job (pick one section,
// show its content) without looking like a browser-style tab strip. Content
// swaps with a quick fade+rise (animate-fade-up, already defined in
// index.css) keyed on the active section so switching never feels static.
type Section = "overview" | "project" | "pnl" | "health" | "analytics";

const SECTION_ICONS: Record<Section, React.ElementType> = {
  overview: Layers, project: Flag, pnl: DollarSign, health: ShieldCheck, analytics: TrendingUp,
};

function SectionSwitcher({ active, onChange, sections }: { active: Section; onChange: (s: Section) => void; sections: { key: Section; label: string }[] }) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-full bg-muted/20 border border-card-border w-fit overflow-x-auto max-w-full">
      {sections.map(({ key, label }) => {
        const Icon = SECTION_ICONS[key];
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-1.5 rounded-full font-mono text-xs whitespace-nowrap transition-all duration-300 ease-out",
              isActive
                ? "bg-primary text-black shadow-[0_0_16px_-2px_var(--primary)] scale-100"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40 scale-[0.98]"
            )}
          >
            <Icon className={cn("w-3.5 h-3.5 transition-transform duration-300", isActive && "scale-110")} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Shared dashboard sections (Overview / Project / PnL / …) ─────────────────
// vaultEntryId omitted → aggregate dashboard across every entity (vault "Entity" tab).
// vaultEntryId provided → scoped dashboard for that single entity (entity detail page).
export default function EntityDashboardTabs({ vaultEntryId }: { vaultEntryId?: number }) {
  const { data, isLoading } = useListVaultEntries();
  const allEntries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];
  const entries = vaultEntryId ? allEntries.filter(e => e.id === vaultEntryId) : allEntries;

  const [leaderboard, setLeaderboard] = useState<any[] | null>(null);
  const [lbLoading, setLbLoading] = useState(true);
  const [active, setActive] = useState<Section>("overview");

  useEffect(() => {
    let cancelled = false;
    setLbLoading(true);
    getJson("/projects/entity-leaderboard").then(rows => {
      if (cancelled) return;
      const list = Array.isArray(rows) ? rows : [];
      setLeaderboard(vaultEntryId ? list.filter(r => r.vaultEntryId === vaultEntryId) : list);
      setLbLoading(false);
    });
    return () => { cancelled = true; };
  }, [vaultEntryId]);

  const loading = isLoading || lbLoading;

  const sections: { key: Section; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "project", label: "Project" },
    { key: "pnl", label: "PnL" },
    ...(!vaultEntryId ? [{ key: "health" as Section, label: "Health" }, { key: "analytics" as Section, label: "Analytics" }] : []),
  ];

  return (
    <div className="space-y-4">
      <SectionSwitcher active={active} onChange={setActive} sections={sections} />
      <div key={active} className="animate-fade-up">
        {active === "overview" && <OverviewTab entries={entries} leaderboard={leaderboard} loading={loading} />}
        {active === "project" && <ProjectTab vaultEntryId={vaultEntryId} leaderboard={leaderboard} loading={loading} />}
        {active === "pnl" && <PnlTab entries={entries} />}
        {active === "health" && !vaultEntryId && <HealthTab />}
        {active === "analytics" && !vaultEntryId && <AnalyticsTab />}
      </div>
    </div>
  );
}
