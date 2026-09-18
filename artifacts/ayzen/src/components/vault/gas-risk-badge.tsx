import { cn } from "@/lib/utils";
import { AlertOctagon, AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import type { GasRisk } from "@/lib/gas-health-api";

const RISK_META: Record<GasRisk, { label: string; icon: React.ElementType; color: string; bg: string; border: string }> = {
  critical: { label: "Critical",  icon: AlertOctagon,   color: "text-red-400",     bg: "bg-red-500/10",     border: "border-red-500/30" },
  warning:  { label: "Low Gas",   icon: AlertTriangle,  color: "text-amber-400",   bg: "bg-amber-500/10",   border: "border-amber-500/30" },
  healthy:  { label: "Healthy",   icon: CheckCircle2,   color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  unknown:  { label: "Unknown",   icon: HelpCircle,      color: "text-muted-foreground", bg: "bg-muted/10", border: "border-border/30" },
};

export function GasRiskBadge({ risk, className }: { risk: GasRisk; className?: string }) {
  const meta = RISK_META[risk] ?? RISK_META.unknown;
  const Icon = meta.icon;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0",
      meta.color, meta.bg, meta.border, className
    )}>
      <Icon className="w-2.5 h-2.5" /> {meta.label}
    </span>
  );
}

export { RISK_META };
