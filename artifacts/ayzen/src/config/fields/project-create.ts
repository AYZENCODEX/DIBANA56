import { Globe, Zap, BookOpen, Tag, ImagePlus } from "lucide-react";
import type { FieldDef, GroupDef } from "@/config/types";
import {
  DYNAMIC_CATEGORIES,
  getSubcategories,
  getTypesForSubcategory,
} from "@/config/projects";

const opt = (values: string[]): { value: string; label: string }[] =>
  values.map(v => ({ value: v, label: v }));

export const PROJECT_CREATE_GROUPS: Record<string, GroupDef> = {
  media: {
    id: "media",
    label: "Photo & Banner",
    icon: ImagePlus,
    boxClassName: "rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-4 space-y-3",
    headerClassName: "text-fuchsia-400",
    help: "Photo shows in lists/cards; banner is the wide hero image on the project page.",
  },
  "social-links": {
    id: "social-links",
    label: "Social Links",
    icon: Globe,
    boxClassName: "rounded-lg border border-sky-500/20 bg-sky-500/5 p-4 space-y-3",
    headerClassName: "text-sky-400",
  },
  "xp-system": {
    id: "xp-system",
    label: "XP System",
    icon: Zap,
    boxClassName: "rounded-lg border border-primary/20 bg-primary/3 p-4 space-y-3",
    headerClassName: "text-primary",
    help: "XP earned from tasks × price = AZN auto-awarded on approval",
  },
  "tutorial-resource": {
    id: "tutorial-resource",
    label: "Tutorial Resource",
    icon: BookOpen,
    boxClassName: "rounded-lg border border-violet-500/20 bg-violet-500/5 p-4 space-y-3",
    headerClassName: "text-violet-400",
  },
  "meta-hierarchy": {
    id: "meta-hierarchy",
    label: "Sidebar Classification",
    icon: Tag,
    boxClassName: "rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-3",
    headerClassName: "text-amber-400",
    help: "Category → Subcategory → Type mirrors the sidebar hierarchy. Selecting a type auto-fills all parent fields.",
  },
};

export const PROJECT_CREATE_FIELDS: FieldDef[] = [
  // ── Basic ──────────────────────────────────────────────────────────
  {
    key: "name", label: "Protocol Name *", type: "text", tab: "basic",
    placeholder: "e.g. LayerZero, zkSync Era", required: true, autoFocus: true,
  },
  {
    key: "description", label: "Description", type: "textarea", tab: "basic",
    placeholder: "Describe the protocol and airdrop opportunity...", rows: 3,
  },
  {
    key: "thumbnailUrl", label: "Project Photo", type: "image", tab: "basic",
    group: "media", pairKey: "media-images", pairGap: "gap-3",
    help: "Square-ish image, shown on project cards",
  },
  {
    key: "bannerUrl", label: "Project Banner", type: "image", tab: "basic",
    group: "media", pairKey: "media-images",
    help: "Wide image, shown at the top of the project page",
  },
  {
    key: "twitterHandle", label: "Twitter Handle", type: "text", tab: "basic",
    group: "social-links", placeholder: "@protocol", compact: true,
  },
  {
    key: "discordUrl", label: "Discord URL", type: "text", tab: "basic",
    group: "social-links", pairKey: "social-urls", pairGap: "gap-2",
    placeholder: "https://discord.gg/...", compact: true,
  },
  {
    key: "websiteUrl", label: "Website URL", type: "text", tab: "basic",
    group: "social-links", pairKey: "social-urls", placeholder: "https://...", compact: true,
  },

  // ── Economics ──────────────────────────────────────────────────────
  {
    key: "xpName", label: "XP Token Name", type: "text", tab: "economics",
    group: "xp-system", pairKey: "xp-fields", placeholder: "e.g. TXP, ZXP", compact: true,
  },
  {
    key: "xpPrice", label: "1 XP = ? AZN", type: "number", tab: "economics",
    group: "xp-system", pairKey: "xp-fields", placeholder: "0.01", step: "0.001", min: "0", compact: true,
  },
  {
    key: "fundingAmount", label: "Funding Amount ($)", type: "number", tab: "economics",
    pairKey: "funding-reward", placeholder: "50000000",
  },
  {
    key: "rewardEstimate", label: "Est. Reward ($)", type: "number", tab: "economics",
    pairKey: "funding-reward", placeholder: "1000",
  },
  {
    key: "deadline", label: "Airdrop Deadline", type: "date", tab: "economics",
    help: "Leave blank if no known deadline",
  },

  // ── Meta — Dynamic Sidebar Hierarchy ─────────────────────────────────
  // Step 1: Category (mirrors sidebar top-level groups)
  {
    key: "category", label: "Category", type: "select", tab: "meta",
    group: "meta-hierarchy",
    uiVariant: "pills",
    options: opt(DYNAMIC_CATEGORIES),
    resetsFields: ["subcategory", "projectType"],
    help: "Maps to sidebar top-level category",
  },
  // Step 2: Subcategory — filtered to the chosen category. Flat categories
  // (Onchain/Web3/Social/App) just get one pill matching the category name;
  // Exchange gets its 4 platforms (Binance/Bitget/Kucoin/Bybit) plus a
  // generic "Other" bucket for exchange-wide projects here.
  {
    key: "subcategory", label: "Subcategory", type: "select", tab: "meta",
    group: "meta-hierarchy",
    uiVariant: "pills",
    dynamicOptions: (form) => opt(form.category ? getSubcategories(form.category) : []),
    showIf: (form) => !!form.category,
    resetsFields: ["projectType"],
    help: "For Exchange this is the platform (Binance/Bitget/Kucoin/Bybit) or Other",
  },
  // Step 3: Project Type — filtered to the chosen subcategory. This exact
  // value is what's stored as project_type and what the sidebar's ?type=
  // links filter on.
  {
    key: "projectType", label: "Project Type", type: "select", tab: "meta",
    group: "meta-hierarchy",
    uiVariant: "pills",
    dynamicOptions: (form) =>
      form.subcategory
        ? getTypesForSubcategory(form.subcategory).map(n => ({ value: n.projectType, label: n.label }))
        : [],
    showIf: (form) => !!form.subcategory,
    help: "This is the exact type stored in the DB and used for sidebar routing",
  },

  // ── Other meta fields ─────────────────────────────────────────────
  {
    key: "tier", label: "Tier", type: "select", tab: "meta", pairKey: "tier-experience",
    options: ["1", "2", "3", "4", "5"].map(t => ({ value: t, label: `Tier ${t}` })),
  },
  {
    key: "experienceLevel", label: "Experience Level", type: "select", tab: "meta", pairKey: "tier-experience",
    options: opt(["Beginner", "Intermediate", "Advanced", "Expert"]),
  },
  {
    key: "durationType", label: "Duration Type", type: "select", tab: "meta",
    uiVariant: "pills", options: opt(["long", "short", "instant", "micro"]),
    help: "Long = months · Short = weeks · Instant = days · Micro = hours",
  },
  {
    key: "difficulty", label: "Difficulty", type: "select", tab: "meta",
    uiVariant: "pills", options: opt(["easy", "average", "hard"]),
  },
  {
    key: "costType", label: "Cost Type", type: "select", tab: "meta",
    uiVariant: "pills", options: opt(["free", "paid"]),
    help: "Does completing this airdrop require spending gas/fees?",
  },

  // ── Tutorial ───────────────────────────────────────────────────────
  {
    key: "tutorialLink", label: "Tutorial URL", type: "text", tab: "tutorial",
    group: "tutorial-resource", placeholder: "https://youtube.com/watch?v=... or https://docs....", compact: true,
    help: "Operators will see this guide when they open the project",
    helpClassName: "text-[9px] font-mono text-muted-foreground/60",
  },
  {
    key: "tutorialSteps", label: "Tutorial Steps", type: "steps", tab: "tutorial",
    help: "Build a step-by-step walkthrough — operators see this as a numbered checklist when they open the project.",
    helpClassName: "text-[9px] font-mono text-muted-foreground/60",
  },
];
