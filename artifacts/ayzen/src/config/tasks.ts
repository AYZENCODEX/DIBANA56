// Shared task / cost-profit config.
// Previously duplicated verbatim in pages/user/tasks.tsx and
// pages/user/project-detail.tsx (see UI_CONFIG_PLAN.md §4.2 — "dedupe first").
// Adding a new cost or profit category now means adding one entry here,
// instead of editing two files in sync.

export const COST_CATEGORIES = [
  "Gas Fee",
  "Account Create Fee",
  "Swap Fee",
  "Bridge Fee",
  "Net Fee",
  "Manual",
] as const;

export const PROFIT_CATEGORIES = [
  "Refer",
  "Trade Volume",
  "Mystery Box",
  "FCFS",
  "Random",
  "TGE",
  "Manual",
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number];
export type ProfitCategory = (typeof PROFIT_CATEGORIES)[number];
