import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Gem, ShoppingCart, Tag, RefreshCw, Loader2, Plus, X, Check,
  Wallet, Package, Trash2,
  TrendingUp, Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { NFT_PAYMENT_METHODS, getNftCategoryIcon as getCatIcon } from "@/config/marketplace-nft";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const tok = () => localStorage.getItem("ayzen_token") ?? "";
const api = (p: string, o?: RequestInit) =>
  fetch(`${BASE}/api${p}`, { ...o, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok()}`, ...(o?.headers ?? {}) } });

// Payment methods and category-icon lookup now live in
// @/config/marketplace-nft.ts as NFT_PAYMENT_METHODS / getNftCategoryIcon
// (reusing the same binance/bkash/nagad set as the AZN market page).
// Adding a checkout payment method is one entry there.
const PAYMENT_METHODS = NFT_PAYMENT_METHODS;

// ── Payment pill ─────────────────────────────────────────────────────────────
function PaymentPill({ method, selected, onClick }: { method: typeof PAYMENT_METHODS[0]; selected: boolean; onClick: () => void }) {
  const Icon = method.icon;
  return (
    <button onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs transition-all",
        selected ? `${method.bg} ${method.border} ${method.color}` : "border-border/40 text-muted-foreground hover:border-border"
      )}>
      <Icon className="w-3.5 h-3.5" />{method.label}
      {(method.fee ?? 0) > 0 && !selected && <span className="text-[9px] opacity-50">+{method.fee ?? 0}%</span>}
      {selected && <Check className="w-3 h-3" />}
    </button>
  );
}

// ── Sell Modal — select from inventory, set price + payment ──────────────────
function SellModal({ myNfts, onClose, onSuccess }: { myNfts: any[]; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState<"select" | "price">("select");
  const [selectedNft, setSelectedNft] = useState<any>(null);
  const [price, setPrice] = useState("");
  const [payMethod, setPayMethod] = useState("azn");
  const [payDetails, setPayDetails] = useState("");
  const [listing, setListing] = useState(false);

  const pm = PAYMENT_METHODS.find(p => p.id === payMethod)!;
  const finalPrice = price ? (Number(price) * (1 + (pm.fee ?? 0) / 100)).toFixed(2) : "";

  const handleList = async () => {
    if (!price || Number(price) <= 0) { toast({ variant: "destructive", title: "Enter a valid price" }); return; }
    if (payMethod !== "azn" && !payDetails.trim()) { toast({ variant: "destructive", title: "Enter payment details" }); return; }
    setListing(true);
    try {
      const r = await api(`/nft-subscriptions/${selectedNft.id}/list`, {
        method: "POST",
        body: JSON.stringify({ price: Number(finalPrice), market_payment_method: payMethod, market_payment_details: payDetails }),
      });
      const d = await r.json();
      if (r.ok) { toast({ title: `Listed for ${finalPrice} AZN!` }); onSuccess(); onClose(); }
      else toast({ variant: "destructive", title: d.error ?? "Failed to list" });
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setListing(false);
  };

  const availableNfts = myNfts.filter(n => !n.is_listed && !n.is_burned);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-primary/20 rounded-xl w-full max-w-md mx-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40 sticky top-0 bg-card">
          <div>
            <span className="font-mono font-bold text-sm">Sell NFT</span>
            <div className="text-[10px] font-mono text-muted-foreground">{step === "select" ? "Select from inventory" : "Set price & payment"}</div>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>

        <div className="p-5 space-y-4">
          {step === "select" ? (
            <>
              {availableNfts.length === 0 ? (
                <div className="text-center py-8">
                  <Lock className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
                  <p className="font-mono text-sm text-muted-foreground">No NFTs available to list</p>
                  <p className="font-mono text-[10px] text-muted-foreground/50 mt-1">Already listed NFTs cannot be re-listed</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {availableNfts.map(nft => (
                    <button
                      key={nft.id}
                      onClick={() => { setSelectedNft(nft); setStep("price"); }}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                        selectedNft?.id === nft.id ? "border-primary/40 bg-primary/5" : "border-border/30 hover:border-primary/20"
                      )}
                    >
                      <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                        <Gem className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm font-bold truncate">{nft.plan?.replace(/_/g, " ")}</div>
                        <div className="font-mono text-[10px] text-muted-foreground truncate">{nft.token_id}</div>
                      </div>
                      <Badge variant="outline" className="font-mono text-[9px] text-primary border-primary/30 flex-shrink-0">{nft.nft_category ?? nft.plan}</Badge>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Selected NFT preview */}
              <div className="bg-muted/20 rounded-lg p-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                  <Gem className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="font-mono text-sm font-bold">{selectedNft.plan?.replace(/_/g, " ")}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{selectedNft.token_id}</div>
                </div>
                <button onClick={() => setStep("select")} className="text-[10px] font-mono text-primary/60 hover:text-primary">Change</button>
              </div>

              {/* Price */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground block mb-1">Base Price (AZN) *</label>
                <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. 50" className="font-mono text-sm h-10" />
              </div>

              {/* Payment Method */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground block mb-2">Payment Method</label>
                <div className="flex gap-2 flex-wrap">
                  {PAYMENT_METHODS.map(m => <PaymentPill key={m.id} method={m} selected={payMethod === m.id} onClick={() => setPayMethod(m.id)} />)}
                </div>
                {(pm.fee ?? 0) > 0 && <p className="text-[10px] font-mono text-amber-400/80 mt-1.5">+{pm.fee ?? 0}% fee applied for non-AZN payments</p>}
              </div>

              {/* Payment Details for non-AZN */}
              {payMethod !== "azn" && (
                <div>
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground block mb-1">
                    {payMethod === "binance" ? "Binance UID / Pay ID" : payMethod === "bkash" ? "bKash Number" : "Nagad Number"} *
                  </label>
                  <Input value={payDetails} onChange={e => setPayDetails(e.target.value)}
                    placeholder={payMethod === "binance" ? "e.g. 123456789" : "e.g. 01XXXXXXXXX"}
                    className="font-mono text-sm h-10" />
                </div>
              )}

              {/* Price summary */}
              {price && (
                <div className="bg-muted/20 rounded-lg p-3 font-mono text-[11px] space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Base price</span><span>{price} AZN</span></div>
                  {(pm.fee ?? 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Fee ({pm.fee ?? 0}%)</span><span className="text-amber-400">+{(Number(price) * (pm.fee ?? 0) / 100).toFixed(2)} AZN</span></div>}
                  <div className="flex justify-between font-bold border-t border-border/30 pt-1"><span className="text-foreground">Listing price</span><span className="text-primary">{finalPrice} AZN</span></div>
                </div>
              )}

              <Button onClick={handleList} disabled={listing || !price} className="w-full font-mono text-xs gap-2">
                {listing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
                List for Sale
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Buy Modal — select NFT from library then set payment ──────────────────────
function BuyModal({
  nft, onClose, onSuccess,
}: { nft: any; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [payMethod, setPayMethod] = useState("azn");
  const [buying, setBuying] = useState(false);

  const pm = PAYMENT_METHODS.find(p => p.id === payMethod)!;

  const handleBuy = async () => {
    setBuying(true);
    try {
      const r = await api(`/nft-subscriptions/${nft.id}/buy`, {
        method: "POST",
        body: JSON.stringify({ payment_method: payMethod }),
      });
      const d = await r.json();
      if (r.ok) { toast({ title: `✅ NFT Purchased!` }); onSuccess(); onClose(); }
      else toast({ variant: "destructive", title: d.error ?? "Purchase failed" });
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setBuying(false);
  };

  const finalPrice = nft.list_price ? (nft.list_price * (1 + (pm.fee ?? 0) / 100)).toFixed(2) : "0";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-primary/20 rounded-xl w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
          <span className="font-mono font-bold text-sm">Buy NFT</span>
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="bg-muted/20 rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Gem className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="font-mono text-sm font-bold">{nft.plan?.replace(/_/g, " ")}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Sold by {nft.seller_username ?? "—"}</div>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground block mb-2">Payment Method</label>
            <div className="flex gap-2 flex-wrap">
              {PAYMENT_METHODS.map(m => <PaymentPill key={m.id} method={m} selected={payMethod === m.id} onClick={() => setPayMethod(m.id)} />)}
            </div>
          </div>

          {payMethod !== "azn" && nft.market_payment_details && (
            <div className="bg-muted/20 rounded-lg p-3 font-mono text-[11px]">
              <div className="text-muted-foreground mb-0.5">Send payment to:</div>
              <div className="font-bold text-foreground">{nft.market_payment_details}</div>
            </div>
          )}

          <div className="bg-muted/20 rounded-lg p-3 font-mono text-[11px] space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">List price</span><span>{nft.list_price} AZN</span></div>
            {(pm.fee ?? 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Fee ({pm.fee ?? 0}%)</span><span className="text-amber-400">+{(nft.list_price * (pm.fee ?? 0) / 100).toFixed(2)} AZN</span></div>}
            <div className="flex justify-between font-bold border-t border-border/30 pt-1"><span>Total</span><span className="text-primary">{finalPrice} AZN</span></div>
          </div>

          <Button onClick={handleBuy} disabled={buying} className="w-full font-mono text-xs gap-2">
            {buying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShoppingCart className="w-3.5 h-3.5" />}
            Confirm Purchase
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function NftMarketplace() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [categories, setCategories] = useState<any[]>([]);
  const [listings, setListings] = useState<any[]>([]);
  const [myNfts, setMyNfts] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState("all");
  const [showInventory, setShowInventory] = useState(false);
  const [showSell, setShowSell] = useState(false);
  const [buyNft, setBuyNft] = useState<any>(null);

  // Admin state
  const isAdmin = user?.role === "admin" || user?.role === "dev";
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCatLabel, setNewCatLabel] = useState("");
  const [addingCat, setAddingCat] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const catQ = catFilter !== "all" ? `?category=${encodeURIComponent(catFilter)}` : "";
      const [cats, market, my, st] = await Promise.all([
        api("/nft-subscriptions/categories").then(r => r.json()),
        api(`/nft-subscriptions/marketplace${catQ}`).then(r => r.json()),
        api("/nft-subscriptions/my-nfts").then(r => r.json()),
        api("/nft-subscriptions/stats").then(r => r.json()),
      ]);
      setCategories(Array.isArray(cats) ? cats : []);
      setListings(Array.isArray(market) ? market : []);
      setMyNfts(Array.isArray(my) ? my : []);
      setStats(st);
    } catch { toast({ variant: "destructive", title: "Failed to load NFT data" }); }
    setLoading(false);
  }, [catFilter]);

  useEffect(() => { load(); }, [load]);

  const handleDelist = async (nft: any) => {
    try {
      const r = await api(`/nft-subscriptions/${nft.id}/delist`, { method: "POST" });
      if (r.ok) { toast({ title: "Delisted" }); load(); }
    } catch { toast({ variant: "destructive", title: "Error" }); }
  };

  const handleAddCategory = async () => {
    if (!newCatLabel.trim()) return;
    setAddingCat(true);
    try {
      const r = await api("/nft-subscriptions/categories", {
        method: "POST",
        body: JSON.stringify({ name: newCatLabel.trim().toLowerCase().replace(/\s+/g, "_"), label: newCatLabel.trim() }),
      });
      const d = await r.json();
      if (r.ok) { toast({ title: "Category added!" }); setNewCatLabel(""); setShowAddCat(false); load(); }
      else toast({ variant: "destructive", title: d.error });
    } catch { toast({ variant: "destructive", title: "Error" }); }
    setAddingCat(false);
  };

  const handleRemoveCategory = async (cat: any) => {
    try {
      await api(`/nft-subscriptions/categories/${cat.id}`, { method: "DELETE" });
      toast({ title: `Removed "${cat.label}"` }); load();
    } catch { toast({ variant: "destructive", title: "Error" }); }
  };

  return (
    <div className="space-y-5 page-enter">
      {showSell && <SellModal myNfts={myNfts} onClose={() => setShowSell(false)} onSuccess={load} />}
      {buyNft && <BuyModal nft={buyNft} onClose={() => setBuyNft(null)} onSuccess={load} />}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Gem className="w-5 h-5 text-primary" /> NFT Market
          </h2>
          <p className="text-muted-foreground font-mono text-[11px] mt-0.5">Trade AYZEN NFTs · AZN · Binance · bKash · Nagad</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-mono text-xs gap-1.5 h-8">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </Button>
          {/* Inventory Button */}
          <Button
            variant="outline" size="sm"
            onClick={() => setShowInventory(v => !v)}
            className={cn("font-mono text-xs gap-1.5 h-8", showInventory && "border-primary/40 bg-primary/10 text-primary")}
          >
            <Package className="w-3.5 h-3.5" /> Inventory
            {myNfts.length > 0 && (
              <span className="bg-primary/20 text-primary text-[9px] rounded-full px-1.5 py-0.5 font-bold">{myNfts.length}</span>
            )}
          </Button>
          <Button size="sm" className="font-mono text-xs gap-1.5 h-8" onClick={() => setShowSell(true)}>
            <Tag className="w-3.5 h-3.5" /> Sell NFT
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Minted", value: stats?.totalMinted ?? 0, icon: Gem, color: "text-primary" },
          { label: "Listed",       value: stats?.listed ?? 0,       icon: Tag, color: "text-emerald-400" },
          { label: "Volume (AZN)", value: stats?.tradingVolume?.toFixed(0) ?? 0, icon: TrendingUp, color: "text-amber-400" },
          { label: "My NFTs",      value: myNfts.length,             icon: Wallet, color: "text-violet-400" },
        ].map(s => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="bg-card border border-border/30 rounded-xl p-3 flex items-center gap-3">
              <div className={cn("w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center", s.color)}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <div className={cn("font-mono text-base font-bold", s.color)}>{s.value}</div>
                <div className="font-mono text-[9px] text-muted-foreground">{s.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Inventory Panel */}
      {showInventory && (
        <div className="bg-card border border-border/40 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground font-bold flex items-center gap-2">
              <Package className="w-3.5 h-3.5" /> My NFT Inventory
            </h3>
            <button onClick={() => setShowInventory(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          {myNfts.length === 0 ? (
            <p className="text-center py-4 font-mono text-sm text-muted-foreground/50">No NFTs in your inventory</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {myNfts.map(nft => (
                <div key={nft.id} className={cn(
                  "flex items-center gap-3 p-3 rounded-lg border",
                  nft.is_listed ? "border-amber-500/20 bg-amber-500/5" : "border-border/30"
                )}>
                  <div className="w-8 h-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                    <Gem className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs font-bold truncate">{nft.plan?.replace(/_/g, " ")}</div>
                    <div className="font-mono text-[9px] text-muted-foreground truncate">{nft.token_id}</div>
                    {nft.is_listed && <div className="font-mono text-[9px] text-amber-400">Listed: {nft.list_price} AZN</div>}
                  </div>
                  {nft.is_listed ? (
                    <Button size="sm" variant="outline"
                      onClick={() => handleDelist(nft)}
                      className="h-6 text-[9px] font-mono border-red-500/20 text-red-400 hover:bg-red-500/10 flex-shrink-0">
                      Delist
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline"
                      onClick={() => { setShowInventory(false); setShowSell(true); }}
                      className="h-6 text-[9px] font-mono border-primary/20 text-primary hover:bg-primary/10 flex-shrink-0">
                      Sell
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Admin: Category Management */}
      {isAdmin && (
        <div className="bg-card border border-border/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground font-bold">Category Management</h3>
            <Button size="sm" variant="outline" onClick={() => setShowAddCat(v => !v)} className="font-mono text-[10px] h-7 gap-1">
              <Plus className="w-3 h-3" /> Add Category
            </Button>
          </div>
          {showAddCat && (
            <div className="flex gap-2">
              <Input value={newCatLabel} onChange={e => setNewCatLabel(e.target.value)}
                placeholder="Category label (e.g. Rare Pass)"
                className="font-mono text-sm h-8" />
              <Button size="sm" onClick={handleAddCategory} disabled={addingCat || !newCatLabel.trim()} className="font-mono text-xs h-8 flex-shrink-0">
                {addingCat ? "..." : "Add"}
              </Button>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {categories.map(cat => {
              const Icon = getCatIcon(cat.icon);
              return (
                <div key={cat.id} className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono", cat.color ?? "text-primary", "border-border/40 bg-muted/20")}>
                  <Icon className="w-3 h-3" />
                  {cat.label}
                  <button onClick={() => handleRemoveCategory(cat)} className="ml-0.5 text-muted-foreground hover:text-red-400 transition-colors">
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Category Filters */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setCatFilter("all")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono rounded-full border transition-all",
            catFilter === "all" ? "bg-primary/10 border-primary/40 text-primary" : "border-border/40 text-muted-foreground hover:border-primary/20")}>
          <Gem className="w-3 h-3" /> All NFTs
        </button>
        {categories.map(cat => {
          const Icon = getCatIcon(cat.icon);
          return (
            <button key={cat.id} onClick={() => setCatFilter(cat.name)}
              className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono rounded-full border transition-all",
                catFilter === cat.name ? `bg-primary/10 border-primary/40 ${cat.color ?? "text-primary"}` : "border-border/40 text-muted-foreground hover:border-primary/20")}>
              <Icon className="w-3 h-3" /> {cat.label}
            </button>
          );
        })}
      </div>

      {/* NFT Library Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[1,2,3,4,5,6].map(i => <div key={i} className="aspect-square bg-card border border-border/30 rounded-xl animate-pulse" />)}
        </div>
      ) : listings.length === 0 ? (
        <div className="py-16 text-center bg-card border border-border/30 rounded-xl">
          <ShoppingCart className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground">No NFTs listed for sale</p>
          <p className="font-mono text-[11px] text-muted-foreground/50 mt-1">
            {catFilter !== "all" ? "Try a different category" : "Be the first to list an NFT"}
          </p>
          <Button size="sm" className="mt-4 font-mono text-xs gap-1.5" onClick={() => setShowSell(true)}>
            <Tag className="w-3.5 h-3.5" /> List Your NFT
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {listings.map(nft => {
            const isOwn = nft.owner_id === user?.id;
            const catDef = categories.find(c => c.name === nft.nft_category);
            const Icon = getCatIcon(catDef?.icon);
            return (
              <div key={nft.id} className="bg-card border border-border/30 rounded-xl overflow-hidden hover:border-primary/30 transition-all flex flex-col">
                {/* Image / placeholder */}
                {nft.image_url ? (
                  <div className="aspect-square overflow-hidden">
                    <img src={nft.image_url} alt={nft.plan} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="aspect-square flex items-center justify-center bg-primary/5 border-b border-border/20">
                    <Icon className={cn("w-16 h-16 opacity-20", catDef?.color ?? "text-primary")} />
                  </div>
                )}

                <div className="p-3 space-y-2 flex flex-col flex-1">
                  <div>
                    <div className="font-mono font-bold text-sm truncate">{nft.plan?.replace(/_/g, " ")}</div>
                    {nft.badge_name && <div className="font-mono text-[10px] text-amber-400">{nft.badge_name}</div>}
                    <div className="font-mono text-[9px] text-muted-foreground/50 truncate">{nft.token_id}</div>
                  </div>

                  {nft.seller_username && (
                    <div className="font-mono text-[9px] text-muted-foreground/60">by {nft.seller_username}</div>
                  )}

                  {nft.market_payment_method && nft.market_payment_method !== "azn" && (
                    <div className="flex items-center gap-1">
                      {PAYMENT_METHODS.filter(p => p.id === nft.market_payment_method).map(pm => {
                        const PMIcon = pm.icon;
                        return (
                          <Badge key={pm.id} variant="outline" className={cn("font-mono text-[8px] gap-1", pm.color, pm.border)}>
                            <PMIcon className="w-2.5 h-2.5" />{pm.label}
                          </Badge>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-auto pt-1">
                    <div>
                      <div className="font-mono text-base font-bold text-primary">{nft.list_price} AZN</div>
                      <div className="font-mono text-[9px] text-muted-foreground/50">${((nft.list_price ?? 0) / 100).toFixed(2)}</div>
                    </div>
                    {isOwn ? (
                      <Button variant="outline" size="sm" onClick={() => handleDelist(nft)}
                        className="h-7 text-[10px] gap-1 border-red-500/20 text-red-400 hover:bg-red-500/10">
                        <X className="w-3 h-3" /> Delist
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setBuyNft(nft)} className="h-7 text-[10px] gap-1">
                        <ShoppingCart className="w-3 h-3" /> Buy
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
