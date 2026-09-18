/**
 * components/finance/finance-ui.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared visual primitives for the Finance module. Pulls from the app's
 * existing premium-card / elevation / glow vocabulary (see index.css) so the
 * module reads as a single, more polished surface — not a bolted-on skin.
 * Presentation only; no data-fetching or business logic lives here.
 */
import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FinanceTone = "primary" | "secondary" | "success" | "danger" | "warning" | "info" | "neutral";

const TONE: Record<FinanceTone, { chip: string; value: string; glow: string }> = {
  primary: { chip: "bg-primary/10 text-primary ring-primary/20", value: "text-foreground", glow: "hover:border-primary/30 hover:shadow-[0_0_24px_hsl(174_100%_42%/0.08)]" },
  secondary: { chip: "bg-secondary/10 text-secondary ring-secondary/20", value: "text-foreground", glow: "hover:border-secondary/30 hover:shadow-[0_0_24px_hsl(265_90%_62%/0.1)]" },
  success: { chip: "bg-success-muted text-success ring-success/20", value: "text-success", glow: "hover:border-success/30" },
  danger: { chip: "bg-danger-muted text-danger ring-danger/20", value: "text-danger", glow: "hover:border-danger/30" },
  warning: { chip: "bg-warning-muted text-warning ring-warning/20", value: "text-warning", glow: "hover:border-warning/30" },
  info: { chip: "bg-info-muted text-info ring-info/20", value: "text-info", glow: "hover:border-info/30" },
  neutral: { chip: "bg-muted text-muted-foreground ring-border", value: "text-foreground", glow: "" },
};

/* ─── Page header ────────────────────────────────────────────────────────── */

export function FinancePageHeader({
  eyebrow, title, description, actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        {eyebrow && (
          <p className="text-[10px] font-semibold tracking-[0.16em] uppercase text-primary/70 mb-1">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-bold tracking-tight gradient-text-primary">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function SectionEyebrow({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className="h-3.5 w-3.5 text-primary" />}
      <h2 className="text-xs font-semibold tracking-[0.1em] uppercase text-muted-foreground">{children}</h2>
      <div className="flex-1 divider-glow" />
    </div>
  );
}

/* ─── Stat tile ──────────────────────────────────────────────────────────── */

export function StatTile({
  icon: Icon, label, value, tone = "neutral", sublabel, delay = 0,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: FinanceTone;
  sublabel?: ReactNode;
  delay?: number;
}) {
  const t = TONE[tone];
  return (
    <div
      className={cn(
        "relative rounded-xl border border-card-border bg-card p-4 elevation-1 hover-lift transition-[border-color,box-shadow] animate-fade-up",
        t.glow,
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", t.chip)}>
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-xs text-muted-foreground font-medium leading-tight">{label}</p>
      </div>
      <p className={cn("text-xl font-bold font-mono tracking-tight", t.value)}>{value}</p>
      {sublabel && <p className="text-[11px] text-muted-foreground mt-1">{sublabel}</p>}
    </div>
  );
}

/* ─── Hero figure (dashboard net worth, etc.) ───────────────────────────── */

export function FinanceHero({
  eyebrow, label, value, tone = "primary", trend, children,
}: {
  eyebrow?: string;
  label: string;
  value: ReactNode;
  tone?: "primary" | "success" | "danger";
  trend?: ReactNode;
  children?: ReactNode;
}) {
  const valueClass = tone === "success" ? "gradient-text-primary" : tone === "danger" ? "text-danger" : "gradient-text-duo";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-card-border bg-card p-6 elevation-2 noise-texture">
      <div className="pointer-events-none absolute -top-24 -right-16 h-56 w-56 rounded-full bg-primary/10 blur-3xl animate-float" />
      <div className="pointer-events-none absolute -bottom-24 -left-10 h-48 w-48 rounded-full bg-secondary/10 blur-3xl animate-float-delayed" />
      <div className="relative flex items-start justify-between gap-6 flex-wrap">
        <div>
          {eyebrow && <p className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground mb-2">{eyebrow}</p>}
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          <p className={cn("text-4xl font-bold font-mono tracking-tight", valueClass)}>{value}</p>
          {trend && <div className="mt-2">{trend}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/* ─── Card wrapper ───────────────────────────────────────────────────────── */

export function FinanceCard({
  className, hover = true, children,
}: {
  className?: string;
  hover?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border border-card-border bg-card p-4 elevation-1", hover && "hover-lift transition-[border-color,box-shadow]", className)}>
      {children}
    </div>
  );
}

export function ChartCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-4 elevation-1 hover-lift transition-[border-color,box-shadow]">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold">{title}</p>
        {action}
      </div>
      <div className="h-64">{children}</div>
    </div>
  );
}

/* ─── Empty state ────────────────────────────────────────────────────────── */

export function FinanceEmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-12 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border mb-1">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-xs text-muted-foreground max-w-sm">{description}</p>}
    </div>
  );
}

/* ─── Progress bar (budgets, allocations) ───────────────────────────────── */

export function FinanceProgress({ pct, tone = "primary" }: { pct: number; tone?: "primary" | "success" | "warning" | "danger" }) {
  const barClass = tone === "danger" ? "bg-danger shadow-[0_0_10px_hsl(var(--danger)/0.6)]"
    : tone === "warning" ? "bg-warning shadow-[0_0_10px_hsl(var(--warning)/0.5)]"
    : tone === "success" ? "bg-success shadow-[0_0_10px_hsl(var(--success)/0.5)]"
    : "bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.5)]";
  return (
    <div className="h-2 rounded-full bg-muted/40 overflow-hidden">
      <div className={cn("h-full rounded-full transition-all duration-500", barClass)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

/* ─── Loading / skeleton ─────────────────────────────────────────────────── */

export function FinanceLoader() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground">
      <div className="h-8 w-8 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
      <p className="text-xs">Loading…</p>
    </div>
  );
}
