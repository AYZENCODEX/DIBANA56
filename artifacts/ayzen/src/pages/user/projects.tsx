import { useState, useEffect, useRef, useCallback } from "react";
import { useListProjects } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Link, useSearch } from "wouter";
import {
  Users, Wifi, WifiOff, Zap, LayoutGrid, Star, Clock, TrendingUp, ArrowLeftRight, FlaskConical, Timer, Globe,
  AppWindow, Network, MoreHorizontal, Rss, Cast, Rocket, Wallet, Building2, Cpu, Lock, Share2, Gamepad2,
  Boxes, Megaphone, FolderGit2, Scale, X,
  // Phase 4 — Exchange sidebar sub-type expansion
  Gift, Package, BarChart3, Sparkles, Gem, LineChart, Radio, Trophy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { TIER_COLORS, PROJECT_CATEGORIES, CATEGORY_COLORS, getRollupTypes } from "@/config/projects";
import { ProjectBadgeList } from "@/components/project/project-badge-list";

// Phase 6 — max number of projects that can be pinned into the side-by-side
// compare view at once (2 or 3, per the acceptance criteria).
const MAX_COMPARE = 3;

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function daysRemaining(deadline: string | null | undefined) {
  if (!deadline) return null;
  const diff = new Date(deadline).getTime() - Date.now();
  if (diff < 0) return -1;
  return Math.ceil(diff / 86_400_000);
}

function DeadlineChip({ deadline }: { deadline?: string | null }) {
  const days = daysRemaining(deadline);
  if (days === null) return null;
  if (days < 0) return <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border border-red-500/30 text-red-400 bg-red-500/5">ENDED</span>;
  if (days === 0) return <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border border-red-500/40 text-red-400 bg-red-500/10 animate-pulse">LAST DAY</span>;
  if (days <= 3) return <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-400 bg-amber-500/5">{days}d left</span>;
  if (days <= 7) return <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border border-yellow-500/30 text-yellow-400 bg-yellow-500/5">{days}d left</span>;
  return <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border border-border/40 text-muted-foreground/60">{days}d left</span>;
}

// ─── Presence hook ────────────────────────────────────────────────────────────
function useProjectPresence() {
  const { token } = useAuth();
  const [online, setOnline] = useState<Record<number, number[]>>({});
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const openES = (url: string, onMsg: (d: any) => void) => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.addEventListener("presence_updated", (e: MessageEvent) => {
      try { const d = JSON.parse(e.data); onMsg(d); } catch {}
    });
    es.addEventListener("projects_updated", () => setConnected(c => c));
    let retries = 0;
    es.onerror = () => {
      setConnected(false);
      es.close();
      if (unmounted.current) return;
      const delay = Math.min(1000 * Math.pow(2, retries++), 30_000);
      retryRef.current = setTimeout(() => {
        if (!unmounted.current) openES(url, onMsg);
      }, delay);
    };
    return es;
  };

  useEffect(() => {
    unmounted.current = false;
    if (!token) return;
    const encodedToken = encodeURIComponent(token);
    openES(
      `${BASE}/api/events?token=${encodedToken}`,
      (d) => { if (d.projectId && d.online) setOnline(prev => ({ ...prev, [d.projectId]: d.online })); }
    );
    return () => {
      unmounted.current = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      esRef.current?.close();
      setConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return { online, connected };
}

interface TypeMeta { title: string; desc: string; icon: React.ElementType; color: string }

// ─── Leaf type_meta — one entry per project_type leaf in SIDEBAR_META_HIERARCHY ───
// (config/projects.ts is the source of truth for which types exist; this is
// purely presentational — title/desc/icon/color shown on the header + mock
// preview cards for each leaf.)
const TYPE_META: Record<string, TypeMeta> = {
  // Onchain
  "onchain-mainnet": { title: "Onchain · Mainnet", desc: "Live network participation campaigns", icon: Network,      color: "text-emerald-400" },
  "onchain-testnet": { title: "Onchain · Testnet", desc: "Early network testing opportunities",   icon: FlaskConical, color: "text-orange-400" },

  // Exchange — Binance
  "binance-trading": { title: "Binance · Trading",  desc: "Binance trading volume campaigns",    icon: TrendingUp,     color: "text-yellow-400" },
  "binance-instant":  { title: "Binance · Instant",  desc: "Binance quick-completion campaigns",  icon: Zap,            color: "text-yellow-400" },
  "binance-web3":     { title: "Binance · Web3",     desc: "Binance Web3 wallet campaigns",       icon: Globe,          color: "text-yellow-400" },
  "binance-refer":    { title: "Binance · Refer",    desc: "Binance referral campaigns",          icon: Share2,         color: "text-yellow-400" },
  "binance-other":    { title: "Binance · Other",    desc: "Other Binance campaigns",             icon: MoreHorizontal, color: "text-muted-foreground" },

  // Exchange — Bitget
  "bitget-candybomb":  { title: "Bitget · CandyBomb",   desc: "Bitget CandyBomb campaigns",       icon: Zap,            color: "text-emerald-400" },
  "bitget-hold":       { title: "Bitget · Hold",        desc: "Bitget hold-to-earn campaigns",    icon: Lock,           color: "text-emerald-400" },
  "bitget-refer":      { title: "Bitget · Refer",       desc: "Bitget referral campaigns",        icon: Share2,         color: "text-emerald-400" },
  "bitget-other":      { title: "Bitget · Other",       desc: "Other Bitget campaigns",           icon: MoreHorizontal, color: "text-muted-foreground" },
  "bitget-mysterybox": { title: "Bitget · Mystery Box", desc: "Bitget Mystery Box campaigns",     icon: Gamepad2,       color: "text-emerald-400" },

  // Exchange — Binance — Phase 4 sub-types
  "binance-trading-volume":      { title: "Binance · Trading · Volume",      desc: "Binance trading volume campaigns",       icon: BarChart3, color: "text-yellow-400" },
  "binance-trading-competition": { title: "Binance · Trading · Competition", desc: "Binance trading competition campaigns",  icon: Trophy,    color: "text-yellow-400" },
  "binance-trading-alpha":       { title: "Binance · Trading · Alpha",       desc: "Binance Alpha trading campaigns",        icon: Sparkles,  color: "text-yellow-400" },
  "binance-instant-rewardhub":   { title: "Binance · Instant · Reward Hub",  desc: "Binance Reward Hub campaigns",           icon: Gift,      color: "text-yellow-400" },
  "binance-instant-redpacket":   { title: "Binance · Instant · Red Packet",  desc: "Binance Red Packet campaigns",           icon: Package,   color: "text-yellow-400" },
  "binance-instant-live":        { title: "Binance · Instant · Live",        desc: "Binance Live campaigns",                 icon: Radio,     color: "text-yellow-400" },
  "binance-instant-learn2earn":  { title: "Binance · Instant · Learn to Earn", desc: "Binance Learn to Earn campaigns",      icon: Rocket,    color: "text-yellow-400" },
  "binance-web3-booster":        { title: "Binance · Web3 · Booster",        desc: "Binance Web3 Booster campaigns",         icon: Rocket,    color: "text-yellow-400" },
  "binance-web3-alpha":          { title: "Binance · Web3 · Alpha",          desc: "Binance Web3 Alpha campaigns",           icon: Sparkles,  color: "text-yellow-400" },

  // Exchange — Kucoin
  "kucoin-trading":    { title: "Kucoin · Trading",       desc: "Kucoin trading volume campaigns", icon: TrendingUp,     color: "text-green-400" },
  "kucoin-refer":      { title: "Kucoin · Refer",         desc: "Kucoin referral campaigns",       icon: Share2,         color: "text-green-400" },
  "kucoin-learn2earn": { title: "Kucoin · Learn to Earn", desc: "Kucoin educational earn campaigns", icon: Rocket,       color: "text-green-400" },
  "kucoin-other":      { title: "Kucoin · Other",         desc: "Other Kucoin campaigns",          icon: MoreHorizontal, color: "text-muted-foreground" },

  // Exchange — Kucoin — Phase 4 sub-types
  "kucoin-trading-gempool": { title: "Kucoin · Trading · Gempool", desc: "Kucoin Gempool campaigns",     icon: Gem,       color: "text-green-400" },
  "kucoin-trading-volume":  { title: "Kucoin · Trading · Volume",  desc: "Kucoin trading volume campaigns", icon: BarChart3, color: "text-green-400" },
  "kucoin-trading-pnl":     { title: "Kucoin · Trading · PnL",     desc: "Kucoin PnL campaigns",         icon: LineChart, color: "text-green-400" },

  // Exchange — Bybit
  "bybit-hold":      { title: "Bybit · Hold",      desc: "Bybit hold-to-earn campaigns",   icon: Lock,           color: "text-orange-400" },
  "bybit-wednesday": { title: "Bybit · Wednesday", desc: "Bybit Wednesday campaigns",      icon: Timer,          color: "text-orange-400" },
  "bybit-refer":     { title: "Bybit · Refer",     desc: "Bybit referral campaigns",       icon: Share2,         color: "text-orange-400" },
  "bybit-other":     { title: "Bybit · Other",     desc: "Other Bybit campaigns",          icon: MoreHorizontal, color: "text-muted-foreground" },

  // Exchange — generic
  "exchange-other": { title: "Exchange · Other", desc: "Other exchange campaigns", icon: MoreHorizontal, color: "text-muted-foreground" },

  // Web3
  "web3-dex":   { title: "Web3 · Dex",   desc: "Decentralized exchange campaigns", icon: ArrowLeftRight,  color: "text-violet-400" },
  "web3-dapp":  { title: "Web3 · Dapp",  desc: "Decentralized application quests", icon: AppWindow,       color: "text-violet-400" },
  "web3-other": { title: "Web3 · Other", desc: "Other Web3 campaigns",             icon: MoreHorizontal,  color: "text-muted-foreground" },

  // Social
  "social-twitter":  { title: "Social · Twitter",  desc: "X / Twitter engagement quests",          icon: Rss,  color: "text-pink-400" },
  "social-warpcast": { title: "Social · Warpcast", desc: "Farcaster / Warpcast engagement quests",  icon: Cast, color: "text-pink-400" },

  // App
  "app-wallet": { title: "App · Wallet", desc: "Wallet app campaigns",  icon: Wallet, color: "text-fuchsia-400" },
  "app-mining": { title: "App · Mining", desc: "App mining reward campaigns", icon: Cpu,    color: "text-fuchsia-400" },
  "app-refer":  { title: "App · Refer",  desc: "App referral campaigns", icon: Share2, color: "text-fuchsia-400" },
};

// ─── Rollup meta — one entry per sidebar "Overview" leaf, keyed by the same
// ?rollup= value used in the sidebar links (see getRollupTypes in
// config/projects.ts). "Exchange:Binance" style keys cover a single platform;
// bare "Exchange" / "Onchain" / etc. cover the whole category. ───────────────
const ROLLUP_META: Record<string, TypeMeta> = {
  Onchain:            { title: "Onchain Overview",           desc: "Every onchain campaign",              icon: Boxes,          color: "text-cyan-400" },
  Exchange:           { title: "Exchange Overview",          desc: "Every exchange campaign, all platforms", icon: ArrowLeftRight, color: "text-yellow-400" },
  "Exchange:Binance": { title: "Binance Overview",           desc: "Every Binance campaign",              icon: Building2,      color: "text-yellow-400" },
  "Exchange:Bitget":  { title: "Bitget Overview",            desc: "Every Bitget campaign",                icon: Building2,      color: "text-emerald-400" },
  "Exchange:Kucoin":  { title: "Kucoin Overview",            desc: "Every Kucoin campaign",                icon: Building2,      color: "text-green-400" },
  "Exchange:Bybit":   { title: "Bybit Overview",             desc: "Every Bybit campaign",                 icon: Building2,      color: "text-orange-400" },
  Web3:               { title: "Web3 Overview",              desc: "Every Web3 campaign",                  icon: Globe,          color: "text-violet-400" },
  Social:             { title: "Social Overview",            desc: "Every social campaign",                icon: Megaphone,      color: "text-pink-400" },
  App:                { title: "App Overview",               desc: "Every app campaign",                   icon: AppWindow,      color: "text-fuchsia-400" },
};

const ROOT_META: TypeMeta = { title: "All Protocols", desc: "Every project across every category", icon: FolderGit2, color: "text-primary" };

function getHeaderMeta(rollupParam: string, typeParam: string): TypeMeta {
  if (rollupParam) return ROLLUP_META[rollupParam] ?? ROOT_META;
  if (typeParam) return TYPE_META[typeParam] ?? ROOT_META;
  return ROOT_META;
}

// Types that only exist in the sidebar so far — no backend project_type data yet.
// TODO(backend): shrink this set as each type starts getting real projects from the API.
const MOCK_ONLY_TYPES = new Set(Object.keys(TYPE_META));

// TODO(backend): delete this mock generator once every MOCK_ONLY_TYPES entry has real API data.
function mockProjectsFor(type: string) {
  const meta = TYPE_META[type] ?? ROOT_META;
  const names = ["Alpha", "Nova", "Vertex", "Orbit", "Pulse", "Nexus"];
  return names.map((n, i) => ({
    id: -1_000_000 - type.charCodeAt(0) * 100 - i, // negative id keeps mocks out of range of real project ids
    name: `${n} ${meta.title.split(" · ").pop()}`,
    description: `Preview campaign for ${meta.desc.toLowerCase()}. Mock data — real listings appear here once the backend starts returning project_type="${type}".`,
    category: "Other",
    tier: String((i % 4) + 1),
    xpPrice: 0.01,
    rewardEstimate: 50 + i * 25,
    fundingAmount: 0,
    project_type: type,
    __mock: true,
  }));
}

function useBookmarks() {
  const { token } = useAuth();
  const [bookmarks, setBookmarks] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("ayzen_bookmarks") ?? "[]")); } catch { return new Set(); }
  });

  const toggle = useCallback((id: number) => {
    setBookmarks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem("ayzen_bookmarks", JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);

  return { bookmarks, toggle };
}

export default function UserProjects() {
  const rawSearch = useSearch();
  const searchParams = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch);
  const typeParam = searchParams.get("type") ?? "";
  const rollupParam = searchParams.get("rollup") ?? "";

  const { data, isLoading } = useListProjects({ limit: 200 });
  const { online, connected } = useProjectPresence();
  const [selectedCategory, setSelectedCategory] = useState("All");
  const { bookmarks, toggle: toggleBookmark } = useBookmarks();
  const [showBookmarked, setShowBookmarked] = useState(false);
  const { toast } = useToast();

  // Phase 6 — Project comparison view: pin 2–3 real projects (mocks excluded,
  // they have nothing to compare) then jump to /projects/compare?ids=…
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const toggleCompare = useCallback((id: number) => {
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= MAX_COMPARE) {
        toast({ title: `You can compare up to ${MAX_COMPARE} projects at once` });
        return prev;
      }
      return [...prev, id];
    });
  }, [toast]);

  // Reset the category tab whenever the sidebar selection changes.
  useEffect(() => { setSelectedCategory("All"); }, [typeParam, rollupParam]);

  const typeMeta = getHeaderMeta(rollupParam, typeParam);

  // Root "Project" link → no filter at all, every type. A rollup link (an
  // Overview leaf) → every type under that category/subcategory. A leaf
  // link → exactly that one type.
  const activeTypes = rollupParam ? getRollupTypes(rollupParam) : (typeParam ? [typeParam] : null);

  const allProjectsRaw = data?.projects ?? [];
  // TODO(backend): once the API returns real project_type data for a MOCK_ONLY_TYPES
  // entry, this block stops injecting mocks for it automatically (see hasRealData check).
  const mockInjections = (activeTypes ?? []).flatMap(t => {
    if (!MOCK_ONLY_TYPES.has(t)) return [];
    const hasRealData = allProjectsRaw.some((p: any) => (p.project_type ?? "") === t);
    return hasRealData ? [] : mockProjectsFor(t);
  });
  const allProjects = mockInjections.length ? [...allProjectsRaw, ...mockInjections] : allProjectsRaw;

  const baseList = activeTypes
    ? allProjects.filter((p: any) => activeTypes.includes(p.project_type ?? ""))
    : allProjects;

  const filteredProjects = (() => {
    let list: any[] = [...baseList];
    // Category filter
    if (selectedCategory !== "All") {
      list = list.filter((p: any) => ((p as any).category ?? "Other") === selectedCategory);
    }
    if (showBookmarked) list = list.filter((p: any) => bookmarks.has(p.id));
    const starred = list.filter((p: any) => bookmarks.has(p.id));
    const rest = list.filter((p: any) => !bookmarks.has(p.id));
    return [...starred, ...rest];
  })();

  const categoryCounts = PROJECT_CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
    acc[cat] = cat === "All"
      ? baseList.length
      : baseList.filter((p: any) => ((p as any).category ?? "Other") === cat).length;
    return acc;
  }, {});

  return (
    <div className="space-y-6 page-enter">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className={cn("text-2xl font-bold font-mono tracking-tighter uppercase text-glow", typeMeta.color)}>
            {typeMeta.title}
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-0.5">
            {filteredProjects.length} campaigns{bookmarks.size > 0 && ` · ${bookmarks.size} starred`}
            {(typeParam || rollupParam) && <span className="ml-1 text-muted-foreground/50">· {typeMeta.desc}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBookmarked(v => !v)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-mono transition-all",
              showBookmarked
                ? "bg-amber-400/10 border-amber-400/30 text-amber-400"
                : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            <Star className={cn("w-3 h-3", showBookmarked && "fill-amber-400")} />
            Starred
          </button>
          <div className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-mono transition-all",
            connected
              ? "bg-emerald-400/10 border-emerald-400/20 text-emerald-400"
              : "bg-muted border-card-border text-muted-foreground"
          )}>
            {connected
              ? <Wifi className="w-3 h-3 animate-pulse" />
              : <WifiOff className="w-3 h-3" />}
            {connected ? "LIVE" : "OFFLINE"}
          </div>
        </div>
      </div>

      {/* Category tabs */}
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <div className="flex gap-1 min-w-max">
          {PROJECT_CATEGORIES.map(cat => {
            const count = categoryCounts[cat] ?? 0;
            const isActive = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-mono font-medium transition-all whitespace-nowrap border",
                  isActive
                    ? "bg-primary/15 border-primary/40 text-primary shadow-sm"
                    : "bg-card/50 border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                )}
              >
                {cat === "All" && <LayoutGrid className="w-3 h-3" />}
                {cat}
                {count > 0 && (
                  <span className={cn(
                    "text-[9px] font-mono px-1.5 py-0.5 rounded-full",
                    isActive
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground/60"
                  )}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Project grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 stagger-children">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="bg-card border-card-border shadow-none">
              <CardHeader className="pb-2"><Skeleton className="h-6 w-3/4" /></CardHeader>
              <CardContent><Skeleton className="h-16 w-full" /></CardContent>
            </Card>
          ))
        ) : filteredProjects.length === 0 ? (
          <div className="col-span-full py-16 text-center font-mono text-muted-foreground bg-card border border-card-border rounded-lg">
            <LayoutGrid className="w-8 h-8 mx-auto mb-3 opacity-20" />
            <p className="text-sm">No {selectedCategory !== "All" ? selectedCategory : ""} protocols available.</p>
            {selectedCategory !== "All" && (
              <button
                onClick={() => setSelectedCategory("All")}
                className="mt-2 text-xs text-primary hover:underline font-mono"
              >
                View all categories
              </button>
            )}
          </div>
        ) : (
          filteredProjects.map((project) => {
            const onlineCount = online[project.id]?.length ?? 0;
            const category = (project as any).category ?? "Other";
            const catColor = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.Other;

            return (
              <Card
                key={project.id}
                className="bg-card border-card-border shadow-none hover:border-primary/40 transition-all flex flex-col card-lift overflow-hidden"
              >
                {(project as any).bannerUrl && (
                  <div className="h-20 -mb-2 overflow-hidden">
                    <img src={(project as any).bannerUrl} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {(project as any).thumbnailUrl && (
                            <img src={(project as any).thumbnailUrl} alt="" className="w-6 h-6 rounded-md object-cover border border-card-border flex-shrink-0" />
                          )}
                          <CardTitle className="font-mono font-bold text-primary truncate">
                            {project.name}
                          </CardTitle>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {!(project as any).__mock && (
                            <label
                              onClick={e => e.preventDefault()}
                              title={compareIds.includes(project.id) ? "Remove from compare" : "Add to compare"}
                              className={cn(
                                "flex items-center gap-1 px-1 py-1 rounded cursor-pointer transition-all",
                                compareIds.includes(project.id) ? "text-primary" : "text-muted-foreground/30 hover:text-primary"
                              )}
                            >
                              <Checkbox
                                checked={compareIds.includes(project.id)}
                                onCheckedChange={() => toggleCompare(project.id)}
                                className="w-3.5 h-3.5"
                              />
                            </label>
                          )}
                          <button
                            onClick={e => { e.preventDefault(); toggleBookmark(project.id); }}
                            className={cn(
                              "flex-shrink-0 p-1 rounded transition-all",
                              bookmarks.has(project.id)
                                ? "text-amber-400 hover:text-amber-300"
                                : "text-muted-foreground/30 hover:text-amber-400"
                            )}
                            title={bookmarks.has(project.id) ? "Remove bookmark" : "Bookmark"}
                          >
                            <Star className={cn("w-3.5 h-3.5", bookmarks.has(project.id) && "fill-amber-400")} />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {/* Category badge */}
                        <Badge variant="outline" className={cn("font-mono text-[9px] uppercase rounded-sm", catColor)}>
                          {category}
                        </Badge>
                        {/* Tier badge */}
                        <Badge variant="outline" className={cn("font-mono text-[10px] uppercase rounded-sm", TIER_COLORS[String(project.tier)] ?? "border-card-border")}>
                          T{project.tier}
                        </Badge>
                        {/* Deadline chip */}
                        <DeadlineChip deadline={(project as any).deadline} />
                        {/* Live users */}
                        {onlineCount > 0 && (
                          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-400/10 border border-emerald-400/20 rounded text-[9px] font-mono text-emerald-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            {onlineCount}
                          </div>
                        )}
                      </div>
                      {/* Phase 7B — badges/tags (7A data), shown on the card with no click needed */}
                      <ProjectBadgeList badges={(project as any).badges} className="mt-1.5" />
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="flex-1">
                  <p className="text-sm text-muted-foreground line-clamp-3 mb-3 leading-relaxed">
                    {project.description}
                  </p>
                  {/* Visual progress bar */}
                  {(project as any).completionPct !== undefined && (
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">Progress</span>
                        <span className="text-[9px] font-mono text-primary">{Math.round((project as any).completionPct ?? 0)}%</span>
                      </div>
                      <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-primary/60 to-primary rounded-full transition-all duration-700"
                          style={{ width: `${Math.min(100, (project as any).completionPct ?? 0)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs font-mono">
                    <div>
                      <span className="text-muted-foreground">Est. Reward: </span>
                      <span className="text-primary font-bold">
                        ${project.rewardEstimate?.toLocaleString() || "TBA"}
                      </span>
                    </div>
                    {onlineCount > 0 && (
                      <div className="flex items-center gap-1 text-muted-foreground/60">
                        <Users className="w-3 h-3" />
                        <span>{onlineCount} online</span>
                      </div>
                    )}
                  </div>
                </CardContent>

                <CardFooter className="pt-0">
                  {(project as any).__mock ? (
                    // TODO(backend): remove this branch once real projects exist for this type
                    <Button
                      variant="outline"
                      disabled
                      className="w-full font-mono uppercase text-xs border-border/30 text-muted-foreground/50 gap-2 cursor-not-allowed"
                      title="Preview only — real campaigns land here once the backend is wired up"
                    >
                      <Clock className="w-3 h-3" /> Preview
                    </Button>
                  ) : (
                    <Link href={`/projects/${project.id}`} className="w-full">
                      <Button
                        variant="outline"
                        className="w-full font-mono uppercase text-xs border-primary/20 text-primary hover:bg-primary/10 gap-2 mobile-tap"
                      >
                        <Zap className="w-3 h-3" /> Access Terminal
                      </Button>
                    </Link>
                  )}
                </CardFooter>
              </Card>
            );
          })
        )}
      </div>

      {/* Phase 6 — Compare bar: appears once at least one project is pinned */}
      {compareIds.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-card border border-primary/30 shadow-lg rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <Scale className="w-3.5 h-3.5 text-primary" />
            {compareIds.length} / {MAX_COMPARE} selected
          </div>
          <button
            onClick={() => setCompareIds([])}
            className="p-1 rounded text-muted-foreground/50 hover:text-foreground transition-all"
            title="Clear selection"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          {compareIds.length >= 2 ? (
            <Link href={`/projects/compare?ids=${compareIds.join(",")}`}>
              <Button size="sm" className="font-mono text-xs uppercase gap-1.5">
                <Scale className="w-3 h-3" /> Compare
              </Button>
            </Link>
          ) : (
            <Button size="sm" disabled className="font-mono text-xs uppercase gap-1.5">
              <Scale className="w-3 h-3" /> Pick 1 more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
