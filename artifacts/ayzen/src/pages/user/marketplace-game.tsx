import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Gamepad2, Plus, X, ShoppingCart, Tag, Star, RefreshCw,
  ChevronLeft, ChevronRight, ImagePlus, Trash2, ListPlus, Eye,
  Monitor, Smartphone as MobileIcon, Joystick,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const tok = () => localStorage.getItem("ayzen_token") ?? "";
const api = (p: string, o?: RequestInit) =>
  fetch(`${BASE}/api${p}`, { ...o, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok()}`, ...(o?.headers ?? {}) } });

// Platforms are game-market-specific (not shared with vault/entity platforms in
// @/config/marketplace.ts) so they live here rather than in the shared config.
const GAME_PLATFORMS = [
  { id: "pc",         label: "PC",         icon: Monitor },
  { id: "console",    label: "Console",    icon: Joystick },
  { id: "mobile",     label: "Mobile",     icon: MobileIcon },
  { id: "other",      label: "Other",      icon: Gamepad2 },
];

const MAX_PHOTOS = 6;

// Downscale + re-encode an uploaded image client-side so the `photos` TEXT
// column (JSON array of data URLs) doesn't balloon with full-resolution shots.
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const maxDim = 900;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("no canvas ctx")); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// ── Photo slider (used both in the create form preview and on listing cards) ──
function PhotoSlider({ photos, className }: { photos: string[]; className?: string }) {
  const [idx, setIdx] = useState(0);
  if (!photos || photos.length === 0) {
    return (
      <div className={cn("flex items-center justify-center bg-muted/20", className)}>
        <Gamepad2 className="w-8 h-8 text-muted-foreground/20" />
      </div>
    );
  }
  const go = (d: number) => setIdx(i => (i + d + photos.length) % photos.length);
  return (
    <div className={cn("relative overflow-hidden group/slider", className)}>
      <img src={photos[idx]} alt="" className="w-full h-full object-cover" />
      {photos.length > 1 && (
        <>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); go(-1); }}
            className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center opacity-0 group-hover/slider:opacity-100 transition-opacity">
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); go(1); }}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center opacity-0 group-hover/slider:opacity-100 transition-opacity">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-1">
            {photos.map((_, i) => (
              <div key={i} className={cn("w-1.5 h-1.5 rounded-full transition-all", i === idx ? "bg-white" : "bg-white/40")} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Create Sell Order Modal ────────────────────────────────────────────────
function SellOrderModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [gameName, setGameName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [platform, setPlatform] = useState("pc");
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [details, setDetails] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [creating, setCreating] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) { toast({ title: `Max ${MAX_PHOTOS} photos` }); return; }
    setUploading(true);
    try {
      const picked = Array.from(files).slice(0, room);
      const encoded = await Promise.all(picked.map(compressImage));
      setPhotos(p => [...p, ...encoded]);
    } catch { toast({ variant: "destructive", title: "Couldn't read one of those images" }); }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePhoto = (i: number) => {
    setPhotos(p => p.filter((_, idx) => idx !== i));
    setPreviewIdx(i2 => Math.max(0, Math.min(i2, photos.length - 2)));
  };

  const updateDetail = (i: number, field: "key" | "value", value: string) =>
    setDetails(d => d.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  const addDetailRow = () => setDetails(d => [...d, { key: "", value: "" }]);
  const removeDetailRow = (i: number) => setDetails(d => d.filter((_, idx) => idx !== i));

  const handleCreate = async () => {
    if (!gameName.trim()) { toast({ title: "Game name required" }); return; }
    if (!title.trim()) { toast({ title: "Title required" }); return; }
    if (!price || Number(price) <= 0) { toast({ title: "Enter a valid price" }); return; }
    setCreating(true);
    try {
      const detailsObj: Record<string, string> = {};
      details.forEach(({ key, value }) => { if (key.trim()) detailsObj[key.trim()] = value; });
      const payload = {
        game_name: gameName.trim(),
        title: title.trim(),
        description: description.trim() || null,
        price: Number(price),
        platform,
        photos,
        details: detailsObj,
      };
      const r = await api("/marketplace/game/listings", { method: "POST", body: JSON.stringify(payload) });
      const d = await r.json();
      if (r.ok) { toast({ title: "Listing created!" }); onSuccess(); onClose(); }
      else toast({ variant: "destructive", title: d.error });
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-indigo-500/20 rounded-xl w-full max-w-md mx-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40 sticky top-0 bg-card z-10">
          <div>
            <span className="font-mono font-bold text-sm">Create Sell Order</span>
            <div className="text-[10px] font-mono text-muted-foreground">Game account listing</div>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Photo upload + slider preview */}
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Photos ({photos.length}/{MAX_PHOTOS})</label>
            <PhotoSlider photos={photos} className="w-full h-40 rounded-lg border border-border/30 mb-2" />
            {photos.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-1 mb-2">
                {photos.map((p, i) => (
                  <div key={i} className="relative flex-shrink-0">
                    <img src={p} className="w-12 h-12 object-cover rounded border border-border/30" onClick={() => setPreviewIdx(i)} />
                    <button onClick={() => removePhoto(i)} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center">
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => handleFiles(e.target.files)} />
            <Button type="button" variant="outline" size="sm" disabled={uploading || photos.length >= MAX_PHOTOS}
              onClick={() => fileInputRef.current?.click()} className="w-full font-mono text-xs gap-1.5">
              <ImagePlus className="w-3.5 h-3.5" /> {uploading ? "Uploading..." : "Add Photos"}
            </Button>
          </div>

          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Game Name</label>
            <Input value={gameName} onChange={e => setGameName(e.target.value)} placeholder="e.g. Valorant, PUBG Mobile..." className="font-mono text-sm" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Listing Title</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Immortal rank, 40+ skins" className="font-mono text-sm" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Platform</label>
            <div className="flex gap-1.5 flex-wrap">
              {GAME_PLATFORMS.map(p => {
                const Icon = p.icon;
                return (
                  <button key={p.id} onClick={() => setPlatform(p.id)}
                    className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono text-xs transition-all",
                      platform === p.id ? "bg-indigo-500/15 border-indigo-400/30 text-indigo-400" : "border-border/30 text-muted-foreground hover:border-border")}>
                    <Icon className="w-3.5 h-3.5" /> {p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Description</label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Rank, level, region, notable items..." className="font-mono text-sm min-h-16" />
          </div>

          {/* Dynamic additional details */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">Additional Details</label>
              <button onClick={addDetailRow} className="flex items-center gap-1 text-[10px] font-mono text-indigo-400">
                <ListPlus className="w-3 h-3" /> Add field
              </button>
            </div>
            <div className="space-y-2">
              {details.map((row, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input value={row.key} onChange={e => updateDetail(i, "key", e.target.value)} placeholder="Field (e.g. Level)" className="font-mono text-xs h-8 flex-1" />
                  <Input value={row.value} onChange={e => updateDetail(i, "value", e.target.value)} placeholder="Value (e.g. 120)" className="font-mono text-xs h-8 flex-1" />
                  {details.length > 1 && (
                    <button onClick={() => removeDetailRow(i)} className="text-muted-foreground/50 hover:text-red-400 px-1">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Price (AZN)</label>
            <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. 1500" className="font-mono text-sm" />
            {price && <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">Platform fee: 5% · You receive: {(Number(price) * 0.95).toFixed(0)} AZN</p>}
          </div>

          <Button onClick={handleCreate} disabled={creating} className="w-full font-mono text-xs bg-indigo-600 hover:bg-indigo-700 text-white border-0">
            {creating ? "Creating..." : "List for Sale"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function MarketplaceGame() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [listings, setListings] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [platformFilter, setPlatformFilter] = useState("all");
  const [buying, setBuying] = useState<number | null>(null);
  const [showSellOrder, setShowSellOrder] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (platformFilter !== "all") params.set("platform", platformFilter);
      const [l, s, w] = await Promise.all([
        api(`/marketplace/game/listings?${params}`).then(r => r.json()),
        api("/marketplace/game/stats").then(r => r.json()),
        api("/marketplace/wallet").then(r => r.json()),
      ]);
      setListings(l.listings ?? []);
      setStats(s);
      setWallet(w?.game ?? null);
    } catch {}
    setLoading(false);
  }, [platformFilter]);

  useEffect(() => { load(); }, [load]);

  const handleBuy = async (id: number) => {
    setBuying(id);
    try {
      const r = await api("/marketplace/game/buy", { method: "POST", body: JSON.stringify({ listing_id: id }) });
      const d = await r.json();
      if (!r.ok) toast({ variant: "destructive", title: d.error });
      else { toast({ title: "Purchased!", description: `Cost: ${d.price} AZN` }); load(); }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setBuying(null);
  };

  const handleCancel = async (id: number) => {
    await api(`/marketplace/game/listings/${id}`, { method: "DELETE" });
    toast({ title: "Listing removed" }); load();
  };

  return (
    <div className="space-y-5 page-enter">
      {showSellOrder && <SellOrderModal onClose={() => setShowSellOrder(false)} onSuccess={load} />}

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <Gamepad2 className="w-4 h-4 text-indigo-400" />
            </div>
            <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Game Market</h1>
          </div>
          <p className="text-muted-foreground font-mono text-sm">Buy & sell game accounts · Escrow protected</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-mono text-xs h-8">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => setShowSellOrder(true)} className="font-mono text-xs h-8 gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white border-0">
            <Plus className="w-3.5 h-3.5" /> Sell Order
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "For Sale",     value: stats?.active_listings ?? "—",                     icon: Gamepad2,     color: "text-indigo-400" },
          { label: "Avg Price",    value: `${stats?.avg_price?.toFixed(0) ?? "—"} AZN`,       icon: Tag,          color: "text-primary" },
          { label: "Floor Price",  value: `${stats?.floor_price?.toFixed(0) ?? "—"} AZN`,     icon: Star,         color: "text-amber-400" },
          { label: "Game Wallet",  value: `${wallet?.balance?.toFixed(0) ?? "0"} AZN`,        icon: ShoppingCart, color: "text-emerald-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3 flex items-center gap-3">
            <div className={cn("w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center flex-shrink-0", s.color)}>
              <s.icon className="w-4 h-4" />
            </div>
            <div>
              <div className={cn("font-mono font-bold text-base", s.color)}>{loading ? <Skeleton className="h-5 w-12" /> : s.value}</div>
              <div className="font-mono text-[9px] text-muted-foreground">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Platform filters */}
      <div className="flex gap-1.5 flex-wrap">
        <button onClick={() => setPlatformFilter("all")}
          className={cn("px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-all",
            platformFilter === "all" ? "bg-indigo-500/15 text-indigo-400 border-indigo-400/30" : "text-muted-foreground border-border/30 hover:border-border")}>
          All
        </button>
        {GAME_PLATFORMS.map(p => {
          const Icon = p.icon;
          return (
            <button key={p.id} onClick={() => setPlatformFilter(p.id)}
              className={cn("flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-all",
                platformFilter === p.id ? "bg-indigo-500/15 text-indigo-400 border-indigo-400/30" : "text-muted-foreground border-border/30 hover:border-border")}>
              <Icon className="w-3 h-3" /> {p.label}
            </button>
          );
        })}
      </div>

      {/* Listings */}
      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-56 rounded-xl" />)}</div>
      ) : listings.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground/40 font-mono text-sm bg-card border border-border/30 rounded-xl">
          <Gamepad2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p>No listings found</p>
          <Button size="sm" className="mt-4 font-mono text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white border-0" onClick={() => setShowSellOrder(true)}>
            <Plus className="w-3.5 h-3.5" /> Create Sell Order
          </Button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {listings.map(l => {
            const isMine = l.seller_id === user?.id;
            const photos: string[] = Array.isArray(l.photos) ? l.photos : [];
            const details: Record<string, any> = l.details ?? {};
            const platformDef = GAME_PLATFORMS.find(p => p.id === l.platform);
            return (
              <div key={l.id} className={cn(
                "bg-card border rounded-xl overflow-hidden transition-all",
                isMine ? "border-indigo-400/20" : "border-card-border hover:border-indigo-400/30"
              )}>
                <PhotoSlider photos={photos} className="w-full h-40" />
                <div className="bg-gradient-to-r from-indigo-500/5 to-transparent border-b border-border/30 px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[8px] uppercase text-indigo-400 border-indigo-400/30">{l.game_name}</Badge>
                    {platformDef && (
                      <Badge variant="outline" className="font-mono text-[8px] uppercase text-muted-foreground border-border/40 flex items-center gap-1">
                        <platformDef.icon className="w-2.5 h-2.5" /> {platformDef.label}
                      </Badge>
                    )}
                    {isMine && <Badge variant="outline" className="font-mono text-[8px] border-indigo-400/30 text-indigo-400">MINE</Badge>}
                  </div>
                  <div className="font-mono font-bold text-sm text-primary">{Number(l.price).toLocaleString()} AZN</div>
                </div>
                <div className="p-4 space-y-2">
                  <h3 className="font-mono font-bold text-sm">{l.title}</h3>
                  {Object.keys(details).length > 0 && (
                    <div className="grid grid-cols-2 gap-1.5">
                      {Object.entries(details).map(([k, v]) => (
                        <div key={k} className="bg-muted/20 rounded px-2 py-1 font-mono text-[9px]">
                          <div className="text-muted-foreground/60 uppercase tracking-wider mb-0.5">{k}</div>
                          <div className="text-foreground font-bold">{String(v)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {l.description && <p className="font-mono text-[11px] text-muted-foreground/60 line-clamp-2">{l.description}</p>}
                  <div className="flex items-center justify-between pt-1">
                    <div className="text-[9px] font-mono text-muted-foreground/40 flex items-center gap-1.5">
                      <span>Listed by {l.seller_username} · {new Date(l.created_at).toLocaleDateString()}</span>
                      {typeof l.views === "number" && <span className="flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" /> {l.views}</span>}
                    </div>
                    {isMine ? (
                      <Button size="sm" variant="outline" onClick={() => handleCancel(l.id)}
                        className="font-mono text-[9px] h-6 border-red-500/20 text-red-400 hover:bg-red-500/10">
                        <X className="w-2.5 h-2.5 mr-1" /> Remove
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => handleBuy(l.id)} disabled={buying === l.id}
                        className="font-mono text-[9px] h-7 bg-indigo-600 hover:bg-indigo-700 text-white border-0 gap-1">
                        <ShoppingCart className="w-3 h-3" />
                        {buying === l.id ? "Buying..." : "Buy Securely"}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
