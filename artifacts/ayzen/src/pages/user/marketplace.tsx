import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useSearch, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Store, ShoppingCart, Tag, Plus, X, RefreshCw, Loader2, TrendingUp,
  TrendingDown, BarChart2, DollarSign, Zap, Coins, Gem, Clock, CheckCircle2,
  ChevronDown, Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getMarketplaceTypeMeta, getMarketplaceStatusMeta, MARKETPLACE_TYPE_CONFIG, MARKETPLACE_EXPIRY_OPTIONS } from "@/config/marketplace";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const NftMarketplaceLazy = lazy(() => import("@/pages/user/nft-marketplace"));

type ListingType = "entity" | "local_account" | "nft" | "azn" | "username_nft" | "badge_nft" | "";

interface Listing {
  id: number;
  seller_id: number;
  seller_username: string;
  listing_type: ListingType;
  item_id?: number;
  title: string;
  description?: string;
  price_azn: number;
  metadata?: any;
  image_url?: string | null;
  status: string;
  created_at: string;
}

interface Order {
  id: number;
  listing_id: number;
  title: string;
  listing_type: ListingType;
  buyer_id: number;
  seller_id: number;
  seller_username?: string;
  buyer_username?: string;
  price_azn: number;
  fee_pct: number;
  fee_azn?: number;
  seller_receives?: number;
  status: string;
  message?: string;
  admin_note?: string;
  created_at: string;
  resolved_at?: string;
}

interface VaultItem { id: number; name?: string; username?: string; item_type: string; platform_type?: string; platform_name?: string; notes?: string; }
interface ChartPoint { date: string; close: number; volume: number; azn_per_usd?: number; }

// ── Type config ────────────────────────────────────────────────────────────────

// Listing type + status badge config now live in @/config/marketplace.ts
// as MARKETPLACE_TYPE_CONFIG / MARKETPLACE_STATUS_CONFIG, shared with any
// other page that needs to render a listing type or status. Adding a
// listing type or status is one entry there.

function TypeBadge({ type }: { type: string }) {
  const cfg = getMarketplaceTypeMeta(type);
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={cn("font-mono text-[10px] gap-1", cfg.color)}>
      <Icon className="w-3 h-3" /> {cfg.label}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = getMarketplaceStatusMeta(status);
  const Icon = s.icon;
  return (
    <Badge variant="outline" className={cn("font-mono text-[10px] gap-1", s.cls)}>
      <Icon className="w-3 h-3" /> {s.label}
    </Badge>
  );
}

// ── AZN Chart ─────────────────────────────────────────────────────────────────

function AznChart() {
  const [data, setData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("ayzen_token") ?? "";
    fetch(`${BASE}/api/marketplace/azn/chart`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setData(d.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const change = last && prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const isUp = change >= 0;

  return (
    <div className="bg-card border border-border/40 rounded-xl p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest mb-1">AZN / USD</div>
          <div className="flex items-end gap-2">
            {loading ? (
              <div className="h-8 w-24 bg-muted/40 rounded animate-pulse" />
            ) : (
              <>
                <span className="text-2xl font-mono font-bold text-foreground">${last?.close.toFixed(5) ?? "0.01000"}</span>
                <span className={cn("text-xs font-mono mb-0.5 flex items-center gap-0.5", isUp ? "text-emerald-400" : "text-red-400")}>
                  {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {change.toFixed(2)}%
                </span>
              </>
            )}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/50 mt-1">100 AZN = $1.00 USD · Rate: {last?.azn_per_usd ?? 100} AZN/$</div>
        </div>
      </div>
      <div className="h-40">
        {loading ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.slice(-14)} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="aznGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isUp ? "#22d3ee" : "#f87171"} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={isUp ? "#22d3ee" : "#f87171"} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fontFamily: "monospace", fill: "#555" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 9, fontFamily: "monospace", fill: "#555" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={v => `$${v.toFixed(4)}`} width={56} />
              <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 11, fontFamily: "monospace" }} formatter={(v: any) => [`$${Number(v).toFixed(5)}`, "AZN"]} labelStyle={{ color: "#888" }} />
              <Area type="monotone" dataKey="close" stroke={isUp ? "#22d3ee" : "#f87171"} strokeWidth={2} fill="url(#aznGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs font-mono">
        {[
          { k: "Base Rate",     v: "100 AZN = $1 USD" },
          { k: "Platform Fee",  v: "5% per P2P trade" },
          { k: "Earn Methods",  v: "Tasks, Referrals, Airdrops" },
        ].map(i => (
          <div key={i.k} className="bg-muted/20 border border-border/30 rounded-lg p-2">
            <div className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-0.5">{i.k}</div>
            <div className="text-foreground font-bold text-[10px]">{i.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Create Listing Modal ───────────────────────────────────────────────────────

interface OwnedNft { id: number; token_id: string; plan: string; nft_type: string; badge_name?: string; expires_at?: string; }

// Expiry options now live in @/config/marketplace.ts as
// MARKETPLACE_EXPIRY_OPTIONS. Adding an expiry choice is one entry there.

function CreateListingModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [type, setType] = useState<ListingType>("entity");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [price, setPrice] = useState("");
  const [expiryDays, setExpiryDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const [vaultItems, setVaultItems] = useState<{ entities: VaultItem[]; local_accounts: VaultItem[] }>({ entities: [], local_accounts: [] });
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [ownedNfts, setOwnedNfts] = useState<OwnedNft[]>([]);
  const [selectedNftId, setSelectedNftId] = useState<number | null>(null);
  const [nftPickerOpen, setNftPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch(`${BASE}/api/marketplace/vault-items`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setVaultItems({ entities: d.entities ?? [], local_accounts: d.local_accounts ?? [] }))
      .catch(() => {});
    fetch(`${BASE}/api/nft-subscriptions/my-nfts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setOwnedNfts(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [open, token]);

  const reset = () => {
    setType("entity"); setTitle(""); setDesc(""); setPrice(""); setExpiryDays(7);
    setSelectedItemId(null); setVaultOpen(false); setSelectedNftId(null); setNftPickerOpen(false);
  };

  const availableVaultItems = type === "entity" ? vaultItems.entities : type === "local_account" ? vaultItems.local_accounts : [];

  const handleVaultSelect = (item: VaultItem) => {
    setSelectedItemId(item.id);
    setTitle((item.name ?? item.username ?? "") + (item.platform_type ?? item.platform_name ? ` (${item.platform_type ?? item.platform_name})` : ""));
    setDesc(item.notes ?? "");
    setVaultOpen(false);
  };

  const selectedNft = ownedNfts.find(n => n.id === selectedNftId);

  const submit = async () => {
    if ((type === "entity" || type === "local_account") && !selectedItemId) {
      toast({ title: "Select a vault item to list", variant: "destructive" }); return;
    }
    if (type === "nft" && !selectedNftId) {
      toast({ title: "Select an NFT to list", variant: "destructive" }); return;
    }
    if (!price || Number(price) <= 0) { toast({ title: "Enter a valid price", variant: "destructive" }); return; }
    const listingTitle = title.trim() || selectedNft?.token_id || "Listing";
    const listing_expires_at = expiryDays > 0
      ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    setSaving(true);
    try {
      const body: any = { listing_type: type, title: listingTitle, description: desc, price_azn: Number(price), listing_expires_at };
      if (selectedItemId && (type === "entity" || type === "local_account")) body.item_id = selectedItemId;
      if (selectedNftId && type === "nft") body.item_id = selectedNftId;
      const r = await fetch(`${BASE}/api/marketplace/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      toast({ title: "Listing created!" });
      reset(); onClose(); onCreated();
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setSaving(false);
  };

  const listingTypeGroups = [
    {
      label: "Vault Assets",
      types: [
        { id: "entity" as ListingType,        ...MARKETPLACE_TYPE_CONFIG.entity },
        { id: "local_account" as ListingType,  ...MARKETPLACE_TYPE_CONFIG.local_account },
      ],
    },
    {
      label: "Digital Assets",
      types: [
        { id: "nft" as ListingType,          ...MARKETPLACE_TYPE_CONFIG.nft },
        { id: "azn" as ListingType,           ...MARKETPLACE_TYPE_CONFIG.azn },
      ],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-md bg-card border border-border font-mono max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm text-foreground flex items-center gap-2">
            <Plus className="w-4 h-4 text-primary" /> Create Listing
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          {/* Type selector */}
          <div className="space-y-3">
            {listingTypeGroups.map(group => (
              <div key={group.label}>
                <div className="text-[10px] text-muted-foreground/60 uppercase tracking-widest mb-1.5">{group.label}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.types.map(t => {
                    const Icon = t.icon;
                    return (
                      <button key={t.id} onClick={() => { setType(t.id); setSelectedItemId(null); setSelectedNftId(null); setTitle(""); setDesc(""); }}
                        className={cn("flex items-center gap-2 p-2 rounded-lg border text-xs transition-all text-left",
                          type === t.id ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                        <Icon className="w-3.5 h-3.5 flex-shrink-0" /> <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Vault item picker — required for entity/local_account */}
          {(type === "entity" || type === "local_account") && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-1">
                <Wallet className="w-3 h-3" /> Select from Vault <span className="text-red-400">*</span>
              </div>
              {availableVaultItems.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/50 border border-dashed border-border/30 rounded-lg px-3 py-2.5 text-center">
                  No {type === "entity" ? "entities" : "local accounts"} in vault
                </div>
              ) : (
                <>
                  <button onClick={() => setVaultOpen(v => !v)}
                    className={cn("w-full flex items-center justify-between p-2.5 rounded-lg border text-xs transition-all",
                      selectedItemId ? "border-primary/40 bg-primary/5 text-primary" : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                    <span className="truncate">
                      {selectedItemId
                        ? availableVaultItems.find(v => v.id === selectedItemId)?.name ?? availableVaultItems.find(v => v.id === selectedItemId)?.username ?? "Selected"
                        : `Choose from ${availableVaultItems.length} vault items…`}
                    </span>
                    <ChevronDown className={cn("w-3.5 h-3.5 flex-shrink-0 transition-transform", vaultOpen && "rotate-180")} />
                  </button>
                  {vaultOpen && (
                    <div className="mt-1 border border-border/40 rounded-lg overflow-hidden max-h-44 overflow-y-auto">
                      {availableVaultItems.map(item => (
                        <button key={item.id} onClick={() => handleVaultSelect(item)}
                          className={cn("w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-all border-b border-border/20 last:border-0",
                            selectedItemId === item.id ? "bg-primary/10 text-primary" : "hover:bg-muted/30 text-muted-foreground")}>
                          <span className="font-bold truncate">{item.name ?? item.username}</span>
                          {(item.platform_type ?? item.platform_name) && (
                            <span className="text-muted-foreground/50 text-[10px] flex-shrink-0">{item.platform_type ?? item.platform_name}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* NFT pass picker — required for nft type */}
          {type === "nft" && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-1">
                <Gem className="w-3 h-3" /> Select NFT Pass <span className="text-red-400">*</span>
              </div>
              {ownedNfts.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/50 border border-dashed border-border/30 rounded-lg px-3 py-2.5 text-center">
                  No owned NFT passes found
                </div>
              ) : (
                <>
                  <button onClick={() => setNftPickerOpen(v => !v)}
                    className={cn("w-full flex items-center justify-between p-2.5 rounded-lg border text-xs transition-all",
                      selectedNftId ? "border-primary/40 bg-primary/5 text-primary" : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                    <span className="truncate font-mono">
                      {selectedNft ? `${selectedNft.plan.toUpperCase()} — ${selectedNft.token_id}` : `Choose from ${ownedNfts.length} NFTs…`}
                    </span>
                    <ChevronDown className={cn("w-3.5 h-3.5 flex-shrink-0 transition-transform", nftPickerOpen && "rotate-180")} />
                  </button>
                  {nftPickerOpen && (
                    <div className="mt-1 border border-border/40 rounded-lg overflow-hidden max-h-44 overflow-y-auto">
                      {ownedNfts.map(nft => (
                        <button key={nft.id} onClick={() => { setSelectedNftId(nft.id); setTitle(`${nft.plan.toUpperCase()} NFT Pass — ${nft.token_id}`); setNftPickerOpen(false); }}
                          className={cn("w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-all border-b border-border/20 last:border-0",
                            selectedNftId === nft.id ? "bg-primary/10 text-primary" : "hover:bg-muted/30 text-muted-foreground")}>
                          <Gem className="w-3 h-3 flex-shrink-0" />
                          <span className="font-bold">{nft.plan.toUpperCase()}</span>
                          <span className="text-[10px] text-muted-foreground/50 truncate">{nft.token_id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Title */}
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Title *</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Twitter Account — 5k followers" className="font-mono text-xs h-8" />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Description</label>
            <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional details about this listing…" className="font-mono text-xs h-8" />
          </div>

          {/* Price */}
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Price (AZN) *</label>
            <div className="relative">
              <Input value={price} onChange={e => setPrice(e.target.value)} type="number" min="1" placeholder="e.g. 500" className="font-mono text-xs h-8 pr-16" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50 font-mono">
                ≈ ${price ? (Number(price) / 100).toFixed(2) : "0.00"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground/50 mt-1">100 AZN = $1 USD. 5% platform fee deducted from seller on approval.</p>
          </div>

          {/* Listing Expiry Timer */}
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1.5 flex items-center gap-1">
              <Clock className="w-3 h-3" /> Listing Expires
            </div>
            <div className="flex flex-wrap gap-1.5">
              {MARKETPLACE_EXPIRY_OPTIONS.map(opt => (
                <button key={opt.days} onClick={() => setExpiryDays(opt.days)}
                  className={cn(
                    "px-3 py-1 rounded-full text-[10px] font-mono border transition-all",
                    expiryDays === opt.days
                      ? "bg-primary/10 border-primary/40 text-primary"
                      : "border-border/40 text-muted-foreground hover:border-primary/20"
                  )}>
                  {opt.label}
                </button>
              ))}
            </div>
            {expiryDays > 0 && (
              <p className="text-[10px] text-muted-foreground/40 mt-1">
                Expires {new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { reset(); onClose(); }} className="text-xs">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving} className="text-xs gap-1">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Create Listing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Buy Modal ─────────────────────────────────────────────────────────────────

function BuyModal({ listing, onClose, onDone }: { listing: Listing; onClose: () => void; onDone: () => void }) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [msg, setMsg] = useState("");
  const [buying, setBuying] = useState(false);

  const buy = async () => {
    setBuying(true);
    try {
      const r = await fetch(`${BASE}/api/marketplace/listings/${listing.id}/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: msg }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "Order placed! Admin approval required.", description: `${listing.price_azn} AZN reserved.` });
      onClose(); onDone();
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setBuying(false);
  };

  const cfg = MARKETPLACE_TYPE_CONFIG[listing.listing_type] ?? MARKETPLACE_TYPE_CONFIG.entity;
  const Icon = cfg.icon;

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm bg-card border border-border font-mono">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-primary" /> Place Order
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {listing.image_url && (
            <div className="w-full aspect-video rounded-lg overflow-hidden">
              <img src={listing.image_url} alt={listing.title} className="w-full h-full object-cover" />
            </div>
          )}
          <div className="bg-muted/30 rounded-lg p-3 border border-border/40">
            <div className="flex items-center gap-2 mb-2">
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", cfg.bg)}>
                <Icon className={cn("w-4 h-4", cfg.color)} />
              </div>
              <div>
                <div className="text-sm font-bold text-foreground">{listing.title}</div>
                <div className="text-[10px] text-muted-foreground">{listing.seller_username}</div>
              </div>
            </div>
            {listing.description && <p className="text-xs text-muted-foreground">{listing.description}</p>}
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="font-bold text-foreground">{listing.price_azn.toLocaleString()} AZN</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Fee (5%)</span><span className="text-muted-foreground">Paid by seller</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">USD value</span><span className="text-muted-foreground">${(listing.price_azn / 100).toFixed(2)}</span></div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Message to seller (optional)</label>
            <Input value={msg} onChange={e => setMsg(e.target.value)} placeholder="Any specific request…" className="font-mono text-xs h-8" />
          </div>
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-400 flex items-start gap-2">
            <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>AZN reserved until admin approves or rejects this order.</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button size="sm" onClick={buy} disabled={buying} className="text-xs gap-1">
            {buying ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShoppingCart className="w-3 h-3" />}
            Reserve {listing.price_azn} AZN
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Listing Card ───────────────────────────────────────────────────────────────

function ListingCard({ listing, onBuy, isOwn }: { listing: Listing; onBuy: () => void; isOwn: boolean }) {
  const cfg = MARKETPLACE_TYPE_CONFIG[listing.listing_type] ?? MARKETPLACE_TYPE_CONFIG.entity;
  const Icon = cfg.icon;
  return (
    <div className="bg-card/60 border border-border/40 rounded-xl overflow-hidden hover:border-primary/20 transition-all flex flex-col">
      {/* Image or icon header */}
      {listing.image_url ? (
        <div className="aspect-video overflow-hidden">
          <img src={listing.image_url} alt={listing.title} className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className={cn("h-16 flex items-center justify-center", cfg.bg)}>
          <Icon className={cn("w-7 h-7 opacity-40", cfg.color)} />
        </div>
      )}
      <div className="p-3 flex flex-col gap-2.5 flex-1">
        <div className="flex items-start justify-between gap-1">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm font-bold text-foreground truncate">{listing.title}</div>
            <div className="text-[10px] font-mono text-muted-foreground/60">by {listing.seller_username}</div>
          </div>
          <TypeBadge type={listing.listing_type} />
        </div>
        {listing.description && <p className="text-xs text-muted-foreground font-mono line-clamp-2">{listing.description}</p>}
        {listing.metadata && Object.keys(listing.metadata).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {Object.entries(listing.metadata).slice(0, 2).map(([k, v]) => (
              <span key={k} className="text-[9px] font-mono bg-muted/40 border border-border/30 rounded px-1.5 py-0.5 text-muted-foreground">
                {k}: {String(v)}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/20 mt-auto">
          <div>
            <div className="font-mono text-base font-bold text-primary">{listing.price_azn.toLocaleString()} AZN</div>
            <div className="text-[10px] text-muted-foreground/50 font-mono">${(listing.price_azn / 100).toFixed(2)} USD</div>
          </div>
          {isOwn ? (
            <Badge variant="outline" className="text-[10px] font-mono text-primary border-primary/30">Your listing</Badge>
          ) : (
            <Button size="sm" onClick={onBuy} className="text-xs gap-1 h-8">
              <ShoppingCart className="w-3 h-3" /> Buy
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Orders Panel ──────────────────────────────────────────────────────────────

function OrdersPanel({ token }: { token: string }) {
  const [tab, setTab] = useState<"purchases" | "sales">("purchases");
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = tab === "purchases" ? "my" : "sales";
      const r = await fetch(`${BASE}/api/marketplace/orders/${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setOrders(await r.json());
    } catch { } finally { setLoading(false); }
  }, [token, tab]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="bg-card border border-border/40 rounded-xl overflow-hidden">
      <div className="flex border-b border-border/40">
        {(["purchases", "sales"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={cn("flex-1 py-3 text-xs font-mono font-bold transition-colors capitalize",
              tab === t ? "text-primary bg-primary/5 border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}>
            {t === "purchases" ? "My Purchases" : "My Sales"}
          </button>
        ))}
      </div>
      <div className="p-3">
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-primary/30" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-8">
            <ShoppingCart className="w-6 h-6 text-muted-foreground/20 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground/40 font-mono">No {tab} yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map(o => (
              <div key={o.id} className="flex items-center gap-3 p-3 bg-muted/20 rounded-lg border border-border/30">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono font-bold text-foreground truncate">{o.title}</span>
                    <TypeBadge type={o.listing_type} />
                    <StatusBadge status={o.status} />
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/60 mt-1">
                    {tab === "purchases" ? `Seller: ${o.seller_username}` : `Buyer: ${o.buyer_username}`}
                    {o.admin_note && <span className="ml-2 text-red-400">· {o.admin_note}</span>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-mono font-bold text-primary">{o.price_azn} AZN</div>
                  <div className="text-[9px] text-muted-foreground/50 font-mono">${(o.price_azn / 100).toFixed(2)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── My Listings Panel ─────────────────────────────────────────────────────────

function MyListingsPanel({ token, onCreateNew, onRefresh }: { token: string; onCreateNew: () => void; onRefresh: () => void }) {
  const { toast } = useToast();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/marketplace/my-listings`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setListings(await r.json());
    } catch { } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const cancel = async (id: number) => {
    try {
      const r = await fetch(`${BASE}/api/marketplace/listings/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error("Failed");
      toast({ title: "Listing cancelled" });
      load(); onRefresh();
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>;

  if (listings.length === 0) return (
    <div className="text-center py-16">
      <Tag className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
      <p className="font-mono text-sm text-muted-foreground/40">No listings yet</p>
      <Button size="sm" variant="outline" onClick={onCreateNew} className="mt-4 text-xs gap-1">
        <Plus className="w-3.5 h-3.5" /> Create your first listing
      </Button>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-3">
        <span className="text-xs font-mono text-muted-foreground">{listings.length} listing{listings.length !== 1 ? "s" : ""}</span>
        <Button size="sm" variant="outline" onClick={onCreateNew} className="h-7 text-xs gap-1">
          <Plus className="w-3 h-3" /> New Listing
        </Button>
      </div>
      {listings.map(l => (
        <div key={l.id} className="flex items-center gap-3 bg-card/60 border border-border/40 rounded-xl p-3.5 hover:border-primary/20 transition-all">
          {l.image_url ? (
            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0">
              <img src={l.image_url} alt={l.title} className="w-full h-full object-cover" />
            </div>
          ) : (
            (() => {
              const cfg = MARKETPLACE_TYPE_CONFIG[l.listing_type] ?? MARKETPLACE_TYPE_CONFIG.entity;
              const Icon = cfg.icon;
              return <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0", cfg.bg)}><Icon className={cn("w-4 h-4", cfg.color)} /></div>;
            })()
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className="font-mono text-sm font-bold text-foreground truncate">{l.title}</span>
              <TypeBadge type={l.listing_type} />
              <StatusBadge status={l.status} />
            </div>
            {l.description && <p className="text-[10px] text-muted-foreground font-mono truncate">{l.description}</p>}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="font-mono text-base font-bold text-primary">{l.price_azn} AZN</div>
            <div className="text-[10px] text-muted-foreground/50 font-mono">${(l.price_azn / 100).toFixed(2)}</div>
          </div>
          {l.status === "active" && (
            <Button variant="ghost" size="icon" onClick={() => cancel(l.id)} className="w-7 h-7 text-muted-foreground hover:text-red-400 flex-shrink-0">
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main Marketplace Page ─────────────────────────────────────────────────────

export default function Marketplace() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const search = useSearch();
  const [, navigate] = useLocation();
  const urlTab = new URLSearchParams(search).get("tab");
  const VALID_TABS = ["browse", "nft", "chart", "orders", "sell"] as const;
  type MarketTab = typeof VALID_TABS[number];
  const [tab, setTabState] = useState<MarketTab>(
    (VALID_TABS.includes(urlTab as any) ? urlTab : "browse") as MarketTab
  );
  const setTab = (t: MarketTab) => {
    setTabState(t);
    navigate(t === "browse" ? "/marketplace" : `/marketplace?tab=${t}`, { replace: true });
  };
  useEffect(() => {
    if (urlTab && VALID_TABS.includes(urlTab as any) && urlTab !== tab) setTabState(urlTab as MarketTab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const [listings, setListings] = useState<Listing[]>([]);
  const [filterType, setFilterType] = useState<ListingType>("");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [buyTarget, setBuyTarget] = useState<Listing | null>(null);

  const loadListings = useCallback(async () => {
    setLoading(true);
    try {
      const q = filterType ? `?type=${filterType}` : "";
      const r = await fetch(`${BASE}/api/marketplace/listings${q}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); setListings(d.listings ?? []); }
    } catch { } finally { setLoading(false); }
  }, [token, filterType]);

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/marketplace/stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setStats(await r.json());
    } catch { }
  }, [token]);

  useEffect(() => { loadListings(); loadStats(); }, [loadListings, loadStats]);

  const TABS = [
    { id: "browse", label: "Browse",      icon: Store },
    { id: "nft",    label: "NFT Market",  icon: Gem },
    { id: "chart",  label: "AZN Chart",   icon: BarChart2 },
    { id: "orders", label: "Orders",      icon: ShoppingCart },
    { id: "sell",   label: "My Listings", icon: Tag },
  ] as const;

  const FILTER_TYPES = [
    { val: "" as ListingType, label: "All Types", icon: Store },
    ...Object.entries(MARKETPLACE_TYPE_CONFIG).map(([k, v]) => ({ val: k as ListingType, label: v.label, icon: v.icon })),
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-24">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-mono font-bold text-xl text-foreground flex items-center gap-2">
            <Store className="w-5 h-5 text-primary" /> P2P Marketplace
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">Trade entities, accounts, NFT passes &amp; AZN tokens</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1 text-xs self-start sm:self-auto">
          <Plus className="w-3.5 h-3.5" /> Create Listing
        </Button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Active Listings",  val: stats.active_listings,  icon: Tag,          color: "text-cyan-400" },
            { label: "Completed Trades", val: stats.completed_trades, icon: CheckCircle2, color: "text-emerald-400" },
            { label: "Total Volume",     val: `${Number(stats.total_volume_azn ?? 0).toFixed(0)} AZN`, icon: Coins, color: "text-amber-400" },
            { label: "Platform Fees",    val: `${Number(stats.total_fees_azn ?? 0).toFixed(0)} AZN`,   icon: DollarSign, color: "text-violet-400" },
          ].map((s, i) => (
            <div key={s.label} className="bg-card/60 border border-border/40 rounded-xl p-3 flex items-center gap-3 animate-pop-in" style={{ animationDelay: `${i * 50}ms` }}>
              <s.icon className={cn("w-4 h-4 flex-shrink-0", s.color)} />
              <div>
                <div className={cn("text-sm font-mono font-bold", s.color)}>{s.val}</div>
                <div className="text-[9px] text-muted-foreground/50 font-mono">{s.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/30 rounded-lg p-1 overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-mono font-bold transition-all whitespace-nowrap flex-shrink-0",
                tab === t.id ? "bg-card text-primary shadow-sm border border-primary/20" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          );
        })}
      </div>

      {/* ── Browse ── */}
      {tab === "browse" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {FILTER_TYPES.map(f => {
              const Icon = f.icon;
              return (
                <button key={String(f.val)} onClick={() => setFilterType(f.val)}
                  className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-bold transition-all",
                    filterType === f.val ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                  <Icon className="w-3 h-3" /> {f.label}
                </button>
              );
            })}
          </div>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => <div key={i} className="h-48 bg-card/60 border border-border/40 rounded-xl animate-pulse" />)}
            </div>
          ) : listings.length === 0 ? (
            <div className="text-center py-16">
              <Store className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="font-mono text-sm text-muted-foreground/40">No listings yet</p>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(true)} className="mt-4 text-xs gap-1">
                <Plus className="w-3.5 h-3.5" /> Be the first to sell
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {listings.map(l => (
                <ListingCard key={l.id} listing={l} isOwn={l.seller_id === user?.id} onBuy={() => setBuyTarget(l)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── NFT Market ── */}
      {tab === "nft" && (
        <Suspense fallback={<div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>}>
          <NftMarketplaceLazy />
        </Suspense>
      )}

      {/* ── AZN Chart ── */}
      {tab === "chart" && <AznChart />}

      {/* ── Orders ── */}
      {tab === "orders" && <OrdersPanel token={token ?? ""} />}

      {/* ── My Listings ── */}
      {tab === "sell" && <MyListingsPanel token={token ?? ""} onCreateNew={() => setShowCreate(true)} onRefresh={loadListings} />}

      {/* Modals */}
      <CreateListingModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { loadListings(); loadStats(); }} />
      {buyTarget && <BuyModal listing={buyTarget} onClose={() => setBuyTarget(null)} onDone={() => { loadListings(); loadStats(); }} />}
    </div>
  );
}
