import { useState, useEffect } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  DollarSign, Link2, Trophy, Share2, Plus, Trash2, Copy,
  Check, ToggleLeft, ToggleRight, Zap, TrendingUp, MousePointerClick,
  RefreshCw, ExternalLink, PlayCircle, Coins,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Season 1 / Phase 2 — sidebar now deep-links here as /earn?tab=link-to-earn and
// /earn?tab=watch-ads. Internal tab id for the existing links feature stays
// "links" (smaller diff than renaming it everywhere) — this just maps the URL's
// tab id to/from the internal one.
type EarnTab = "overview" | "links" | "watch-ads";
const URL_TO_TAB: Record<string, EarnTab> = { overview: "overview", links: "links", "link-to-earn": "links", "watch-ads": "watch-ads" };
const TAB_TO_URL: Record<EarnTab, string> = { overview: "overview", links: "link-to-earn", "watch-ads": "watch-ads" };

// TODO(backend): mock "available ads" list + reward amounts. Needs a real
// ad-provider integration (e.g. rewarded video SDK) and a backend endpoint to
// verify a watch was completed and credit AZN — this tab is a preview only.
interface MockAd { id: number; title: string; thumbnailColor: string; reward: number; durationSec: number; }
const WATCH_ADS_MOCK: MockAd[] = [
  { id: 1, title: "Sponsored: DeFi Wallet Spotlight", thumbnailColor: "from-primary/40 to-primary/10", reward: 0.02, durationSec: 15 },
  { id: 2, title: "Sponsored: NFT Drop Teaser",        thumbnailColor: "from-violet-400/40 to-violet-400/10", reward: 0.015, durationSec: 20 },
  { id: 3, title: "Sponsored: Exchange Promo",         thumbnailColor: "from-amber-400/40 to-amber-400/10", reward: 0.03, durationSec: 30 },
];

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface EarnLink {
  id: number;
  title: string;
  target_url: string;
  code: string;
  azn_per_click: number;
  click_count: number;
  earned_azn: number;
  is_active: boolean;
  created_at: string;
}

export default function EarnPage() {
  const rawSearch = useSearch();
  const [, setLocation] = useLocation();
  const urlTabParam = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch).get("tab") ?? "";
  const [tab, setTabState] = useState<EarnTab>(URL_TO_TAB[urlTabParam] ?? "overview");
  // Keep local tab state in sync if the URL changes (e.g. sidebar nav while already on /earn)
  useEffect(() => { setTabState(URL_TO_TAB[urlTabParam] ?? "overview"); }, [urlTabParam]);
  const setTab = (t: EarnTab) => { setTabState(t); setLocation(`/earn?tab=${TAB_TO_URL[t]}`); };

  const [links, setLinks] = useState<EarnLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", targetUrl: "", aznPerClick: "0.005" });
  const [copiedCode, setCopiedCode] = useState<number | null>(null);
  // Watch Ads mock state — local/session only, not persisted. TODO(backend): see WATCH_ADS_MOCK above.
  const [watchingAdId, setWatchingAdId] = useState<number | null>(null);
  const [watchProgress, setWatchProgress] = useState(0);
  const [sessionAdEarnings, setSessionAdEarnings] = useState(0);
  const { toast } = useToast();

  const token = localStorage.getItem("ayzen_token") ?? "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/earn-links`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setLinks(await r.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const totalClicks = links.reduce((s, l) => s + (l.click_count ?? 0), 0);
  const totalEarned = links.reduce((s, l) => s + (l.earned_azn ?? 0), 0);
  const activeLinks = links.filter(l => l.is_active).length;

  const handleCreate = async () => {
    if (!form.targetUrl.trim()) { toast({ variant: "destructive", title: "Enter a target URL" }); return; }
    setCreating(true);
    try {
      const r = await fetch(`${BASE}/api/earn-links`, {
        method: "POST", headers,
        body: JSON.stringify({ title: form.title.trim() || undefined, targetUrl: form.targetUrl.trim(), aznPerClick: Number(form.aznPerClick) }),
      });
      const d = await r.json();
      if (r.ok) {
        toast({ title: "✅ Link created", description: `Code: ${d.code}` });
        setLinks(l => [d, ...l]);
        setForm({ title: "", targetUrl: "", aznPerClick: "0.005" });
        setShowForm(false);
      } else toast({ variant: "destructive", title: d.error ?? "Failed" });
    } finally { setCreating(false); }
  };

  const handleDelete = async (id: number) => {
    await fetch(`${BASE}/api/earn-links/${id}`, { method: "DELETE", headers });
    setLinks(l => l.filter(x => x.id !== id));
    toast({ title: "Link removed" });
  };

  const handleToggle = async (link: EarnLink) => {
    await fetch(`${BASE}/api/earn-links/${link.id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ isActive: !link.is_active }),
    });
    setLinks(l => l.map(x => x.id === link.id ? { ...x, is_active: !x.is_active } : x));
  };

  const copyLink = (link: EarnLink) => {
    const url = `${window.location.origin}${BASE}/api/r/${link.code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedCode(link.id);
      setTimeout(() => setCopiedCode(null), 2000);
    });
  };

  const TABS = [
    { id: "overview" as const, label: "Overview", icon: TrendingUp },
    { id: "links" as const, label: "Link Earn", icon: Link2 },
    { id: "watch-ads" as const, label: "Watch Ads", icon: PlayCircle },
  ];

  // TODO(backend): replace this local timer with real ad-provider completion callbacks
  useEffect(() => {
    if (watchingAdId === null) return;
    const ad = WATCH_ADS_MOCK.find(a => a.id === watchingAdId);
    if (!ad) return;
    setWatchProgress(0);
    const stepMs = 100;
    const totalSteps = (ad.durationSec * 1000) / stepMs;
    let step = 0;
    const interval = setInterval(() => {
      step += 1;
      setWatchProgress(Math.min(100, Math.round((step / totalSteps) * 100)));
      if (step >= totalSteps) {
        clearInterval(interval);
        setSessionAdEarnings(v => v + ad.reward);
        toast({ title: "✅ Reward earned", description: `+${ad.reward.toFixed(3)} AZN (preview only — not saved)` });
        setWatchingAdId(null);
      }
    }, stepMs);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchingAdId]);

  return (
    <div className="space-y-6 page-enter">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-primary" /> Earn Center
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-0.5">Leaderboard rewards, referrals & link income</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2.5 text-xs font-mono uppercase tracking-wider border-b-2 -mb-px transition-all",
                tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="w-3 h-3" />{t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <div className="space-y-6 animate-fade-in">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Link Clicks", value: totalClicks.toLocaleString(), icon: MousePointerClick, color: "text-primary" },
              { label: "AZN Earned", value: totalEarned.toFixed(4), icon: Zap, color: "text-amber-400" },
              { label: "Active Links", value: activeLinks.toString(), icon: Link2, color: "text-emerald-400" },
              { label: "Total Links", value: links.length.toString(), icon: DollarSign, color: "text-violet-400" },
            ].map(stat => {
              const Icon = stat.icon;
              return (
                <div key={stat.label} className="bg-card border border-card-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{stat.label}</span>
                    <Icon className={cn("w-3.5 h-3.5", stat.color)} />
                  </div>
                  <div className={cn("font-mono text-xl font-bold", stat.color)}>{stat.value}</div>
                </div>
              );
            })}
          </div>

          {/* Earn options grid */}
          <div className="grid sm:grid-cols-3 gap-4 stagger-children">
            <Link href="/leaderboard">
              <div className="bg-card border border-card-border hover:border-amber-400/40 rounded-xl p-5 cursor-pointer transition-all card-lift group">
                <Trophy className="w-8 h-8 text-amber-400 mb-3 group-hover:scale-110 transition-transform" />
                <div className="font-mono font-bold text-sm mb-1">Leaderboard</div>
                <div className="font-mono text-xs text-muted-foreground">Top operators earn bonus AZN rewards every week</div>
                <div className="mt-3 flex items-center gap-1 text-[10px] font-mono text-amber-400">
                  View Leaderboard <ExternalLink className="w-3 h-3" />
                </div>
              </div>
            </Link>
            <Link href="/referrals">
              <div className="bg-card border border-card-border hover:border-pink-400/40 rounded-xl p-5 cursor-pointer transition-all card-lift group">
                <Share2 className="w-8 h-8 text-pink-400 mb-3 group-hover:scale-110 transition-transform" />
                <div className="font-mono font-bold text-sm mb-1">Referrals</div>
                <div className="font-mono text-xs text-muted-foreground">Invite operators and earn % of their task rewards</div>
                <div className="mt-3 flex items-center gap-1 text-[10px] font-mono text-pink-400">
                  Get Referral Link <ExternalLink className="w-3 h-3" />
                </div>
              </div>
            </Link>
            <div
              onClick={() => setTab("links")}
              className="bg-card border border-card-border hover:border-primary/40 rounded-xl p-5 cursor-pointer transition-all card-lift group"
            >
              <Link2 className="w-8 h-8 text-primary mb-3 group-hover:scale-110 transition-transform" />
              <div className="font-mono font-bold text-sm mb-1">Link Earn</div>
              <div className="font-mono text-xs text-muted-foreground">Create trackable links. Earn AZN every time someone clicks</div>
              <div className="mt-3 flex items-center gap-1 text-[10px] font-mono text-primary">
                Create Link <ExternalLink className="w-3 h-3" />
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "links" && (
        <div className="space-y-4 animate-fade-in">
          {/* Create form */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-sm text-muted-foreground">
                Each click on your link earns you AZN automatically
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={load} className="font-mono text-xs gap-1.5 h-8">
                <RefreshCw className="w-3 h-3" />
              </Button>
              <Button size="sm" onClick={() => setShowForm(f => !f)} className="font-mono text-xs gap-1.5 h-8">
                <Plus className="w-3 h-3" /> New Link
              </Button>
            </div>
          </div>

          {showForm && (
            <div className="bg-card border border-primary/20 rounded-xl p-5 space-y-4 animate-slide-up">
              <div className="font-mono text-xs font-bold text-primary uppercase tracking-widest">Create Earn Link</div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Link Title</label>
                  <Input
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="My Airdrop Guide"
                    className="font-mono text-xs h-9 bg-input border-border focus-visible:ring-primary/50"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">AZN Per Click</label>
                  <Input
                    type="number"
                    value={form.aznPerClick}
                    onChange={e => setForm(f => ({ ...f, aznPerClick: e.target.value }))}
                    min="0.001"
                    step="0.001"
                    className="font-mono text-xs h-9 bg-input border-border focus-visible:ring-primary/50"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Target URL <span className="text-red-400">*</span>
                </label>
                <Input
                  value={form.targetUrl}
                  onChange={e => setForm(f => ({ ...f, targetUrl: e.target.value }))}
                  placeholder="https://..."
                  className="font-mono text-xs h-9 bg-input border-border focus-visible:ring-primary/50"
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleCreate} disabled={creating || !form.targetUrl.trim()} className="font-mono text-xs gap-1.5 h-8">
                  {creating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  Create Link
                </Button>
                <Button variant="outline" onClick={() => setShowForm(false)} className="font-mono text-xs h-8">Cancel</Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
            </div>
          ) : links.length === 0 ? (
            <div className="bg-card border border-card-border rounded-xl p-10 text-center">
              <Link2 className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
              <p className="font-mono text-sm text-muted-foreground">No earn links yet</p>
              <p className="font-mono text-xs text-muted-foreground/50 mt-1">Create your first link to start earning AZN per click</p>
            </div>
          ) : (
            <div className="space-y-2 stagger-children">
              {links.map(link => {
                const shareUrl = `${window.location.origin}${BASE}/api/r/${link.code}`;
                const copied = copiedCode === link.id;
                return (
                  <div key={link.id} className={cn(
                    "bg-card border rounded-xl px-4 py-3 flex items-center gap-3 transition-all",
                    link.is_active ? "border-card-border" : "border-border/30 opacity-60"
                  )}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-medium truncate">{link.title || "Untitled"}</span>
                        <Badge variant="outline" className={cn(
                          "font-mono text-[9px] uppercase",
                          link.is_active ? "border-emerald-400/30 text-emerald-400" : "border-muted-foreground/30 text-muted-foreground"
                        )}>
                          {link.is_active ? "Active" : "Paused"}
                        </Badge>
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
                        <span className="text-primary/70">{link.code}</span>
                        {" · "}{link.click_count ?? 0} clicks
                        {" · "}<span className="text-amber-400">{(link.earned_azn ?? 0).toFixed(4)} AZN</span>
                        {" · "}{link.azn_per_click} AZN/click
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => copyLink(link)}
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30 flex items-center justify-center transition-all"
                        title="Copy link"
                      >
                        {copied ? <Check className="w-3 h-3 text-primary" /> : <Copy className="w-3 h-3" />}
                      </button>
                      <button
                        onClick={() => handleToggle(link)}
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-foreground flex items-center justify-center transition-all"
                        title={link.is_active ? "Pause" : "Activate"}
                      >
                        {link.is_active
                          ? <ToggleRight className="w-3.5 h-3.5 text-emerald-400" />
                          : <ToggleLeft className="w-3.5 h-3.5" />}
                      </button>
                      <a
                        href={link.target_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30 flex items-center justify-center transition-all"
                        title="Open target URL"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <button
                        onClick={() => handleDelete(link.id)}
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-red-400 hover:border-red-400/30 flex items-center justify-center transition-all"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "watch-ads" && (
        <div className="space-y-4 animate-fade-in">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="font-mono text-sm text-muted-foreground">
              Watch a short ad to earn AZN. Preview only — rewards here aren't saved to your balance yet.
            </p>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 text-amber-400 font-mono text-xs">
              <Coins className="w-3.5 h-3.5" /> {sessionAdEarnings.toFixed(3)} AZN this session
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
            {WATCH_ADS_MOCK.map(ad => {
              const isWatching = watchingAdId === ad.id;
              return (
                <div key={ad.id} className="bg-card border border-card-border rounded-xl overflow-hidden card-lift">
                  <div className={cn("h-24 bg-gradient-to-br flex items-center justify-center", ad.thumbnailColor)}>
                    <PlayCircle className="w-8 h-8 text-foreground/70" />
                  </div>
                  <div className="p-4 space-y-2">
                    <div className="font-mono text-sm font-medium leading-snug">{ad.title}</div>
                    <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                      <span>{ad.durationSec}s</span>
                      <span className="text-amber-400">+{ad.reward.toFixed(3)} AZN</span>
                    </div>
                    {isWatching ? (
                      <div className="space-y-1.5">
                        <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${watchProgress}%` }} />
                        </div>
                        <div className="text-[10px] font-mono text-center text-muted-foreground">Watching… {watchProgress}%</div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => setWatchingAdId(ad.id)}
                        disabled={watchingAdId !== null}
                        className="w-full font-mono text-xs gap-1.5 h-8"
                      >
                        <PlayCircle className="w-3.5 h-3.5" /> Watch
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
