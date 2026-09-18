import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, XCircle, AlertTriangle, ArrowLeft, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface PingPoint { checkedAt: string; isUp: boolean; statusCode: number | null; latencyMs: number | null }
interface StatusResponse {
  current: { isUp: boolean; statusCode: number | null; latencyMs: number | null; checkedAt: string } | null;
  uptimePct: { "24h": number; "7d": number; "30d": number };
  avgLatencyMs24h: number | null;
  history: PingPoint[];
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${BASE}/api/uptime/status`)
        .then(r => r.json())
        .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const isUp = data?.current?.isUp ?? null;
  const statusLabel = isUp === null ? "Checking..." : isUp ? "All Systems Operational" : "Service Disruption";
  const statusColor = isUp === null ? "text-muted-foreground" : isUp ? "text-emerald-400" : "text-red-400";
  const StatusIcon = isUp === null ? Activity : isUp ? CheckCircle2 : XCircle;

  const chartData = (data?.history ?? []).map(p => ({
    time: new Date(p.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    latency: p.isUp ? p.latencyMs : null,
    isUp: p.isUp,
  }));

  return (
    <div className="min-h-screen bg-background flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <Link href="/" className="inline-flex items-center gap-1.5 text-muted-foreground/60 hover:text-foreground font-mono text-xs transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Link>

        {/* Overall status banner */}
        <div className={cn(
          "rounded-xl border p-6 flex items-center gap-4",
          isUp === null ? "border-border/40 bg-muted/5"
            : isUp ? "border-emerald-400/30 bg-emerald-400/5"
            : "border-red-400/30 bg-red-400/5",
        )}>
          <StatusIcon className={cn("w-9 h-9 shrink-0", statusColor, isUp === null && "animate-pulse")} />
          <div>
            <h1 className={cn("text-lg font-bold font-mono uppercase tracking-tight", statusColor)}>
              {statusLabel}
            </h1>
            <p className="text-muted-foreground/60 font-mono text-xs mt-0.5">
              {data?.current ? `Last checked ${timeAgo(data.current.checkedAt)}` : loading ? "Loading..." : "No data yet"}
              {data?.current?.statusCode && !data.current.isUp && ` · HTTP ${data.current.statusCode}`}
            </p>
          </div>
        </div>

        {/* Uptime % cards */}
        <div className="grid grid-cols-3 gap-3">
          {(["24h", "7d", "30d"] as const).map(window => {
            const p = data?.uptimePct[window] ?? 100;
            return (
              <div key={window} className="rounded-lg border border-border/40 bg-muted/5 p-4 text-center">
                <div className={cn(
                  "text-2xl font-bold font-mono",
                  p >= 99.5 ? "text-emerald-400" : p >= 95 ? "text-amber-400" : "text-red-400",
                )}>
                  {p.toFixed(2)}%
                </div>
                <div className="text-muted-foreground/50 font-mono text-[10px] uppercase tracking-widest mt-1">
                  {window} uptime
                </div>
              </div>
            );
          })}
        </div>

        {/* Avg latency */}
        {data?.avgLatencyMs24h !== null && data?.avgLatencyMs24h !== undefined && (
          <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/5 px-4 py-3">
            <span className="text-muted-foreground font-mono text-xs uppercase tracking-widest">Avg Response Time (24h)</span>
            <span className="font-mono text-sm font-bold text-primary">{Math.round(data.avgLatencyMs24h)}ms</span>
          </div>
        )}

        {/* Response time chart */}
        <div className="rounded-lg border border-border/40 bg-muted/5 p-4">
          <div className="flex items-center gap-1.5 mb-3">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Response Time History</span>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis dataKey="time" tick={{ fontSize: 9, fontFamily: "monospace" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fontFamily: "monospace" }} unit="ms" width={40} />
                <Tooltip
                  contentStyle={{ fontFamily: "monospace", fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                  formatter={(v: any) => [v !== null ? `${v}ms` : "down", "Latency"]}
                />
                <Line type="monotone" dataKey="latency" stroke="hsl(var(--primary))" strokeWidth={1.5} dot={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-center text-muted-foreground/40 font-mono text-[10px] py-8">
              {loading ? "Loading history..." : "No ping history yet — check back in a few minutes"}
            </p>
          )}
        </div>

        {/* Incident strip — last 50 checks as a row of ticks (like classic status pages) */}
        {chartData.length > 0 && (
          <div className="rounded-lg border border-border/40 bg-muted/5 p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground/60" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Recent Checks</span>
            </div>
            <div className="flex gap-0.5 h-8">
              {chartData.slice(-50).map((p, i) => (
                <div
                  key={i}
                  title={p.isUp ? "Up" : "Down"}
                  className={cn(
                    "flex-1 rounded-sm",
                    p.isUp ? "bg-emerald-400/60" : "bg-red-400/80",
                  )}
                />
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-muted-foreground/30 font-mono text-[9px]">
          Auto-refreshes every 30s · Checked every 4 minutes
        </p>
      </div>
    </div>
  );
}
