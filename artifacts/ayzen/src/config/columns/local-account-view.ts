import type { ColumnDef } from "@/config/types";

// Column config for local-account list/table views: the per-account rows
// in components/local-accounts.tsx's AccountCard grid, and the
// per-category detail table in pages/user/vault-local-dashboard.tsx's
// CategoryTab. See UI_CONFIG_PLAN.md Phase B — "Local account create/view"
// (extends the existing LOCAL_ACCOUNT_DASHBOARD_META in config/vault-local.ts).
//
// Adding a column to either view = one entry here.

export const LOCAL_ACCOUNT_COLUMNS: ColumnDef[] = [
  { key: "label", label: "Account", render: "text", sortable: true },
  { key: "metric", label: "Metric", render: "text", sortable: true }, // platform-specific metric (followers/points/karma/...), label comes from LOCAL_ACCOUNT_DASHBOARD_META
  { key: "account_worth", label: "Worth", render: "currency", sortable: true },
  { key: "buy_price", label: "Buy Price", render: "currency", sortable: true },
  { key: "roi", label: "ROI", render: "badge", sortable: true },
  { key: "account_create_date", label: "Age", render: "date" },
];
