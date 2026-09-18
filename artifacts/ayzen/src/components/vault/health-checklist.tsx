/**
 * components/vault/health-checklist.tsx
 * ─────────────────────────────────────────────
 * Shared "X Health" card — extracted from the Entity Health block on
 * pages/user/vault-entity-detail.tsx (score % + progress bar + per-field
 * checklist + missing-items summary) so KYC Entity, Wallet, and Local
 * Account can render the exact same widget against their own check config
 * (config/columns/entity-view.ts: KYC_HEALTH_CHECKS, WALLET_HEALTH_CHECKS,
 * LOCAL_ACCOUNT_HEALTH_CHECKS), rather than three near-duplicate copies of
 * this JSX with only the field list changed.
 */
import { TrendingUp, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { CheckItem } from "@/config/columns/entity-view";

export function healthScoreFor(checks: CheckItem[], entry: any): number {
  const filled = checks.filter(c => c.getValue(entry)).length;
  return checks.length ? Math.round((filled / checks.length) * 100) : 0;
}
export function healthColor(score: number) {
  if (score >= 80) return "text-emerald-400";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}
export function healthLabel(score: number) {
  if (score >= 80) return { label: "Healthy", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" };
  if (score >= 50) return { label: "Partial", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
  return { label: "At Risk", color: "text-red-400 bg-red-400/10 border-red-400/20" };
}

export function HealthChecklistCard({
  title = "Health", checks, entry,
}: {
  title?: string;
  checks: CheckItem[];
  entry: any;
}) {
  const score = healthScoreFor(checks, entry);
  const { label: healthLbl, color: badgeColor } = healthLabel(score);
  const missing = checks.filter(c => !c.getValue(entry));

  return (
    <div className="bg-card border border-card-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          <span className="font-mono text-sm font-bold text-primary">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("font-mono text-xl font-bold", healthColor(score))}>{score}%</span>
          <Badge variant="outline" className={cn("font-mono text-[9px] px-1.5 border", badgeColor)}>{healthLbl}</Badge>
        </div>
      </div>
      <Progress value={score} className="h-2 mb-4" />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {checks.map(check => {
          const has = check.getValue(entry);
          const Icon = check.icon;
          return (
            <div
              key={check.key}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 border",
                has ? "bg-emerald-400/5 border-emerald-400/15" : "bg-red-400/5 border-red-400/15"
              )}
            >
              <Icon className={cn("w-3.5 h-3.5 flex-shrink-0", has ? check.color : "text-red-400/60")} />
              <span className={cn("font-mono text-[10px] truncate", has ? "text-foreground/80" : "text-muted-foreground/50")}>{check.label}</span>
              <div className="ml-auto flex-shrink-0">
                {has ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <XCircle className="w-3 h-3 text-red-400/60" />}
              </div>
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <div className="mt-4 p-3 rounded-lg bg-amber-400/5 border border-amber-400/20">
          <div className="flex items-center gap-1.5 mb-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400 font-bold">Missing ({missing.length})</span>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground/60 leading-relaxed">
            {missing.map(m => m.label).join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}

/** Small inline badge (score% + label) for card headers/list rows — no checklist grid. */
export function HealthScoreBadge({ checks, entry }: { checks: CheckItem[]; entry: any }) {
  const score = healthScoreFor(checks, entry);
  const { label, color } = healthLabel(score);
  return (
    <Badge variant="outline" className={cn("font-mono text-[9px] px-1.5 border gap-1", color)}>
      {score}% · {label}
    </Badge>
  );
}
