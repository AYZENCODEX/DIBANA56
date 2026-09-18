import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Image, Plus, X, Heart, ShoppingCart, Sparkles,
  Tag, Wallet, RefreshCw, Star, Layers, Eye,
  Filter, TrendingUp, BarChart3,
} from "lucide-react";

import { NFT_RARITY_CONFIG } from "@/config/marketplace-nft";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts?.headers ?? {}) } });

// Rarity badge config now lives in @/config/marketplace-nft.ts as
// NFT_RARITY_CONFIG. Adding a rarity tier is one entry there.
const RARITY_CONFIG = NFT_RARITY_CONFIG;

const NFT_PLACEHOLDERS = [
  "https://picsum.photos/seed/nft1/400/400",
  "https://picsum.photos/seed/nft2/400/400",
  "https://picsum.photos/seed/nft3/400/400",
  "https://picsum.photos/seed/nft4/400/400",
  "https://picsum.photos/seed/nft5/400/400",
  "https://picsum.photos/seed/nft6/400/400",
];

export default function MarketplaceNft() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [listings, setListings] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showMint, setShowMint] = useState(false);
  const [minting, setMinting] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [sort, setSort] = useState("newest");
  const [form, setForm] = useState({ name: "", description: "", price: "", category: "collectible", rarity: "common", collection: "", image_url: "" });
  const [liking, setLiking] = useState<number | null>(null);
  const [buying, setBuying] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, limit: "50" });
      if (filter !== "all") params.set("rarity", filter);
      const [l, s, w] = await Promise.all([
        api(`/marketplace/nft/listings?${params}`).then(r => r.json()),
        api("/marketplace/nft/stats").then(r => r.json()),
        api("/marketplace/wallet").then(r => r.json()),
      ]);
      setListings(l.listings ?? []);
      setStats(s);
      setWallet(w?.nft ?? null);
    } catch {}
    setLoading(false);
  }, [filter, sort]);

  useEffect(() => { load(); }, [load]);

  const handleMint = async () => {
    if (!form.name || !form.price) { toast({ title: "Name and price required" }); return; }
    setMinting(true);
    try {
      const r = await api("/marketplace/nft/listings", { method: "POST", body: JSON.stringify({ ...form, price: Number(form.price) }) });
      const d = await r.json();
      if (!r.ok) toast({ variant: "destructive", title: d.error });
      else { toast({ title: `NFT "${form.name}" minted!` }); setShowMint(false); setForm({ name: "", description: "", price: "", category: "collectible", rarity: "common", collection: "", image_url: "" }); load(); }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setMinting(false);
  };

  const handleBuy = async (id: number) => {
    setBuying(id);
    try {
      const r = await api("/marketplace/nft/buy", { method: "POST", body: JSON.stringify({ listing_id: id }) });
      const d = await r.json();
      if (!r.ok) toast({ variant: "destructive", title: d.error });
      else { toast({ title: `NFT purchased! "${d.nft_name}"` }); load(); }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setBuying(null);
  };

  const handleLike = async (id: number) => {
    setLiking(id);
    await api(`/marketplace/nft/listings/${id}/like`, { method: "POST" });
    setLiking(null);
    load();
  };

  const imgFor = (l: any) => l.image_url || NFT_PLACEHOLDERS[l.id % NFT_PLACEHOLDERS.length];

  return (
    <div className="space-y-6 page-enter">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
              <Image className="w-4 h-4 text-violet-400" />
            </div>
            <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">NFT Market</h1>
            <Badge variant="outline" className="font-mono text-[10px] border-violet-400/30 text-violet-400 bg-violet-400/5">BETA</Badge>
          </div>
          <p className="text-muted-foreground font-mono text-sm">Mint, collect & trade AYZEN NFTs · Independent wallet</p>
        </div>
        <Button onClick={() => setShowMint(v => !v)} className="font-mono text-xs gap-2 bg-violet-600 hover:bg-violet-700 text-white border-0">
          <Sparkles className="w-3.5 h-3.5" /> Mint NFT
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Listed", value: stats?.active_listings ?? "—", icon: Layers, color: "text-violet-400" },
          { label: "Floor Price", value: `${stats?.floor_price?.toFixed(0) ?? "—"} AZN`, icon: Tag, color: "text-primary" },
          { label: "Total Volume", value: `${stats?.total_volume?.toFixed(0) ?? "—"} AZN`, icon: BarChart3, color: "text-emerald-400" },
          { label: "NFT Wallet", value: `${wallet?.balance?.toFixed(0) ?? "0"} AZN`, icon: Wallet, color: "text-amber-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/60">{s.label}</span>
              <s.icon className={cn("w-3.5 h-3.5", s.color)} />
            </div>
            <div className={cn("font-mono font-bold text-lg", s.color)}>{loading ? <Skeleton className="h-6 w-16" /> : s.value}</div>
          </div>
        ))}
      </div>

      {/* Mint form */}
      {showMint && (
        <div className="bg-card border border-violet-500/30 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-violet-400 font-bold flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5" /> Mint New NFT
            </h3>
            <button onClick={() => setShowMint(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Name *</label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="AYZEN Genesis #1" className="font-mono text-sm" />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Price (AZN) *</label>
              <Input value={form.price} onChange={e => setForm(p => ({ ...p, price: e.target.value }))} placeholder="500" className="font-mono text-sm" />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Rarity</label>
              <select value={form.rarity} onChange={e => setForm(p => ({ ...p, rarity: e.target.value }))} className="w-full h-10 bg-input border border-border rounded-md font-mono text-sm px-3 text-foreground">
                {Object.keys(RARITY_CONFIG).map(r => <option key={r} value={r}>{RARITY_CONFIG[r as keyof typeof RARITY_CONFIG].label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Category</label>
              <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} className="w-full h-10 bg-input border border-border rounded-md font-mono text-sm px-3 text-foreground">
                {["collectible", "art", "gaming", "music", "sports", "utility"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Collection</label>
              <Input value={form.collection} onChange={e => setForm(p => ({ ...p, collection: e.target.value }))} placeholder="AYZEN Genesis" className="font-mono text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Image URL</label>
              <Input value={form.image_url} onChange={e => setForm(p => ({ ...p, image_url: e.target.value }))} placeholder="https://..." className="font-mono text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Description</label>
              <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Describe your NFT..." className="font-mono text-sm" />
            </div>
          </div>
          <Button onClick={handleMint} disabled={minting} className="w-full font-mono text-xs bg-violet-600 hover:bg-violet-700 text-white border-0">
            {minting ? "Minting..." : "Mint & List NFT"}
          </Button>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        {["all", ...Object.keys(RARITY_CONFIG)].map(r => (
          <button key={r} onClick={() => setFilter(r)} className={cn("px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-all", filter === r ? "bg-violet-500/15 text-violet-400 border-violet-400/30" : "text-muted-foreground border-border/30 hover:border-border")}>
            {r === "all" ? "All" : RARITY_CONFIG[r as keyof typeof RARITY_CONFIG]?.label ?? r}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <select value={sort} onChange={e => setSort(e.target.value)} className="h-8 bg-input border border-border rounded font-mono text-[10px] px-2 text-foreground">
            <option value="newest">Newest</option>
            <option value="price_asc">Price ↑</option>
            <option value="price_desc">Price ↓</option>
            <option value="popular">Popular</option>
          </select>
        </div>
      </div>

      {/* NFT Grid */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground/40 font-mono text-sm">No NFTs listed. Be the first to mint!</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {listings.map(l => {
            const rCfg = RARITY_CONFIG[l.rarity as keyof typeof RARITY_CONFIG] ?? RARITY_CONFIG.common;
            const isMine = l.seller_id === user?.id;
            const likedBy: number[] = (() => { try { return JSON.parse(l.liked_by ?? "[]"); } catch { return []; } })();
            const isLiked = likedBy.includes(user?.id ?? 0);
            return (
              <div key={l.id} className="bg-card border border-card-border hover:border-violet-400/40 transition-all rounded-xl overflow-hidden group card-lift">
                <div className="relative aspect-square bg-muted/20">
                  <img src={imgFor(l)} alt={l.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" onError={e => { (e.target as any).src = `https://via.placeholder.com/400?text=${encodeURIComponent(l.name)}`; }} />
                  <div className="absolute top-2 left-2">
                    <Badge variant="outline" className={cn("font-mono text-[8px] uppercase", rCfg.color)}>{rCfg.label}</Badge>
                  </div>
                  <div className="absolute top-2 right-2 flex items-center gap-1">
                    <div className="flex items-center gap-0.5 bg-black/50 backdrop-blur-sm rounded px-1.5 py-0.5">
                      <Eye className="w-2.5 h-2.5 text-white/60" />
                      <span className="font-mono text-[9px] text-white/60">{l.views}</span>
                    </div>
                  </div>
                </div>
                <div className="p-3 space-y-2">
                  <div>
                    <div className="font-mono font-bold text-xs text-foreground truncate">{l.name}</div>
                    {l.collection && <div className="font-mono text-[9px] text-muted-foreground/60">{l.collection}</div>}
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-mono font-bold text-primary text-sm">{Number(l.price).toLocaleString()} AZN</div>
                      <div className="font-mono text-[9px] text-muted-foreground/50">by {l.seller_username}</div>
                    </div>
                    <button onClick={() => handleLike(l.id)} disabled={liking === l.id} className={cn("p-1.5 rounded transition-all", isLiked ? "text-red-400" : "text-muted-foreground/40 hover:text-red-400")}>
                      <Heart className={cn("w-3.5 h-3.5", isLiked && "fill-red-400")} />
                    </button>
                  </div>
                  {!isMine ? (
                    <Button size="sm" onClick={() => handleBuy(l.id)} disabled={buying === l.id} className="w-full font-mono text-[10px] h-7 bg-violet-600 hover:bg-violet-700 text-white border-0 gap-1">
                      <ShoppingCart className="w-3 h-3" />
                      {buying === l.id ? "Buying..." : "Buy Now"}
                    </Button>
                  ) : (
                    <div className="w-full h-7 flex items-center justify-center font-mono text-[9px] text-primary/50 border border-primary/20 rounded">YOUR LISTING</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
