import type { ElementType } from "react";
import { Award, Users, Github, Linkedin, Star, BarChart2, Mail, Facebook, MessageCircle } from "lucide-react";

// Centralized "local account" (social/platform account farming) config.
// See UI_CONFIG_PLAN.md Phase B — "Local account create/view".
//
// Two platform-meta shapes exist because two pages render platform info
// differently:
//   - LOCAL_ACCOUNT_PLATFORM_META: used by the Add/Edit Account form
//     (components/local-accounts.tsx) — hex color + farming tips, for the
//     "Platform" tab of the create dialog.
//   - LOCAL_ACCOUNT_DASHBOARD_META: used by the read-only stats dashboard
//     (pages/user/vault-local-dashboard.tsx) — Tailwind color/bg/border
//     classes, for badges and per-category summary cards.
// They were previously two independently-hardcoded `PLATFORM_META` consts
// with the same keys but different shapes (one per file). Centralizing them
// here means adding a platform is at most two entries in one file instead
// of edits scattered across both pages.

export interface LocalAccountPlatformMeta {
  metricLabel: string;
  metricPlaceholder: string;
  icon: ElementType;
  color: string; // hex, used inline (style={{ color }}) in the create form
  tips: string[];
}

export const LOCAL_ACCOUNT_PLATFORM_META: Record<string, LocalAccountPlatformMeta> = {
  Google: {
    metricLabel: "Points / Rewards",
    metricPlaceholder: "e.g. 2500",
    icon: Award,
    color: "#EA4335",
    tips: ["Check Google One rewards", "Track Maps contributions", "Monitor Play Points balance"],
  },
  Facebook: {
    metricLabel: "Friends / Followers",
    metricPlaceholder: "e.g. 500",
    icon: Users,
    color: "#1877F2",
    tips: ["Profile vs Page accounts behave differently", "Keep profile active to avoid lock"],
  },
  Twitter: {
    metricLabel: "Followers",
    metricPlaceholder: "e.g. 1200",
    icon: Users,
    color: "#1DA1F2",
    tips: ["Age 6+ months for airdrops", "Minimum 50 followers typical", "Keep bio + avatar set"],
  },
  Reddit: {
    metricLabel: "Karma",
    metricPlaceholder: "e.g. 1500",
    icon: Award,
    color: "#FF4500",
    tips: ["Post karma + comment karma matter", "2FA required by most projects", "Old accounts valued more"],
  },
  GitHub: {
    metricLabel: "Repositories",
    metricPlaceholder: "e.g. 12",
    icon: Github,
    color: "#6e40c9",
    tips: ["Contribution graph visibility matters", "Star relevant repos for whitelist", "Fork target repos"],
  },
  LinkedIn: {
    metricLabel: "Connections",
    metricPlaceholder: "e.g. 500+",
    icon: Linkedin,
    color: "#0A66C2",
    tips: ["500+ connections = 'Level 1' trust", "Keep industry set to crypto/web3", "Engage with protocol posts"],
  },
  Discord: {
    metricLabel: "Servers Joined",
    metricPlaceholder: "e.g. 15",
    icon: Users,
    color: "#5865F2",
    tips: ["Join official server first", "Verify in every server", "Boost servers for higher roles"],
  },
};

export function getLocalAccountPlatformMeta(category: string): LocalAccountPlatformMeta {
  return LOCAL_ACCOUNT_PLATFORM_META[category] ?? {
    metricLabel: "Social Metric",
    metricPlaceholder: "e.g. followers, points...",
    icon: Star,
    color: "#22d3ee",
    tips: ["Track your key metric for this platform"],
  };
}

export interface LocalAccountDashboardMeta {
  label: string;
  metricName: string;
  icon: ElementType;
  color: string;
  bg: string;
  border: string;
}

export const LOCAL_ACCOUNT_DASHBOARD_META: Record<string, LocalAccountDashboardMeta> = {
  Google:    { label: "Google / Gmail", metricName: "Points",      icon: Award,    color: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/20" },
  Facebook:  { label: "Facebook",       metricName: "Followers",   icon: Users,    color: "text-blue-400",   bg: "bg-blue-500/10",   border: "border-blue-500/20" },
  Instagram: { label: "Instagram",      metricName: "Followers",   icon: Users,    color: "text-pink-400",   bg: "bg-pink-500/10",   border: "border-pink-500/20" },
  Twitter:   { label: "Twitter / X",    metricName: "Followers",   icon: Users,    color: "text-sky-400",    bg: "bg-sky-500/10",    border: "border-sky-500/20" },
  LinkedIn:  { label: "LinkedIn",       metricName: "Connections", icon: Linkedin, color: "text-blue-500",   bg: "bg-blue-600/10",   border: "border-blue-600/20" },
  GitHub:    { label: "GitHub",         metricName: "Repos",       icon: Github,   color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/20" },
  Reddit:    { label: "Reddit",         metricName: "Karma",       icon: Star,     color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/20" },
  Discord:   { label: "Discord",        metricName: "Servers",     icon: Users,    color: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/20" },
};

export function getLocalAccountDashboardMeta(category: string): LocalAccountDashboardMeta {
  return LOCAL_ACCOUNT_DASHBOARD_META[category] ?? {
    label: category, metricName: "Metric", icon: BarChart2,
    color: "text-primary", bg: "bg-primary/10", border: "border-primary/20",
  };
}

export interface LocalAccountCategory {
  id: string | number;
  name: string;
  color: string;
  icon: string;
  isCustom?: boolean;
}

export const LOCAL_ACCOUNT_DEFAULT_CATEGORIES: LocalAccountCategory[] = [
  { id: "facebook", name: "Facebook", color: "#1877F2", icon: "F", isCustom: false },
  { id: "github",   name: "GitHub",   color: "#6e40c9", icon: "G", isCustom: false },
  { id: "google",   name: "Google",   color: "#EA4335", icon: "G", isCustom: false },
  { id: "twitter",  name: "Twitter",  color: "#1DA1F2", icon: "X", isCustom: false },
  { id: "discord",  name: "Discord",  color: "#5865F2", icon: "D", isCustom: false },
  { id: "linkedin", name: "LinkedIn", color: "#0A66C2", icon: "in", isCustom: false },
];

export const LOCAL_ACCOUNT_PLATFORM_GRADIENTS: Record<string, string> = {
  facebook: "from-blue-600/10 to-blue-400/5 border-blue-500/20",
  linkedin: "from-blue-700/10 to-blue-500/5 border-blue-600/20",
  github:   "from-purple-600/10 to-purple-400/5 border-purple-500/20",
  google:   "from-red-500/10 to-orange-400/5 border-red-400/20",
  twitter:  "from-sky-500/10 to-sky-400/5 border-sky-400/20",
  discord:  "from-indigo-500/10 to-indigo-400/5 border-indigo-400/20",
};

export function getLocalAccountPlatformGradient(cat: string) {
  return LOCAL_ACCOUNT_PLATFORM_GRADIENTS[cat.toLowerCase()] ?? "from-primary/8 to-transparent border-primary/20";
}

// ── Marketplace buy/sell category meta (marketplace-vault.tsx) ─────────────
// A third view of the same platform set as LOCAL_ACCOUNT_PLATFORM_META /
// LOCAL_ACCOUNT_DASHBOARD_META above, for the vault marketplace's category
// picker (lowercase ids, full icon+color+border+bg for pill buttons —
// matches this page's original casing/shape rather than force-fitting the
// other two views). Adding a category to the vault marketplace = one entry
// here (and, if it should also show up in the create-account dialog or
// dashboard, one entry in the matching map above).
export interface LocalAccountMarketMeta {
  id: string;
  label: string;
  icon: ElementType;
  color: string;
  border: string;
  bg: string;
}

export const LOCAL_ACCOUNT_MARKET_CATEGORIES: LocalAccountMarketMeta[] = [
  { id: "gmail",    label: "Gmail",    icon: Mail,          color: "text-red-400",    border: "border-red-400/30",    bg: "bg-red-400/10" },
  { id: "facebook", label: "Facebook", icon: Facebook,      color: "text-blue-400",   border: "border-blue-400/30",   bg: "bg-blue-400/10" },
  { id: "github",   label: "GitHub",   icon: Github,        color: "text-purple-400", border: "border-purple-400/30", bg: "bg-purple-400/10" },
  { id: "linkedin", label: "LinkedIn", icon: Linkedin,      color: "text-cyan-400",   border: "border-cyan-400/30",   bg: "bg-cyan-400/10" },
  { id: "reddit",   label: "Reddit",   icon: MessageCircle, color: "text-orange-400", border: "border-orange-400/30", bg: "bg-orange-400/10" },
];
