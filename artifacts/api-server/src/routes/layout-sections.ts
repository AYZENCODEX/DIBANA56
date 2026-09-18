/**
 * Registry for the Layout Builder (/admin/layout-builder). Each entry is a
 * page a dev can reorder/toggle sections for. Registering a page here only
 * makes it *selectable* in the builder — it's only actually reorderable in
 * effect once that page's component calls usePageLayoutOrder(pageKey, ...)
 * instead of rendering its sections in a fixed order. See
 * docs/UI_CONFIG_PLAN.md §7 for which pages are wired so far.
 */
export interface LayoutSectionDef {
  key: string;
  label: string;
}

export interface LayoutPageDef {
  pageKey: string;
  label: string;
  sections: LayoutSectionDef[];
}

export const LAYOUT_PAGES: LayoutPageDef[] = [
  {
    pageKey: "user-dashboard",
    label: "User Dashboard",
    sections: [
      { key: "featured-stats", label: "Featured Stats (ROI / AZN)" },
      { key: "compact-stats", label: "Compact Stats (Tasks / Rank / Streak)" },
      { key: "charts", label: "Charts (ROI Trend / Weekly Activity)" },
      { key: "utility-stats", label: "Utility Stats (Protocols / Wallet / Pending / Win Rate)" },
      { key: "activity-lists", label: "Activity Lists (Tasks / Protocols)" },
    ],
  },
];

export const LAYOUT_PAGE_MAP: Record<string, LayoutPageDef> = Object.fromEntries(
  LAYOUT_PAGES.map(p => [p.pageKey, p])
);
