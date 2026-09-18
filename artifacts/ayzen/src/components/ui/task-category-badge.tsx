import { cn } from "@/lib/utils";
import { LogIn, DollarSign, Zap, TrendingDown } from "lucide-react";

export type TaskCategory = "A" | "B1" | "B2" | "C" | "Social" | string;

interface CategoryConfig {
  label: string;
  description: string;
  color: string;
  bg: string;
  border: string;
  icon: React.ComponentType<{ className?: string }>;
}

const CATEGORY_CONFIG: Record<string, CategoryConfig> = {
  A: {
    label: "A",
    description: "Sign-in Only",
    color: "text-sky-400",
    bg: "bg-sky-400/10",
    border: "border-sky-400/30",
    icon: LogIn,
  },
  B1: {
    label: "B1",
    description: "Free · Earns Reward",
    color: "text-emerald-400",
    bg: "bg-emerald-400/10",
    border: "border-emerald-400/30",
    icon: DollarSign,
  },
  B2: {
    label: "B2",
    description: "Paid · Instant Reward",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/30",
    icon: Zap,
  },
  C: {
    label: "C",
    description: "Cost Only",
    color: "text-red-400",
    bg: "bg-red-400/10",
    border: "border-red-400/30",
    icon: TrendingDown,
  },
  Social: {
    label: "SOC",
    description: "Social Task",
    color: "text-violet-400",
    bg: "bg-violet-400/10",
    border: "border-violet-400/30",
    icon: DollarSign,
  },
};

function getConfig(category: string): CategoryConfig {
  return CATEGORY_CONFIG[category] ?? CATEGORY_CONFIG["B1"];
}

interface TaskCategoryBadgeProps {
  category: TaskCategory;
  showDescription?: boolean;
  className?: string;
  size?: "xs" | "sm";
}

export function TaskCategoryBadge({ category, showDescription, className, size = "xs" }: TaskCategoryBadgeProps) {
  const cfg = getConfig(category);
  const Icon = cfg.icon;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 font-mono font-bold rounded border px-1.5 py-0.5 uppercase tracking-wider",
      size === "xs" ? "text-[9px]" : "text-[10px]",
      cfg.color, cfg.bg, cfg.border,
      className
    )}>
      <Icon className={size === "xs" ? "w-2.5 h-2.5" : "w-3 h-3"} />
      {cfg.label}
      {showDescription && <span className="font-normal opacity-70 ml-0.5">· {cfg.description}</span>}
    </span>
  );
}

export function CategoryLegend() {
  return (
    <div className="grid grid-cols-2 gap-2">
      {Object.entries(CATEGORY_CONFIG).filter(([k]) => ["A","B1","B2","C"].includes(k)).map(([key, cfg]) => {
        const Icon = cfg.icon;
        return (
          <div key={key} className={cn(
            "flex items-start gap-2 p-2.5 rounded-lg border",
            cfg.bg, cfg.border
          )}>
            <Icon className={cn("w-3.5 h-3.5 mt-0.5 flex-shrink-0", cfg.color)} />
            <div>
              <div className={cn("font-mono text-[10px] font-bold uppercase", cfg.color)}>
                {key} — {cfg.label === key ? cfg.description : cfg.label}
              </div>
              <div className="font-mono text-[9px] text-muted-foreground/60 mt-0.5">
                {key === "A" && "User signs in / registers. No cost, no reward."}
                {key === "B1" && "Free to complete. Reward paid upon approval."}
                {key === "B2" && "Requires cost. Reward paid instantly."}
                {key === "C" && "Costs money. No direct reward payout."}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { getConfig as getCategoryConfig };
