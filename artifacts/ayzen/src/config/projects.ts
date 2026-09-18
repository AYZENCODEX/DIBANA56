// Shared project config: categories, tier colors, and the dynamic
// sidebar → project-meta hierarchy. See UI_CONFIG_PLAN.md §3 (Phase A).
//
// DYNAMIC META SYSTEM (Protocols sidebar restructure):
// The "Protocols" sidebar drives project meta end-to-end — this file is the
// single source of truth. Everything else (the sidebar, the project list
// filters, and the create/edit form's cascading Category → Subcategory →
// Type selects) is derived from SIDEBAR_META_HIERARCHY below. Add a new
// leaf here and it shows up everywhere automatically; nothing else needs
// hand-editing.
//
// Sidebar depth (Protocols main-sidebar is level 1):
//   Level 2 — Category      (Onchain, Exchange, Web3, Social, App)
//   Level 3 — Subcategory   (flat for most categories; for Exchange this is
//                            the platform: Binance / Bitget / Kucoin / Bybit)
//   Level 4 — Type          (the actual leaf link + the value stored as
//                            project_type in the DB)
//   Level 5 — Sub-type      (reserved capability — see LEVEL 5 section below;
//                            not rendered in the sidebar yet, but the data
//                            model already supports it so it can be turned on
//                            later without another restructure)
//
// Every category/subcategory gets an automatic "Overview" entry (handled by
// the sidebar + rollup helpers below, not stored as its own node here) that
// rolls up every project belonging to any type nested under it. The single
// root "Project" sidebar item shows literally every project regardless of
// category — no filter at all.

export const PROJECT_CATEGORIES = [
  "All", "Onchain", "Exchange", "Web3", "Social", "App", "Other",
];

export const TIER_COLORS: Record<string, string> = {
  "1": "border-emerald-400/30 text-emerald-400",
  "2": "border-primary/30 text-primary",
  "3": "border-amber-400/30 text-amber-400",
  "4": "border-red-400/30 text-red-400",
};

export const CATEGORY_COLORS: Record<string, string> = {
  Onchain:  "text-cyan-400 border-cyan-400/20",
  Exchange: "text-yellow-400 border-yellow-400/20",
  Web3:     "text-violet-400 border-violet-400/20",
  Social:   "text-pink-400 border-pink-400/20",
  App:      "text-emerald-400 border-emerald-400/20",
  Other:    "text-muted-foreground border-border",
  // Legacy aliases kept for backward compatibility with older project rows
  DeFi:       "text-cyan-400 border-cyan-400/20",
  NFT:        "text-purple-400 border-purple-400/20",
  GameFi:     "text-emerald-400 border-emerald-400/20",
  Layer2:     "text-blue-400 border-blue-400/20",
  Testnet:    "text-orange-400 border-orange-400/20",
  CEX:        "text-amber-400 border-amber-400/20",
  Learn2Earn: "text-emerald-400 border-emerald-400/20",
};

// ─── DYNAMIC SIDEBAR META HIERARCHY ──────────────────────────────────────────

export interface SidebarMetaNode {
  /** The value stored as project_type in the DB, and the ?type= URL param. */
  projectType: string;
  label: string;
  /** Level 2 — top-level sidebar category. */
  category: string;
  /** Level 3 — sidebar subcategory. For Exchange this is the platform name
   *  (Binance/Bitget/Kucoin/Bybit); for every other category it repeats the
   *  category name (those sidebars are flat at level 3). */
  subcategory: string;
  /** Longer copy shown as the page header description. */
  desc?: string;
  /** Admin can toggle a node off to hide it from the sidebar + create form
   *  without deleting it. Level-5 nodes below start disabled — they're
   *  reserved capability, not yet wired into the sidebar. */
  enabled: boolean;
  /** 4 = active sidebar leaf. 5 = reserved sub-type, not rendered yet. */
  level: 4 | 5;
  /** Only set on level-5 nodes: the level-4 projectType they nest under. */
  parentType?: string;
}

export const SIDEBAR_META_HIERARCHY: SidebarMetaNode[] = [
  // ── Onchain ─────────────────────────────────────────────────────────────
  { projectType: "onchain-mainnet", label: "Mainnet", category: "Onchain", subcategory: "Onchain", desc: "Live network participation campaigns", enabled: true, level: 4 },
  { projectType: "onchain-testnet", label: "Testnet", category: "Onchain", subcategory: "Onchain", desc: "Early network testing opportunities",   enabled: true, level: 4 },

  // ── Web3 ────────────────────────────────────────────────────────────────
  { projectType: "web3-dex",   label: "Dex",   category: "Web3", subcategory: "Web3", desc: "Decentralized exchange campaigns", enabled: true, level: 4 },
  { projectType: "web3-dapp",  label: "Dapp",  category: "Web3", subcategory: "Web3", desc: "Decentralized application quests", enabled: true, level: 4 },
  { projectType: "web3-other", label: "Other", category: "Web3", subcategory: "Web3", desc: "Other Web3 campaigns",             enabled: true, level: 4 },

  // ── Social ──────────────────────────────────────────────────────────────
  { projectType: "social-twitter",  label: "Twitter",  category: "Social", subcategory: "Social", desc: "X / Twitter engagement quests",          enabled: true, level: 4 },
  { projectType: "social-warpcast", label: "Warpcast", category: "Social", subcategory: "Social", desc: "Farcaster / Warpcast engagement quests", enabled: true, level: 4 },

  // ── App ─────────────────────────────────────────────────────────────────
  { projectType: "app-wallet", label: "Wallet", category: "App", subcategory: "App", desc: "In-app wallet campaigns",     enabled: true, level: 4 },
  { projectType: "app-mining", label: "Mining", category: "App", subcategory: "App", desc: "App mining reward campaigns", enabled: true, level: 4 },
  { projectType: "app-refer",  label: "Refer",  category: "App", subcategory: "App", desc: "App referral campaigns",     enabled: true, level: 4 },

  // ── Exchange — Binance ──────────────────────────────────────────────────
  { projectType: "binance-trading", label: "Trading", category: "Exchange", subcategory: "Binance", desc: "Binance trading campaigns",        enabled: true, level: 4 },
  { projectType: "binance-instant", label: "Instant",  category: "Exchange", subcategory: "Binance", desc: "Binance instant reward campaigns", enabled: true, level: 4 },
  { projectType: "binance-web3",    label: "Web3",     category: "Exchange", subcategory: "Binance", desc: "Binance Web3 campaigns",           enabled: true, level: 4 },
  { projectType: "binance-refer",   label: "Refer",    category: "Exchange", subcategory: "Binance", desc: "Binance referral campaigns",       enabled: true, level: 4 },
  { projectType: "binance-other",   label: "Other",    category: "Exchange", subcategory: "Binance", desc: "Other Binance campaigns",          enabled: true, level: 4 },

  // ── Exchange — Bitget ───────────────────────────────────────────────────
  { projectType: "bitget-candybomb",  label: "CandyBomb",  category: "Exchange", subcategory: "Bitget", desc: "Bitget CandyBomb campaigns",    enabled: true, level: 4 },
  { projectType: "bitget-hold",       label: "Hold",        category: "Exchange", subcategory: "Bitget", desc: "Bitget hold-to-earn campaigns", enabled: true, level: 4 },
  { projectType: "bitget-refer",      label: "Refer",       category: "Exchange", subcategory: "Bitget", desc: "Bitget referral campaigns",     enabled: true, level: 4 },
  { projectType: "bitget-other",      label: "Other",       category: "Exchange", subcategory: "Bitget", desc: "Other Bitget campaigns",        enabled: true, level: 4 },
  { projectType: "bitget-mysterybox", label: "Mystery Box", category: "Exchange", subcategory: "Bitget", desc: "Bitget Mystery Box campaigns",  enabled: true, level: 4 },

  // ── Exchange — Kucoin ───────────────────────────────────────────────────
  { projectType: "kucoin-trading",    label: "Trading",       category: "Exchange", subcategory: "Kucoin", desc: "Kucoin trading campaigns",       enabled: true, level: 4 },
  { projectType: "kucoin-refer",      label: "Refer",         category: "Exchange", subcategory: "Kucoin", desc: "Kucoin referral campaigns",      enabled: true, level: 4 },
  { projectType: "kucoin-learn2earn", label: "Learn to Earn", category: "Exchange", subcategory: "Kucoin", desc: "Kucoin learn-to-earn campaigns", enabled: true, level: 4 },
  { projectType: "kucoin-other",      label: "Other",         category: "Exchange", subcategory: "Kucoin", desc: "Other Kucoin campaigns",         enabled: true, level: 4 },

  // ── Exchange — Bybit ────────────────────────────────────────────────────
  { projectType: "bybit-hold",      label: "Hold",      category: "Exchange", subcategory: "Bybit", desc: "Bybit hold-to-earn campaigns", enabled: true, level: 4 },
  { projectType: "bybit-wednesday", label: "Wednesday", category: "Exchange", subcategory: "Bybit", desc: "Bybit Wednesday campaigns",    enabled: true, level: 4 },
  { projectType: "bybit-refer",     label: "Refer",     category: "Exchange", subcategory: "Bybit", desc: "Bybit referral campaigns",     enabled: true, level: 4 },
  { projectType: "bybit-other",     label: "Other",     category: "Exchange", subcategory: "Bybit", desc: "Other Bybit campaigns",        enabled: true, level: 4 },

  // ── Exchange — top-level Other (sibling of the 4 platforms, not nested) ──
  { projectType: "exchange-other", label: "Other", category: "Exchange", subcategory: "Exchange", desc: "Other exchange campaigns", enabled: true, level: 4 },

  // ── LEVEL 5 — reserved capability, disabled ─────────────────────────────
  // Sidebar/DB/create-form all already support a 5th level (see
  // app-sidebar.tsx's NavSection recursion and the /admin/nav API's
  // `level <= 5` check) — these rows just aren't surfaced yet. Flip
  // `enabled: true` and give the parent level-4 entry `children` in
  // app-sidebar.tsx (and nav-seeds.generated.ts) to switch them on; no other
  // change needed anywhere else in this file.
  { projectType: "binance-trading-volume",      label: "Volume",        category: "Exchange", subcategory: "Binance", parentType: "binance-trading", enabled: true,  level: 5 },
  { projectType: "binance-trading-competition", label: "Competition",   category: "Exchange", subcategory: "Binance", parentType: "binance-trading", enabled: true,  level: 5 },
  { projectType: "binance-trading-alpha",       label: "Alpha",         category: "Exchange", subcategory: "Binance", parentType: "binance-trading", enabled: true,  level: 5 },
  { projectType: "binance-instant-live",        label: "Live",          category: "Exchange", subcategory: "Binance", parentType: "binance-instant", enabled: true,  level: 5 },
  { projectType: "binance-instant-redpacket",   label: "Red Packet",    category: "Exchange", subcategory: "Binance", parentType: "binance-instant", enabled: true,  level: 5 },
  { projectType: "binance-instant-rewardhub",   label: "Reward Hub",    category: "Exchange", subcategory: "Binance", parentType: "binance-instant", enabled: true,  level: 5 },
  { projectType: "binance-instant-learn2earn",  label: "Learn to Earn", category: "Exchange", subcategory: "Binance", parentType: "binance-instant", enabled: true,  level: 5 },
  { projectType: "binance-web3-alpha",          label: "Alpha",         category: "Exchange", subcategory: "Binance", parentType: "binance-web3",    enabled: true,  level: 5 },
  { projectType: "binance-web3-booster",        label: "Booster",       category: "Exchange", subcategory: "Binance", parentType: "binance-web3",    enabled: true,  level: 5 },
  { projectType: "kucoin-trading-gempool",      label: "Gempool",       category: "Exchange", subcategory: "Kucoin",  parentType: "kucoin-trading",  enabled: true,  level: 5 },
  { projectType: "kucoin-trading-volume",       label: "Volume",        category: "Exchange", subcategory: "Kucoin",  parentType: "kucoin-trading",  enabled: true,  level: 5 },
  { projectType: "kucoin-trading-pnl",          label: "PnL",           category: "Exchange", subcategory: "Kucoin",  parentType: "kucoin-trading",  enabled: true,  level: 5 },
  // Pre-existing reserved node, not part of the requested Kucoin Trading
  // sub-type set (Gempool/Volume/PnL) — left disabled and unwired pending a
  // decision on whether it should ship too.
  { projectType: "kucoin-trading-competition",  label: "Competition",   category: "Exchange", subcategory: "Kucoin",  parentType: "kucoin-trading",  enabled: false, level: 5 },
];

// Only active (level-4, enabled) nodes participate in the sidebar / filters /
// create-form by default.
const ACTIVE_NODES = SIDEBAR_META_HIERARCHY.filter(n => n.enabled && n.level === 4);

// Helper: all unique categories (in order of first appearance)
export const DYNAMIC_CATEGORIES = Array.from(new Set(ACTIVE_NODES.map(n => n.category)));

// Helper: all subcategories for a given category
export function getSubcategories(category: string): string[] {
  return Array.from(new Set(ACTIVE_NODES.filter(n => n.category === category).map(n => n.subcategory)));
}

// Helper: all leaf types for a given subcategory
export function getTypesForSubcategory(subcategory: string): SidebarMetaNode[] {
  return ACTIVE_NODES.filter(n => n.subcategory === subcategory);
}

// Helper: look up a leaf node by its projectType/URL key
export function getMetaByTypeKey(projectType: string): SidebarMetaNode | undefined {
  return SIDEBAR_META_HIERARCHY.find(n => n.projectType === projectType);
}

// ─── OVERVIEW ROLLUPS ─────────────────────────────────────────────────────
// Every category and subcategory gets a sidebar "Overview" link. It doesn't
// filter to one project_type — it shows every project whose type falls
// anywhere underneath that node. Rollup URLs look like:
//   /projects                          → literally every project (root "Project")
//   /projects?rollup=Onchain           → every Onchain project
//   /projects?rollup=Exchange          → every Exchange project (all 4 platforms + Other)
//   /projects?rollup=Exchange:Binance  → every Binance project

export function getRollupTypes(rollup: string): string[] {
  const [category, subcategory] = rollup.split(":");
  return ACTIVE_NODES
    .filter(n => n.category === category && (!subcategory || n.subcategory === subcategory))
    .map(n => n.projectType);
}

// ─── EXCHANGE SUB-TYPES (legacy — kept only for old rows/back-compat) ─────
// The new Exchange taxonomy above no longer uses exchange_sub_type /
// account_category to branch the sidebar (each platform's own Trading /
// Instant / Refer / etc. types replace that), but the DB columns and these
// option lists are kept so already-created projects/forms referencing them
// don't break.

const EXCHANGE_SUB_TYPE_VALUES = [
  { id: "candydrop", label: "Candydrop" },
  { id: "candybomb", label: "Candybomb" },
  { id: "booster",   label: "Booster"   },
  { id: "trading_volume", label: "Trading Vol." },
];

export const EXCHANGE_SUB_TYPES = [
  { id: "all", label: "All Types" },
  ...EXCHANGE_SUB_TYPE_VALUES,
];

export const EXCHANGE_SUB_TYPE_OPTIONS = EXCHANGE_SUB_TYPE_VALUES.map(t => t.id);

export const ACCOUNT_CATEGORIES = [
  { id: "all", label: "All Accounts" },
  { id: "new", label: "New Account" },
  { id: "old", label: "Old Account" },
];

export const ACCOUNT_CATEGORY_OPTIONS = ["new", "old", "both"];
