import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Store, CheckCircle2, XCircle, Clock, RefreshCw, Loader2,
  DollarSign, Tag, Coins, Shield, Smartphone, Gem, Package,
  Settings, TrendingUp, ShoppingCart, User, Award, Activity,
  Zap, Crown, Star, ArrowUpDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { getMarketplaceTypeMeta } from "@/config/marketplace";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Order {
  id: number; listing_id: number; title: string; listing_type: string; metadata?: any;
  buyer_id: number; seller_id: number; buyer_username: string; seller_username: string;
  price_azn: number; fee_pct: number; fee_azn?: number; seller_receives?: number;
  status: string; message?: string; admin_note?: string; created_at: string; resolved_at?: string;
}

interface Listing {
  id: number; seller_id: number; seller_username: string; listing_type: string;
  title: string; description?: string; price_azn: number; status: string; created_at: string; image_url?: string;
}

interface NftItem {
  id: number; token_id: string; plan: string; nft_type: string; nft_category: string;
  image_url?: string; badge_name?: string; owner_username: string; original_owner_username: string;
  is_listed: boolean; list_price?: number; transfer_count: number; is_burned: boolean; minted_at: string;
}

interface ActivityEntry {
  id: number; event_type: string; actor_id?: number; actor_username?: string;
  target_id?: number; target_type?: string; title: string; details?: string;
  amount_azn?: number; status?: string; created_at: string;
}

// ── Badge components ──────────────────────────────────────────────────────────

// Listing-type icon lookup now lives in @/config/marketplace.ts as
// MARKETPLACE_TYPE_CONFIG (shared with the user-facing marketplace pages;
// extended there with the two admin-only order types this page also
// handles — subscription_pass, lifetime_pass). Adding a listing/order
// type is one entry there.

function TypeBadge({ type }: { type: string }) {
  const Icon = getMarketplaceTypeMeta(type).icon;
  return (
    <Badge variant="outline" className="font-mono text-[10px] gap-1 text-cyan-400 border-cyan-400/30">
      <Icon className="w-3 h-3" /> {type.replace(/_/g, " ")}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    pending:   { label: "Pending",   cls: "text-amber-400 border-amber-400/30" },
    approved:  { label: "Approved",  cls: "text-emerald-400 border-emerald-400/30" },
    rejected:  { label: "Rejected",  cls: "text-red-400 border-red-400/30" },
    active:    { label: "Active",    cls: "text-cyan-400 border-cyan-400/30" },
    sold:      { label: "Sold",      cls: "text-muted-foreground border-border" },
    cancelled: { label: "Cancelled", cls: "text-muted-foreground border-border" },
    completed: { label: "Completed", cls: "text-emerald-400 border-emerald-400/30" },
  };
  const s = cfg[status] ?? { label: status, cls: "text-muted-foreground" };
  return <Badge variant="outline" className={cn("font-mono text-[10px]", s.cls)}>{s.label}</Badge>;
}

// ── Order Action Modal ────────────────────────────────────────────────────────

function OrderActionModal({ order, action, onClose, onDone }: {
  order: Order; action: "approve" | "reject"; onClose: () => void; onDone: () => void;
}) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  const feePct = order.fee_pct ?? 5;
  const feeAzn = (order.price_azn * feePct) / 100;
  const sellerReceives = order.price_azn - feeAzn;

  const submit = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/marketplace/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, admin_note: note }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: `Order ${action === "approve" ? "approved" : "rejected"}!` });
      onClose(); onDone();
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setLoading(false);
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm bg-card border border-border font-mono">
        <DialogHeader>
          <DialogTitle className={cn("font-mono text-sm flex items-center gap-2", action === "approve" ? "text-emerald-400" : "text-red-400")}>
            {action === "approve" ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {action === "approve" ? "Approve Order" : "Reject Order"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="bg-muted/30 rounded-lg p-3 border border-border/40 space-y-1.5 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Item</span><span className="font-bold truncate max-w-[60%]">{order.title}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Buyer</span><span>{order.buyer_username}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Seller</span><span>{order.seller_username}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="text-primary font-bold">{order.price_azn} AZN</span></div>
            {action === "approve" && (
              <>
                <div className="flex justify-between text-amber-400"><span>Platform fee ({feePct}%)</span><span>{feeAzn.toFixed(2)} AZN</span></div>
                <div className="flex justify-between text-emerald-400"><span>Seller receives</span><span className="font-bold">{sellerReceives.toFixed(2)} AZN</span></div>
              </>
            )}
            {action === "reject" && (
              <div className="flex justify-between text-cyan-400"><span>Buyer refund</span><span className="font-bold">{order.price_azn} AZN</span></div>
            )}
          </div>
          {order.message && (
            <div className="bg-muted/20 rounded-lg p-2 text-xs">
              <span className="text-muted-foreground">Buyer note: </span><span>{order.message}</span>
            </div>
          )}
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Admin Note (shown to user)</label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason or comment…" className="font-mono text-xs h-8" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={loading}
            className={cn("text-xs gap-1", action === "approve" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-red-600 hover:bg-red-500")}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : action === "approve" ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
            {action === "approve" ? "Approve & Transfer" : "Reject & Refund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create Order Modal (admin places an order on a buyer's behalf) ─────────────

function CreateOrderModal({ token, onClose, onDone }: { token: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [listings, setListings] = useState<Listing[]>([]);
  const [listingId, setListingId] = useState<string>("");
  const [buyerSearch, setBuyerSearch] = useState("");
  const [buyerResults, setBuyerResults] = useState<{ id: number; username: string }[]>([]);
  const [buyer, setBuyer] = useState<{ id: number; username: string } | null>(null);
  const [priceOverride, setPriceOverride] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/admin/marketplace/listings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((d: Listing[]) => setListings((d ?? []).filter(l => l.status === "active")));
  }, [token]);

  useEffect(() => {
    if (buyerSearch.trim().length < 2) { setBuyerResults([]); return; }
    const t = setTimeout(() => {
      fetch(`${BASE}/api/users?search=${encodeURIComponent(buyerSearch.trim())}&limit=6`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : { users: [] })
        .then(d => setBuyerResults((d.users ?? []).map((u: any) => ({ id: u.id, username: u.username }))));
    }, 250);
    return () => clearTimeout(t);
  }, [buyerSearch, token]);

  const selectedListing = listings.find(l => String(l.id) === listingId);

  const submit = async () => {
    if (!listingId || !buyer) { toast({ title: "Pick a listing and a buyer", variant: "destructive" }); return; }
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/marketplace/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          listing_id: Number(listingId), buyer_id: buyer.id,
          price_azn: priceOverride.trim() ? Number(priceOverride) : undefined,
          message: message.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "Order created — pending approval" });
      onClose(); onDone();
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setLoading(false);
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm bg-card border border-border font-mono">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2 text-primary">
            <ShoppingCart className="w-4 h-4" /> New Order
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Listing</label>
            <select value={listingId} onChange={e => setListingId(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-background/50 text-xs px-2 font-mono">
              <option value="">Select an active listing…</option>
              {listings.map(l => <option key={l.id} value={l.id}>#{l.id} — {l.title} ({l.price_azn} AZN)</option>)}
            </select>
          </div>

          <div className="relative">
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Buyer</label>
            {buyer ? (
              <div className="flex items-center justify-between h-9 px-2.5 rounded-md border border-primary/30 bg-primary/5 text-xs">
                <span className="text-foreground font-bold">{buyer.username}</span>
                <button onClick={() => { setBuyer(null); setBuyerSearch(""); }} className="text-muted-foreground hover:text-red-400"><XCircle className="w-3.5 h-3.5" /></button>
              </div>
            ) : (
              <>
                <Input value={buyerSearch} onChange={e => setBuyerSearch(e.target.value)} placeholder="Search username…" className="h-9 text-xs" />
                {buyerResults.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-card border border-border rounded-md shadow-lg overflow-hidden">
                    {buyerResults.map(u => (
                      <button key={u.id} onClick={() => { setBuyer(u); setBuyerResults([]); }}
                        className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-primary/10 text-foreground">
                        {u.username}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">
              Price override (AZN){selectedListing ? ` — sticker: ${selectedListing.price_azn}` : ""}
            </label>
            <Input type="number" min={0.01} step={0.01} value={priceOverride} onChange={e => setPriceOverride(e.target.value)}
              placeholder={selectedListing ? String(selectedListing.price_azn) : "leave blank for sticker price"} className="h-9 text-xs" />
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Note (optional)</label>
            <Input value={message} onChange={e => setMessage(e.target.value)} placeholder="e.g. Support ticket #482" className="h-9 text-xs" />
          </div>

          <p className="text-[10px] text-muted-foreground/60">Buyer's AZN is reserved immediately; the order lands in Pending for the usual approve/reject step.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={loading || !listingId || !buyer} className="text-xs gap-1">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Create Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Order Detail Modal (view) ───────────────────────────────────────────────────

function OrderDetailModal({ orderId, token, onClose, onEdit }: {
  orderId: number; token: string; onClose: () => void; onEdit: (o: Order) => void;
}) {
  const { toast } = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BASE}/api/admin/marketplace/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Failed to load order")))
      .then(setOrder)
      .catch((e: any) => toast({ title: e.message, variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [orderId, token]);

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm bg-card border border-border font-mono">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2 text-primary">
            <ShoppingCart className="w-4 h-4" /> Order #{orderId}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>
        ) : order ? (
          <div className="space-y-3 py-1">
            <div className="bg-muted/30 rounded-lg p-3 border border-border/40 space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Item</span><span className="font-bold truncate max-w-[60%]">{order.title}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Status</span><StatusBadge status={order.status} /></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Buyer</span><span>{order.buyer_username}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Seller</span><span>{order.seller_username}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="text-primary font-bold">{order.price_azn} AZN</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Fee %</span><span>{order.fee_pct}%</span></div>
              {order.fee_azn !== undefined && order.fee_azn !== null && (
                <div className="flex justify-between"><span className="text-muted-foreground">Fee charged</span><span>{order.fee_azn} AZN</span></div>
              )}
              {order.seller_receives !== undefined && order.seller_receives !== null && (
                <div className="flex justify-between text-emerald-400"><span>Seller received</span><span className="font-bold">{order.seller_receives} AZN</span></div>
              )}
              <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{new Date(order.created_at).toLocaleString()}</span></div>
              {order.resolved_at && (
                <div className="flex justify-between"><span className="text-muted-foreground">Resolved</span><span>{new Date(order.resolved_at).toLocaleString()}</span></div>
              )}
            </div>
            {order.message && (
              <div className="bg-muted/20 rounded-lg p-2 text-xs"><span className="text-muted-foreground">Buyer note: </span>{order.message}</div>
            )}
            {order.admin_note && (
              <div className="bg-amber-500/10 rounded-lg p-2 text-xs text-amber-400"><span className="text-muted-foreground">Admin note: </span>{order.admin_note}</div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-6 text-center">Order not found.</p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">Close</Button>
          {order?.status === "pending" && (
            <Button size="sm" variant="outline" onClick={() => order && onEdit(order)} className="text-xs gap-1">
              <Settings className="w-3 h-3" /> Edit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Order Modal (pending orders only — price/fee/notes) ───────────────────

function EditOrderModal({ order, token, onClose, onDone }: {
  order: Order; token: string; onClose: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [price, setPrice] = useState(String(order.price_azn));
  const [feePct, setFeePct] = useState(String(order.fee_pct ?? 5));
  const [note, setNote] = useState(order.admin_note ?? "");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/marketplace/orders/${order.id}/edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ price_azn: Number(price), fee_pct: Number(feePct), admin_note: note.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "Order updated" });
      onClose(); onDone();
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setLoading(false);
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm bg-card border border-border font-mono">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2 text-primary">
            <Settings className="w-4 h-4" /> Edit Order #{order.id}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Price (AZN)</label>
            <Input type="number" min={0.01} step={0.01} value={price} onChange={e => setPrice(e.target.value)} className="h-9 text-xs" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Fee %</label>
            <Input type="number" min={0} max={100} step={0.5} value={feePct} onChange={e => setFeePct(e.target.value)} className="h-9 text-xs" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Admin note</label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason for the change…" className="h-9 text-xs" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={loading} className="text-xs gap-1">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────

function SettingsPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [feePct, setFeePct] = useState("5");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/marketplace/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setFeePct(String(d.fee_pct ?? 5)); setEnabled(d.enabled ?? true); }).catch(() => {});
  }, [token]);

  const save = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/marketplace/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fee_pct: Number(feePct), enabled }),
      });
      if (!r.ok) throw new Error("Failed");
      toast({ title: "Settings saved" });
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setLoading(false);
  };

  return (
    <div className="bg-card border border-border/40 rounded-xl p-5 space-y-4 max-w-sm">
      <h3 className="font-mono text-sm font-bold text-foreground flex items-center gap-2">
        <Settings className="w-4 h-4 text-primary" /> Marketplace Settings
      </h3>
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1">Platform Fee (%)</label>
        <Input value={feePct} onChange={e => setFeePct(e.target.value)} type="number" min="0" max="50" step="0.5" className="font-mono text-xs h-8 w-32" />
        <p className="text-[10px] text-muted-foreground/50 mt-1">Deducted from seller on each approved trade.</p>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={() => setEnabled(e => !e)}
          className={cn("w-9 h-5 rounded-full transition-colors relative", enabled ? "bg-primary" : "bg-muted")}>
          <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", enabled ? "right-0.5" : "left-0.5")} />
        </button>
        <span className="text-xs font-mono text-muted-foreground">Marketplace {enabled ? "enabled" : "disabled"}</span>
      </div>
      <Button size="sm" onClick={save} disabled={loading} className="text-xs gap-1">
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Save Settings
      </Button>
    </div>
  );
}

// ── NFT Subscriptions Panel ───────────────────────────────────────────────────

const PLAN_COLOR: Record<string, string> = {
  pro: "text-cyan-400 border-cyan-400/30",
  enterprise: "text-violet-400 border-violet-400/30",
  lifetime_pro: "text-teal-400 border-teal-400/30",
  lifetime_enterprise: "text-rose-400 border-rose-400/30",
  username: "text-cyan-300 border-cyan-300/30",
  achievement_badge: "text-amber-400 border-amber-400/30",
};
const PLAN_ICON: Record<string, React.ElementType> = {
  pro: Zap, enterprise: Crown, lifetime_pro: Star, lifetime_enterprise: Shield,
  username: User, achievement_badge: Award,
};

function NftPanel({ token }: { token: string }) {
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [planFilter, setPlanFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/nft-subscriptions`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setNfts(await r.json());
    } catch { } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const filtered = planFilter === "all" ? nfts : nfts.filter(n => n.plan === planFilter);
  const plans = ["all", ...Array.from(new Set(nfts.map(n => n.plan)))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {plans.map(p => {
            const Icon = p === "all" ? Gem : (PLAN_ICON[p] ?? Package);
            const color = p === "all" ? "text-primary border-primary/40 bg-primary/10" : "";
            return (
              <button key={p} onClick={() => setPlanFilter(p)}
                className={cn("flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono rounded-full border transition-all",
                  planFilter === p
                    ? (p === "all" ? color : cn(PLAN_COLOR[p] ?? "text-primary border-primary/40", "bg-card"))
                    : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                <Icon className="w-3 h-3" /> {p === "all" ? "All" : p.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" onClick={load} className="h-8 text-xs gap-1">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Minted", val: nfts.length, color: "text-primary" },
          { label: "Listed",       val: nfts.filter(n => n.is_listed).length, color: "text-emerald-400" },
          { label: "Transferred",  val: nfts.filter(n => n.transfer_count > 0).length, color: "text-amber-400" },
        ].map(s => (
          <div key={s.label} className="bg-card/60 border border-border/40 rounded-xl p-3 text-center">
            <div className={cn("font-mono text-xl font-bold", s.color)}>{s.val}</div>
            <div className="text-[10px] text-muted-foreground/60 font-mono">{s.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <Gem className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-sm text-muted-foreground/40">No NFTs found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(nft => {
            const Icon = PLAN_ICON[nft.plan] ?? Gem;
            const planColor = PLAN_COLOR[nft.plan] ?? "text-muted-foreground border-border";
            return (
              <div key={nft.id} className="flex items-center gap-3 bg-card/60 border border-border/40 rounded-xl p-3 hover:border-primary/20 transition-all">
                {nft.image_url ? (
                  <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0">
                    <img src={nft.image_url} alt={nft.plan} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-muted/20 border", planColor)}>
                    <Icon className="w-4 h-4" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="font-mono text-sm font-bold text-foreground">{nft.token_id}</span>
                    <Badge variant="outline" className={cn("font-mono text-[9px] gap-1", planColor)}>
                      <Icon className="w-2.5 h-2.5" /> {nft.plan.replace(/_/g, " ")}
                    </Badge>
                    {nft.is_listed && <Badge variant="outline" className="font-mono text-[9px] text-amber-400 border-amber-400/30">Listed {nft.list_price} AZN</Badge>}
                    {nft.badge_name && <Badge variant="outline" className="font-mono text-[9px] text-amber-300 border-amber-300/20">{nft.badge_name}</Badge>}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/60">
                    Owner: <span className="text-foreground">{nft.owner_username}</span>
                    {nft.transfer_count > 0 && <span className="ml-2">· {nft.transfer_count} transfer{nft.transfer_count !== 1 ? "s" : ""}</span>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0 text-[10px] font-mono text-muted-foreground/60">
                  {new Date(nft.minted_at).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Activity Log Panel ────────────────────────────────────────────────────────

const EVENT_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  nft_mint:        { label: "NFT Minted",     icon: Gem,         color: "text-primary" },
  nft_listed:      { label: "NFT Listed",     icon: Tag,         color: "text-cyan-400" },
  nft_sold:        { label: "NFT Sold",       icon: ShoppingCart, color: "text-emerald-400" },
  listing_created: { label: "Listing Created", icon: Plus,        color: "text-violet-400" },
  order_placed:    { label: "Order Placed",   icon: Clock,       color: "text-amber-400" },
  order_approved:  { label: "Order Approved", icon: CheckCircle2, color: "text-emerald-400" },
  order_rejected:  { label: "Order Rejected", icon: XCircle,     color: "text-red-400" },
};

// Inline Plus for the import
function Plus({ className }: { className?: string }) { return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }

function ActivityPanel({ token }: { token: string }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [eventFilter, setEventFilter] = useState("");
  const [page, setPage] = useState(0);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
      if (eventFilter) q.set("event_type", eventFilter);
      const r = await fetch(`${BASE}/api/admin/marketplace/activity?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); setEntries(d.entries ?? []); setTotal(d.total ?? 0); }
    } catch { } finally { setLoading(false); }
  }, [token, eventFilter, page]);

  useEffect(() => { load(); }, [load]);

  const eventTypes = ["", "nft_mint", "nft_listed", "nft_sold", "listing_created", "order_placed", "order_approved", "order_rejected"];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {eventTypes.map(et => {
            const cfg = et ? (EVENT_CONFIG[et] ?? { label: et, icon: Activity, color: "" }) : { label: "All Events", icon: Activity, color: "" };
            const Icon = cfg.icon;
            return (
              <button key={et} onClick={() => { setEventFilter(et); setPage(0); }}
                className={cn("flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono rounded-full border transition-all",
                  eventFilter === et ? "bg-primary/10 border-primary/40 text-primary" : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                <Icon className="w-3 h-3" /> {cfg.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground/60">{total} events</span>
          <Button variant="ghost" size="sm" onClick={load} className="h-8 text-xs gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12">
          <Activity className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-sm text-muted-foreground/40">No activity yet</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map(e => {
            const cfg = EVENT_CONFIG[e.event_type] ?? { label: e.event_type, icon: Activity, color: "text-muted-foreground" };
            const Icon = cfg.icon;
            return (
              <div key={e.id} className="flex items-center gap-3 bg-card/50 border border-border/30 rounded-lg px-4 py-2.5 hover:border-primary/15 transition-all">
                <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-muted/20", cfg.color)}>
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold text-foreground">{e.title}</span>
                    <Badge variant="outline" className={cn("font-mono text-[9px]", cfg.color, "border-current/30")}>
                      {cfg.label}
                    </Badge>
                    {e.status && <StatusBadge status={e.status} />}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                    {e.actor_username && <span>by <span className="text-foreground">{e.actor_username}</span></span>}
                    {e.details && <span className="ml-2">{e.details}</span>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  {e.amount_azn != null && e.amount_azn > 0 && (
                    <div className="font-mono text-sm font-bold text-primary">{e.amount_azn} AZN</div>
                  )}
                  <div className="text-[9px] font-mono text-muted-foreground/50">{new Date(e.created_at).toLocaleString()}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="text-xs h-7">Prev</Button>
          <span className="font-mono text-xs text-muted-foreground">{page + 1} / {Math.ceil(total / limit)}</span>
          <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total} className="text-xs h-7">Next</Button>
        </div>
      )}
    </div>
  );
}

// ── Main Admin Marketplace ────────────────────────────────────────────────────

export default function AdminMarketplace() {
  const { token } = useAuth() as any;
  const [tab, setTab] = useState<"orders" | "listings" | "nfts" | "activity" | "settings">("orders");
  const [orders, setOrders] = useState<Order[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<any>(null);
  const [actionModal, setActionModal] = useState<{ order: Order; action: "approve" | "reject" } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [viewOrderId, setViewOrderId] = useState<number | null>(null);
  const [editOrder, setEditOrder] = useState<Order | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const q = statusFilter ? `?status=${statusFilter}` : "";
      const r = await fetch(`${BASE}/api/admin/marketplace/orders${q}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); setOrders(d.orders ?? []); }
    } catch { } finally { setLoading(false); }
  }, [token, statusFilter]);

  const loadListings = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/marketplace/listings`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setListings(await r.json());
    } catch { } finally { setLoading(false); }
  }, [token]);

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/marketplace/stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setStats(await r.json());
    } catch { }
  }, [token]);

  useEffect(() => {
    loadStats();
    if (tab === "orders") loadOrders();
    else if (tab === "listings") loadListings();
  }, [tab, loadOrders, loadListings, loadStats]);

  useEffect(() => { if (tab === "orders") loadOrders(); }, [statusFilter, loadOrders, tab]);

  const TABS = [
    { id: "orders",   label: "Orders",     icon: ShoppingCart },
    { id: "listings", label: "Listings",   icon: Tag },
    { id: "nfts",     label: "NFTs",       icon: Gem },
    { id: "activity", label: "Activity",   icon: Activity },
    { id: "settings", label: "Settings",   icon: Settings },
  ] as const;

  const pendingCount = orders.filter(o => o.status === "pending").length;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono font-bold text-xl text-foreground flex items-center gap-2">
            <Store className="w-5 h-5 text-primary" /> Marketplace Admin
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">Monitor orders, listings, NFTs and platform activity</p>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Active Listings",  val: stats.active_listings,   icon: Tag,          color: "text-cyan-400" },
            { label: "Completed Trades", val: stats.completed_trades,  icon: CheckCircle2, color: "text-emerald-400" },
            { label: "Total Volume",     val: `${Number(stats.total_volume_azn ?? 0).toFixed(0)} AZN`, icon: Coins, color: "text-amber-400" },
            { label: "Fees Collected",   val: `${Number(stats.total_fees_azn ?? 0).toFixed(0)} AZN`,  icon: DollarSign, color: "text-violet-400" },
          ].map(s => (
            <div key={s.label} className="bg-card/60 border border-border/40 rounded-xl p-3 flex items-center gap-3">
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
              className={cn("flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-mono font-bold transition-all relative whitespace-nowrap flex-shrink-0",
                tab === t.id ? "bg-card text-primary shadow-sm border border-primary/20" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="w-3.5 h-3.5" /> {t.label}
              {t.id === "orders" && pendingCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-white rounded-full text-[9px] font-bold flex items-center justify-center">{pendingCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Orders Tab ── */}
      {tab === "orders" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {["all", "pending", "approved", "rejected"].map(s => (
              <button key={s} onClick={() => setStatusFilter(s === "all" ? "" : s)}
                className={cn("px-3 py-1.5 rounded-lg border text-xs font-mono font-bold transition-all capitalize",
                  (s === "all" ? !statusFilter : statusFilter === s)
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/40 text-muted-foreground hover:border-primary/20")}>
                {s}
              </button>
            ))}
            <Button variant="ghost" size="sm" onClick={loadOrders} className="h-8 text-xs gap-1 ml-auto">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="h-8 text-xs gap-1">
              <Plus className="w-3.5 h-3.5" /> New Order
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>
          ) : orders.length === 0 ? (
            <div className="text-center py-12">
              <ShoppingCart className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="font-mono text-sm text-muted-foreground/40">No orders found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map(o => (
                <div key={o.id} className={cn("bg-card/60 border rounded-xl p-4 transition-all", o.status === "pending" ? "border-amber-500/30" : "border-border/40")}>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-foreground">{o.title}</span>
                        <TypeBadge type={o.listing_type} />
                        <StatusBadge status={o.status} />
                      </div>
                      <div className="text-xs font-mono text-muted-foreground/60 flex flex-wrap gap-3">
                        <span>Buyer: <span className="text-foreground">{o.buyer_username}</span></span>
                        <span>Seller: <span className="text-foreground">{o.seller_username}</span></span>
                        <span>{new Date(o.created_at).toLocaleDateString()}</span>
                      </div>
                      {o.message && <div className="text-[11px] font-mono text-muted-foreground italic">&quot;{o.message}&quot;</div>}
                      {o.admin_note && <div className="text-[11px] font-mono text-amber-400">Admin: {o.admin_note}</div>}
                    </div>
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="font-mono text-lg font-bold text-primary">{o.price_azn} AZN</div>
                      <div className="text-[10px] text-muted-foreground/50 font-mono">${(o.price_azn / 100).toFixed(2)} USD</div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setViewOrderId(o.id)} className="h-7 text-xs gap-1">
                          <Package className="w-3 h-3" /> View
                        </Button>
                        {o.status === "pending" && (
                          <>
                            <Button size="sm" onClick={() => setActionModal({ order: o, action: "approve" })}
                              className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-500">
                              <CheckCircle2 className="w-3 h-3" /> Approve
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => setActionModal({ order: o, action: "reject" })}
                              className="h-7 text-xs gap-1">
                              <XCircle className="w-3 h-3" /> Reject
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Listings Tab ── */}
      {tab === "listings" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={loadListings} className="h-8 text-xs gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary/30" /></div>
          ) : listings.length === 0 ? (
            <div className="text-center py-12">
              <Tag className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="font-mono text-sm text-muted-foreground/40">No listings yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {listings.map(l => (
                <div key={l.id} className="flex items-center gap-3 bg-card/60 border border-border/40 rounded-xl p-3.5 hover:border-primary/20 transition-all">
                  {l.image_url ? (
                    <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0">
                      <img src={l.image_url} alt={l.title} className="w-full h-full object-cover" />
                    </div>
                  ) : null}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-mono text-sm font-bold text-foreground">{l.title}</span>
                      <TypeBadge type={l.listing_type} />
                      <StatusBadge status={l.status} />
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground/60">
                      Seller: {l.seller_username} · {new Date(l.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-mono font-bold text-primary">{l.price_azn} AZN</div>
                    <div className="text-[10px] text-muted-foreground/50">${(l.price_azn / 100).toFixed(2)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── NFTs Tab ── */}
      {tab === "nfts" && <NftPanel token={token ?? ""} />}

      {/* ── Activity Log Tab ── */}
      {tab === "activity" && <ActivityPanel token={token ?? ""} />}

      {/* ── Settings Tab ── */}
      {tab === "settings" && <SettingsPanel token={token ?? ""} />}

      {/* Action Modal */}
      {actionModal && (
        <OrderActionModal
          order={actionModal.order}
          action={actionModal.action}
          onClose={() => setActionModal(null)}
          onDone={() => { setActionModal(null); loadOrders(); loadStats(); }}
        />
      )}

      {createOpen && (
        <CreateOrderModal
          token={token ?? ""}
          onClose={() => setCreateOpen(false)}
          onDone={() => { setCreateOpen(false); loadOrders(); }}
        />
      )}

      {viewOrderId !== null && (
        <OrderDetailModal
          orderId={viewOrderId}
          token={token ?? ""}
          onClose={() => setViewOrderId(null)}
          onEdit={o => { setViewOrderId(null); setEditOrder(o); }}
        />
      )}

      {editOrder && (
        <EditOrderModal
          order={editOrder}
          token={token ?? ""}
          onClose={() => setEditOrder(null)}
          onDone={() => { setEditOrder(null); loadOrders(); }}
        />
      )}
    </div>
  );
}
