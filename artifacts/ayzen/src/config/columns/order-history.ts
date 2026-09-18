import type { ColumnDef } from "@/config/types";

// Column config for pages/user/marketplace-order-history.tsx's aggregated
// order table. See UI_CONFIG_PLAN.md Phase C — "Order history".
//
// Source and status badges are driven by config/marketplace.ts's
// ORDER_SOURCE_META / ORDER_STATUS_COLOR — this file is just the column
// layout. Adding a column to the order history table = one entry here.

export const ORDER_HISTORY_COLUMNS: ColumnDef[] = [
  { key: "source", label: "Source", render: "badge", sortable: true },
  { key: "product", label: "Order", render: "text" },
  { key: "type", label: "Type", render: "text" },
  { key: "amount", label: "Amount", render: "text" },
  { key: "status", label: "Status", render: "badge", sortable: true },
  { key: "date", label: "Date", render: "date", sortable: true },
];
