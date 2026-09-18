/**
 * components/finance/finance-insights.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * "Smart Alerts & Insights" widget for the finance dashboard. Self-contained:
 * fetches GET /finance/insights and renders a health score, alert list,
 * budget-overrun bars, and a 30/60/90-day cashflow forecast. All the actual
 * heuristics live server-side (routes/finance.ts) — this is presentation only.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, AlertCircle, Info, Activity } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney } from "@/config/finance";
import type { FinanceInsights, InsightSeverity } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinanceProgress, FinanceLoader } from "@/components/finance/finance-ui";

const SEVERITY_STYLE: Record<InsightSeverity, string> = {
  critical: "text-danger border-danger/30 bg-danger-muted",
  warning: "text-warning border-warning/30 bg-warning-muted",
  info: "text-info border-info/30 bg-info-muted",
};
const SEVERITY_ICON: Record<InsightSeverity, typeof AlertTriangle> = {
  critical: AlertCircle, warning: AlertTriangle, info: Info,
};

function healthColor(score: number) {
  if (score >= 80) return "text-success";
  if (score >= 60) return "text-info";
  if (score >= 40) return "text-warning";
  return "text-danger";
}

function healthRing(score: number) {
  if (score >= 80) return "hsl(var(--success))";
  if (score >= 60) return "hsl(var(--info))";
  if (score >= 40) return "hsl(var(--warning))";
  return "hsl(var(--danger))";
}

export function FinanceInsightsWidget() {
  const { token } = useAuth();
  const [data, setData] = useState<FinanceInsights | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    financeApi.insights(token).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="rounded-xl border border-card-border bg-card p-4 elevation-1">
        <FinanceLoader />
      </div>
    );
  }
  if (!data) return null;

  const overBudget = data.budgetStatus.filter(b => b.pct >= 80);
  const ringDeg = Math.min(100, Math.max(0, data.healthScore)) * 3.6;

  return (
    <div className="rounded-xl border border-card-border bg-card p-4 elevation-1 space-y-4 hover-lift transition-[border-color,box-shadow]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-xs font-semibold tracking-[0.1em] uppercase text-muted-foreground">Smart Insights</h2>
        </div>
        <div className="flex items-center gap-2.5">
          <div
            className="relative flex h-11 w-11 items-center justify-center rounded-full shrink-0"
            style={{ background: `conic-gradient(${healthRing(data.healthScore)} ${ringDeg}deg, hsl(var(--muted)) 0deg)` }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-card">
              <span className={cn("text-xs font-bold font-mono", healthColor(data.healthScore))}>{data.healthScore}</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground max-w-[6rem] leading-tight">{data.healthLabel}</p>
        </div>
      </div>

      {data.alerts.length > 0 && (
        <div className="space-y-1.5">
          {data.alerts.map((a, i) => {
            const Icon = SEVERITY_ICON[a.severity];
            const body = (
              <div className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs", SEVERITY_STYLE[a.severity])}>
                <Icon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">{a.title}</p>
                  <p className="opacity-80 mt-0.5">{a.detail}</p>
                </div>
              </div>
            );
            return a.link ? <Link key={i} href={a.link} className="block hover:opacity-90 transition-opacity">{body}</Link> : <div key={i}>{body}</div>;
          })}
        </div>
      )}

      {overBudget.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">Budget usage this month</p>
          {overBudget.map(b => (
            <div key={b.category} className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="capitalize">{b.category}</span>
                <span className={cn("font-mono", b.pct >= 100 ? "text-danger" : "text-warning")}>{b.pct}%</span>
              </div>
              <FinanceProgress pct={b.pct} tone={b.pct >= 100 ? "danger" : "warning"} />
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {data.cashflowForecast.map(c => (
          <div key={c.days} className="rounded-lg border border-border/60 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">{c.days}d forecast</p>
            <p className={cn("text-sm font-bold font-mono", c.projectedBalance >= 0 ? "text-success" : "text-danger")}>{fmtMoney(c.projectedBalance)}</p>
            <p className={cn("text-[10px] font-mono", c.netChange >= 0 ? "text-success/70" : "text-danger/70")}>{c.netChange >= 0 ? "+" : ""}{fmtMoney(c.netChange)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
