import type { ElementType } from "react";
import { Users, Activity, Target, DollarSign, UserPlus, Clock } from "lucide-react";

// Stat-card config for pages/admin/dashboard.tsx's "Platform Overview" grid.
// See UI_CONFIG_PLAN.md Phase A. Adding a new stat card is one entry in
// ADMIN_DASHBOARD_STAT_CARDS below — the page just maps over the array and
// calls getValue(ctx) for each card; no JSX changes needed to add, remove,
// reorder, or restyle a card.

/** Shape of the data every card's getValue() can read from. Currently just
 *  the useGetPlatformStats() response, but kept as a named ctx type so a
 *  future card (e.g. sourced from a second query) only needs to widen this
 *  interface, not touch every existing card. */
export interface AdminDashboardCtx {
  stats: {
    totalUsers?: number;
    activeUsers?: number;
    activeProjectCount?: number;
    totalRoiDistributed?: number;
    newUsersThisWeek?: number;
    newUsersThisMonth?: number;
    pendingRoi?: number;
  } | undefined;
}

export interface StatCardValue {
  /** Raw value rendered large — numbers get .toLocaleString(), strings render as-is. */
  value: number | string | null | undefined;
  /** Small caption under the value. */
  change: string;
}

export interface StatCardDef {
  key: string;
  label: string;
  icon: ElementType;
  /** Text color className, applied to icon + value. */
  color: string;
  /** Full className for the card's border/bg. */
  bg: string;
  getValue: (ctx: AdminDashboardCtx) => StatCardValue;
}

export const ADMIN_DASHBOARD_STAT_CARDS: StatCardDef[] = [
  {
    key: "totalOperators",
    label: "Total Operators",
    icon: Users,
    color: "text-primary",
    bg: "border-primary/20 bg-primary/5",
    getValue: ({ stats }) => ({
      value: stats?.totalUsers,
      change: `+${stats?.newUsersThisWeek ?? 0} this week`,
    }),
  },
  {
    key: "activeUsers7d",
    label: "Active Users (7d)",
    icon: Activity,
    color: "text-emerald-400",
    bg: "border-emerald-400/20 bg-emerald-400/5",
    getValue: ({ stats }) => ({
      value: stats?.activeUsers,
      change: "last 7 days",
    }),
  },
  {
    key: "liveProjects",
    label: "Live Projects",
    icon: Target,
    color: "text-violet-400",
    bg: "border-violet-400/20 bg-violet-400/5",
    getValue: ({ stats }) => ({
      value: stats?.activeProjectCount,
      change: "active airdrops",
    }),
  },
  {
    key: "totalRoi",
    label: "Total ROI",
    icon: DollarSign,
    color: "text-amber-400",
    bg: "border-amber-400/20 bg-amber-400/5",
    getValue: ({ stats }) => ({
      value: stats ? `$${(stats.totalRoiDistributed ?? 0).toLocaleString()}` : null,
      change: "all time",
    }),
  },
  {
    key: "newThisMonth",
    label: "New This Month",
    icon: UserPlus,
    color: "text-sky-400",
    bg: "border-sky-400/20 bg-sky-400/5",
    getValue: ({ stats }) => ({
      value: stats?.newUsersThisMonth,
      change: `+${stats?.newUsersThisWeek ?? 0} this week`,
    }),
  },
  {
    key: "pendingRoi",
    label: "Pending ROI",
    icon: Clock,
    color: "text-pink-400",
    bg: "border-pink-400/20 bg-pink-400/5",
    getValue: ({ stats }) => ({
      value: stats ? `$${(stats.pendingRoi ?? 0).toLocaleString()}` : null,
      change: "awaiting payout",
    }),
  },
];
