import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Zap, Plus, X, ShoppingCart, Tag, RefreshCw,
  Wallet, BarChart3, TrendingUp, TrendingDown,
  Check, Store, Mail, MessageCircle, Github, Facebook,
  Send, ShieldCheck, KeyRound, DollarSign,
} from "lucide-react";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { AZN_ORDER_FIELDS } from "@/config/fields/order-create";
import { USDT_ORDER_FIELDS } from "@/config/fields/usdt-order-create";
import type { AznPaymentMethod } from "@/config/marketplace-azn";
import { useAznPaymentMethods } from "@/hooks/use-azn-payment-methods";
import { USDT_PAYMENT_METHODS, getUsdtPaymentDetailsMeta } from "@/config/marketplace-usdt";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const tok = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok()}`, ...(opts?.headers ?? {}) },
  });

// ── Buy Confirm Button with inline quantity selector ──────────────────────────
function BuyConfirmButton({ listing, onSuccess, toast }: { listing: any; onSuccess: () => void; toast: any }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [buying, setBuying] = useState(false);

  const handleBuy = async () => {
    if (!amount || Number(amount) <= 0) { toast({ title: "Enter amount to buy" }); return; }
    setBuying(true);
    try {
      const r = await api("/marketplace/azn/buy", {
        method: "POST",
        body: JSON.stringify({ listing_id: listing.id, amount: Number(amount) }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ variant: "destructive", title: d.error }); }
      else {
        toast({ title: `Bought ${amount} AZN!`, description: `Payment via ${d.payment_method?.toUpperCase()} · ${d.payment_details ?? ""}` });
        setOpen(false);
        onSuccess();
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setBuying(false);
  };

  if (!open) {
    return (
      <Button size="sm" onClick={() => { setAmount(""); setOpen(true); }} className="font-mono text-[10px] gap-1 h-8">
        <ShoppingCart className="w-3 h-3" /> Buy AZN
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="Amount"
        className="font-mono text-xs h-8 w-20"
        type="number"
        autoFocus
      />
      <Button size="sm" onClick={handleBuy} disabled={buying} className="font-mono text-[10px] h-8">
        {buying ? "..." : <Check className="w-3 h-3" />}
      </Button>
      <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// Payment methods for AZN buy/sell listings are now live-editable via
// Config Manager (/admin/config-manager, domain
// "marketplace-azn-payment-methods") — see hooks/use-azn-payment-methods.tsx.
// config/marketplace-azn.ts's static array is kept only as the fallback
// while that loads or if the domain is ever emptied.

function PaymentBadge({ method, methods }: { method: string; methods: AznPaymentMethod[] }) {
  const m = methods.find(p => p.id === method);
  if (!m) return <Badge variant="outline" className="font-mono text-[9px]">{method}</Badge>;
  const Icon = m.icon;
  return (
    <Badge variant="outline" className={cn("font-mono text-[9px] gap-1", m.color, m.border)}>
      <Icon className="w-2.5 h-2.5" />{m.label}
    </Badge>
  );
}

// ── USDT Trade: buy button + payment badge (settlement always BDT) ─────────
function UsdtBuyConfirmButton({ onBuy }: { onBuy: (amount: string) => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");

  if (!open) {
    return (
      <Button size="sm" onClick={() => { setAmount(""); setOpen(true); }} className="font-mono text-[10px] gap-1 h-8">
        <ShoppingCart className="w-3 h-3" /> Buy USDT
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="Amount"
        className="font-mono text-xs h-8 w-20"
        type="number"
        autoFocus
      />
      <Button size="sm" onClick={() => { onBuy(amount); setOpen(false); }} className="font-mono text-[10px] h-8">
        <Check className="w-3 h-3" />
      </Button>
      <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function UsdtPaymentBadge({ method }: { method: string }) {
  const m = USDT_PAYMENT_METHODS.find(p => p.id === method);
  if (!m) return <Badge variant="outline" className="font-mono text-[9px]">{method}</Badge>;
  const Icon = m.icon;
  return (
    <Badge variant="outline" className={cn("font-mono text-[9px] gap-1", m.color, m.border)}>
      <Icon className="w-2.5 h-2.5" />{m.label}
    </Badge>
  );
}

type OrderTab = "buy" | "sell";

interface CreateForm {
  amount: string;
  price_per_unit: string;
  payment_method: string;
  payment_details: string;
}

const defaultForm: CreateForm = { amount: "", price_per_unit: "", payment_method: "binance", payment_details: "" };

// ── Account Store (AYZEN-owned inventory, is_official=true listings) ───────
const STORE_CATEGORIES: { id: string; label: string; icon: any }[] = [
  { id: "all",      label: "All",      icon: Store },
  { id: "gmail",    label: "Gmail",    icon: Mail },
  { id: "twitter",  label: "Twitter",  icon: MessageCircle },
  { id: "discord",  label: "Discord",  icon: MessageCircle },
  { id: "github",   label: "GitHub",   icon: Github },
  { id: "facebook", label: "Facebook", icon: Facebook },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "outlook",  label: "Outlook",  icon: Mail },
  { id: "otp",      label: "OTP",      icon: KeyRound },
];

export default function MarketplaceAzn() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { methods: aznMethods, getDetailsMeta: getAznDetailsMeta } = useAznPaymentMethods();
  const [section, setSection] = useState<"azn" | "usdt" | "store">("azn");
  const [tab, setTab] = useState<OrderTab>("buy");
  const [sellListings, setSellListings] = useState<any[]>([]);
  const [buyListings, setBuyListings] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [form, setForm] = useState<CreateForm>(defaultForm);

  // USDT Trade (nested tab, settlement in BDT)
  const [usdtTab, setUsdtTab] = useState<OrderTab>("buy");
  const [usdtSellListings, setUsdtSellListings] = useState<any[]>([]);
  const [usdtBuyListings, setUsdtBuyListings] = useState<any[]>([]);
  const [usdtStats, setUsdtStats] = useState<any>(null);
  const [usdtWallet, setUsdtWallet] = useState<any>(null);
  const [usdtLoading, setUsdtLoading] = useState(true);
  const [usdtShowCreate, setUsdtShowCreate] = useState(false);
  const [usdtCreating, setUsdtCreating] = useState(false);
  const [usdtCancelling, setUsdtCancelling] = useState<number | null>(null);
  const [usdtForm, setUsdtForm] = useState<CreateForm>({ amount: "", price_per_unit: "", payment_method: "bkash", payment_details: "" });

  // Account Store
  const [storeCategory, setStoreCategory] = useState("all");
  const [storeListings, setStoreListings] = useState<any[]>([]);
  const [storeLoading, setStoreLoading] = useState(true);
  const [buyingListingId, setBuyingListingId] = useState<number | null>(null);

  const loadStore = useCallback(async (category: string) => {
    setStoreLoading(true);
    try {
      const params = new URLSearchParams({ official: "true" });
      if (category !== "all") params.set("category", category);
      const r = await api(`/marketplace/vault/listings?${params}`).then(r => r.json());
      setStoreListings(r.listings ?? []);
    } catch { setStoreListings([]); }
    setStoreLoading(false);
  }, []);

  useEffect(() => { if (section === "store") loadStore(storeCategory); }, [section, storeCategory, loadStore]);

  const handleStoreBuy = async (listingId: number) => {
    setBuyingListingId(listingId);
    try {
      const r = await api("/marketplace/vault/buy", { method: "POST", body: JSON.stringify({ listing_id: listingId }) });
      const d = await r.json();
      if (!r.ok) { toast({ variant: "destructive", title: d.error }); }
      else {
        toast({ title: `Purchased: ${d.title}`, description: "Added to your Vault — find it under Vault Market / My Vault." });
        loadStore(storeCategory);
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setBuyingListingId(null);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sell, buy, s, w] = await Promise.all([
        api("/marketplace/azn/listings?order_type=sell").then(r => r.json()),
        api("/marketplace/azn/listings?order_type=buy").then(r => r.json()),
        api("/marketplace/azn/stats").then(r => r.json()),
        api("/marketplace/wallet").then(r => r.json()),
      ]);
      setSellListings(sell.listings ?? []);
      setBuyListings(buy.listings ?? []);
      setStats(s);
      setWallet(w?.azn ?? null);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.amount || !form.price_per_unit) { toast({ title: "Amount and price required" }); return; }
    if (!form.payment_details.trim()) { toast({ title: "Payment details required (account number/ID)" }); return; }
    setCreating(true);
    try {
      const r = await api("/marketplace/azn/listings", {
        method: "POST",
        body: JSON.stringify({
          amount: Number(form.amount),
          price_per_unit: Number(form.price_per_unit),
          order_type: tab,
          payment_method: form.payment_method,
          payment_details: form.payment_details.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ variant: "destructive", title: d.error }); }
      else {
        toast({ title: `${tab === "sell" ? "Sell" : "Buy"} order created!` });
        setShowCreate(false);
        setForm(defaultForm);
        load();
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setCreating(false);
  };

  const handleCancel = async (id: number) => {
    setCancelling(id);
    try {
      await api(`/marketplace/azn/listings/${id}`, { method: "DELETE" });
      toast({ title: "Order cancelled" });
      load();
    } catch { toast({ variant: "destructive", title: "Failed to cancel" }); }
    setCancelling(null);
  };

  // ── USDT Trade ──────────────────────────────────────────────────────────────
  const loadUsdt = useCallback(async () => {
    setUsdtLoading(true);
    try {
      const [sell, buy, s, w] = await Promise.all([
        api("/marketplace/usdt/listings?order_type=sell").then(r => r.json()),
        api("/marketplace/usdt/listings?order_type=buy").then(r => r.json()),
        api("/marketplace/usdt/stats").then(r => r.json()),
        api("/marketplace/wallet").then(r => r.json()),
      ]);
      setUsdtSellListings(sell.listings ?? []);
      setUsdtBuyListings(buy.listings ?? []);
      setUsdtStats(s);
      setUsdtWallet(w?.usdt ?? null);
    } catch { /* silent */ }
    setUsdtLoading(false);
  }, []);

  useEffect(() => { if (section === "usdt") loadUsdt(); }, [section, loadUsdt]);

  const handleUsdtCreate = async () => {
    if (!usdtForm.amount || !usdtForm.price_per_unit) { toast({ title: "Amount and price required" }); return; }
    if (!usdtForm.payment_details.trim()) { toast({ title: "Payment details required (account number/ID)" }); return; }
    setUsdtCreating(true);
    try {
      const r = await api("/marketplace/usdt/listings", {
        method: "POST",
        body: JSON.stringify({
          amount: Number(usdtForm.amount),
          price_per_unit: Number(usdtForm.price_per_unit),
          order_type: usdtTab,
          payment_method: usdtForm.payment_method,
          payment_details: usdtForm.payment_details.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ variant: "destructive", title: d.error }); }
      else {
        toast({ title: `${usdtTab === "sell" ? "Sell" : "Buy"} order created!` });
        setUsdtShowCreate(false);
        setUsdtForm({ amount: "", price_per_unit: "", payment_method: "bkash", payment_details: "" });
        loadUsdt();
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setUsdtCreating(false);
  };

  const handleUsdtCancel = async (id: number) => {
    setUsdtCancelling(id);
    try {
      await api(`/marketplace/usdt/listings/${id}`, { method: "DELETE" });
      toast({ title: "Order cancelled" });
      loadUsdt();
    } catch { toast({ variant: "destructive", title: "Failed to cancel" }); }
    setUsdtCancelling(null);
  };

  const handleUsdtBuy = async (listingId: number, amount: string) => {
    if (!amount || Number(amount) <= 0) { toast({ title: "Enter amount to buy" }); return; }
    try {
      const r = await api("/marketplace/usdt/buy", {
        method: "POST",
        body: JSON.stringify({ listing_id: listingId, amount: Number(amount) }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ variant: "destructive", title: d.error }); }
      else {
        toast({ title: `Bought ${amount} USDT!`, description: `Pay via ${d.payment_method?.toUpperCase()} · ${d.payment_details ?? ""}` });
        loadUsdt();
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
  };

  const usdtListings = usdtTab === "buy" ? usdtSellListings : usdtBuyListings;

  const listings = tab === "buy" ? sellListings : buyListings;
  const myId = user?.id;

  return (
    <div className="space-y-5 page-enter">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow">P2P Market</h1>
            <Badge variant="outline" className="font-mono text-[10px] border-emerald-400/30 text-emerald-400 bg-emerald-400/5">P2P</Badge>
          </div>
          <p className="text-muted-foreground font-mono text-sm">Peer-to-peer AZN exchange · plus AYZEN's own Account Store</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-mono text-xs h-8 gap-1">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </Button>
          <Button onClick={() => { setShowCreate(v => !v); }} size="sm" className="font-mono text-xs gap-1.5 h-8">
            <Plus className="w-3.5 h-3.5" /> Create Order
          </Button>
        </div>
      </div>

      {/* Section switcher: AZN Trade vs USDT Trade vs Account Store */}
      <div className="flex gap-1 bg-muted/20 rounded-lg p-1 w-fit">
        {([
          { id: "azn" as const, label: "AZN Trade", icon: Zap },
          { id: "usdt" as const, label: "USDT Trade", icon: DollarSign },
          { id: "store" as const, label: "Account Store", icon: Store },
        ]).map(s => {
          const Icon = s.icon;
          return (
            <button key={s.id} onClick={() => setSection(s.id)}
              className={cn("flex items-center gap-2 px-4 py-2 text-xs font-mono rounded transition-all",
                section === s.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="w-3.5 h-3.5" />
              <span className="font-bold">{s.label}</span>
            </button>
          );
        })}
      </div>

      {section === "azn" && (
      <>
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Sell Orders", value: stats?.active_sell_listings ?? "—", icon: TrendingDown, color: "text-primary" },
          { label: "Buy Orders", value: stats?.active_buy_listings ?? "—", icon: TrendingUp, color: "text-emerald-400" },
          { label: "AZN Available", value: stats?.available_azn?.toLocaleString() ?? "—", icon: Zap, color: "text-amber-400" },
          { label: "My Balance", value: `${wallet?.balance?.toFixed(0) ?? "0"} AZN`, icon: Wallet, color: "text-violet-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3 flex items-center gap-3">
            <div className={cn("w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center flex-shrink-0", s.color)}>
              <s.icon className="w-4 h-4" />
            </div>
            <div>
              <div className={cn("font-mono text-base font-bold", s.color)}>
                {loading ? <Skeleton className="h-5 w-14" /> : s.value}
              </div>
              <div className="font-mono text-[9px] text-muted-foreground">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-muted/20 rounded-lg p-1 w-fit">
        {([
          { id: "buy" as OrderTab, label: "Buy AZN", sublabel: "Browse sell orders", icon: ShoppingCart },
          { id: "sell" as OrderTab, label: "Sell AZN", sublabel: "Browse buy requests", icon: Tag },
        ] as const).map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("flex items-center gap-2 px-4 py-2 text-xs font-mono rounded transition-all",
                tab === t.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="w-3.5 h-3.5" />
              <div className="text-left">
                <div className="font-bold">{t.label}</div>
                <div className="text-[9px] opacity-60">{t.sublabel}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Create Order Panel */}
      {showCreate && (
        <div className="bg-card border border-primary/30 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-primary font-bold flex items-center gap-2">
              <Tag className="w-3.5 h-3.5" />
              Create {tab === "sell" ? "Sell" : "Buy"} Order
            </h3>
            <button onClick={() => setShowCreate(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <SchemaForm
              fields={AZN_ORDER_FIELDS}
              form={form}
              onChange={(key, value) => setForm(p => ({ ...p, [key]: value }))}
            />
          </div>

          {/* Payment Method Pills */}
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-2 uppercase tracking-wider">
              Payment Method *
            </label>
            <div className="flex gap-2 flex-wrap">
              {aznMethods.map(m => {
                const Icon = m.icon;
                const selected = form.payment_method === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setForm(p => ({ ...p, payment_method: m.id }))}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs transition-all",
                      selected ? `${m.bg} ${m.border} ${m.color}` : "border-border/40 text-muted-foreground hover:border-border"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {m.label}
                    {selected && <Check className="w-3 h-3 ml-0.5" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Payment Details */}
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">
              {getAznDetailsMeta(form.payment_method).label} *
            </label>
            <Input
              value={form.payment_details}
              onChange={e => setForm(p => ({ ...p, payment_details: e.target.value }))}
              placeholder={getAznDetailsMeta(form.payment_method).placeholder}
              className="font-mono text-sm"
            />
          </div>

          {form.amount && form.price_per_unit && (
            <div className="bg-muted/20 rounded-lg p-3 font-mono text-[11px] text-muted-foreground flex items-center gap-4">
              <span>Total: <span className="text-primary font-bold">{(Number(form.amount) * Number(form.price_per_unit)).toFixed(4)} AZN</span></span>
              <span>·</span>
              <span>{tab === "sell" ? "AZN will be locked until sold" : "Buy request will be visible to sellers"}</span>
            </div>
          )}

          <Button onClick={handleCreate} disabled={creating} className="w-full font-mono text-xs">
            {creating ? "Creating..." : `Create ${tab === "sell" ? "Sell" : "Buy"} Order`}
          </Button>
        </div>
      )}

      {/* Listings */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {tab === "buy" ? "Available Sell Orders" : "Active Buy Requests"}
          </h2>
          <span className="font-mono text-[10px] text-muted-foreground/50">{listings.length} orders</span>
        </div>

        {loading ? (
          <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
        ) : listings.length === 0 ? (
          <div className="text-center py-16 bg-card border border-border/30 rounded-xl">
            <Zap className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
            <p className="font-mono text-sm text-muted-foreground">No orders available</p>
            <p className="font-mono text-[11px] text-muted-foreground/50 mt-1">
              {tab === "buy" ? "No one is selling AZN right now" : "No buy requests posted yet"}
            </p>
            <Button size="sm" className="mt-4 font-mono text-xs gap-1.5" onClick={() => setShowCreate(true)}>
              <Plus className="w-3.5 h-3.5" /> Create {tab === "sell" ? "Sell" : "Buy"} Order
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {listings.map(l => {
              const isMine = l.seller_id === myId;
              return (
                <div
                  key={l.id}
                  className={cn(
                    "bg-card border rounded-xl p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between transition-all",
                    isMine ? "border-primary/20" : "border-card-border hover:border-primary/30"
                  )}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                      <Zap className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono font-bold text-sm flex items-center gap-2 flex-wrap">
                        {Number(l.amount).toLocaleString()} AZN
                        {isMine && <Badge variant="outline" className="text-[8px] border-primary/30 text-primary/70">MINE</Badge>}
                        <PaymentBadge method={l.payment_method ?? "binance"} methods={aznMethods} />
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-3 flex-wrap">
                        <span className="text-primary font-bold">{Number(l.price_per_unit).toFixed(4)} AZN/unit</span>
                        <span>· by {l.seller_username}</span>
                        <span>· {new Date(l.created_at).toLocaleDateString()}</span>
                      </div>
                      {isMine && l.payment_details && (
                        <div className="mt-1 font-mono text-[9px] bg-muted/30 rounded px-2 py-0.5 inline-flex items-center gap-1 text-muted-foreground">
                          <BarChart3 className="w-2.5 h-2.5" /> {l.payment_details}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {isMine ? (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => handleCancel(l.id)}
                        disabled={cancelling === l.id}
                        className="font-mono text-[10px] border-red-500/20 text-red-400 hover:bg-red-500/10 h-8"
                      >
                        <X className="w-3 h-3 mr-1" />
                        {cancelling === l.id ? "..." : "Cancel"}
                      </Button>
                    ) : (
                      <div className="text-right">
                        <div className="font-mono text-[10px] text-muted-foreground mb-1">
                          Payment: <span className="text-foreground">{l.payment_details || "Contact seller"}</span>
                        </div>
                        {tab === "buy" ? (
                          <BuyConfirmButton listing={l} onSuccess={load} toast={toast} />
                        ) : (
                          <Button size="sm" className="font-mono text-[10px] gap-1 h-8">
                            <ShoppingCart className="w-3 h-3" /> Fulfill Order
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      {section === "usdt" && (
      <>
      {/* USDT Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Sell Orders", value: usdtStats?.active_sell_listings ?? "—", icon: TrendingDown, color: "text-primary" },
          { label: "Buy Orders", value: usdtStats?.active_buy_listings ?? "—", icon: TrendingUp, color: "text-emerald-400" },
          { label: "USDT Available", value: usdtStats?.available_usdt?.toLocaleString() ?? "—", icon: DollarSign, color: "text-amber-400" },
          { label: "My Balance", value: `${usdtWallet?.balance?.toFixed(2) ?? "0"} USDT`, icon: Wallet, color: "text-violet-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3 flex items-center gap-3">
            <div className={cn("w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center flex-shrink-0", s.color)}>
              <s.icon className="w-4 h-4" />
            </div>
            <div>
              <div className={cn("font-mono text-base font-bold", s.color)}>
                {usdtLoading ? <Skeleton className="h-5 w-14" /> : s.value}
              </div>
              <div className="font-mono text-[9px] text-muted-foreground">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* USDT Tab switcher (buy/sell) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-muted/20 rounded-lg p-1 w-fit">
          {([
            { id: "buy" as OrderTab, label: "Buy USDT", sublabel: "Browse sell orders", icon: ShoppingCart },
            { id: "sell" as OrderTab, label: "Sell USDT", sublabel: "Browse buy requests", icon: Tag },
          ] as const).map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setUsdtTab(t.id)}
                className={cn("flex items-center gap-2 px-4 py-2 text-xs font-mono rounded transition-all",
                  usdtTab === t.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
                <Icon className="w-3.5 h-3.5" />
                <div className="text-left">
                  <div className="font-bold">{t.label}</div>
                  <div className="text-[9px] opacity-60">{t.sublabel}</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadUsdt} disabled={usdtLoading} className="font-mono text-xs h-8 gap-1">
            <RefreshCw className={cn("w-3.5 h-3.5", usdtLoading && "animate-spin")} />
          </Button>
          <Button onClick={() => setUsdtShowCreate(v => !v)} size="sm" className="font-mono text-xs gap-1.5 h-8">
            <Plus className="w-3.5 h-3.5" /> Create Order
          </Button>
        </div>
      </div>

      {/* USDT Create Order Panel */}
      {usdtShowCreate && (
        <div className="bg-card border border-primary/30 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-primary font-bold flex items-center gap-2">
              <Tag className="w-3.5 h-3.5" />
              Create {usdtTab === "sell" ? "Sell" : "Buy"} Order
            </h3>
            <button onClick={() => setUsdtShowCreate(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <SchemaForm
              fields={USDT_ORDER_FIELDS}
              form={usdtForm}
              onChange={(key, value) => setUsdtForm(p => ({ ...p, [key]: value }))}
            />
          </div>

          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-2 uppercase tracking-wider">
              Payment Method * (BDT settlement)
            </label>
            <div className="flex gap-2 flex-wrap">
              {USDT_PAYMENT_METHODS.map(m => {
                const Icon = m.icon;
                const selected = usdtForm.payment_method === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setUsdtForm(p => ({ ...p, payment_method: m.id }))}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs transition-all",
                      selected ? `${m.bg} ${m.border} ${m.color}` : "border-border/40 text-muted-foreground hover:border-border"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {m.label}
                    {selected && <Check className="w-3 h-3 ml-0.5" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">
              {getUsdtPaymentDetailsMeta(usdtForm.payment_method).label} *
            </label>
            <Input
              value={usdtForm.payment_details}
              onChange={e => setUsdtForm(p => ({ ...p, payment_details: e.target.value }))}
              placeholder={getUsdtPaymentDetailsMeta(usdtForm.payment_method).placeholder}
              className="font-mono text-sm"
            />
          </div>

          {usdtForm.amount && usdtForm.price_per_unit && (
            <div className="bg-muted/20 rounded-lg p-3 font-mono text-[11px] text-muted-foreground flex items-center gap-4">
              <span>Total: <span className="text-primary font-bold">{(Number(usdtForm.amount) * Number(usdtForm.price_per_unit)).toFixed(2)} BDT</span></span>
              <span>·</span>
              <span>{usdtTab === "sell" ? "USDT will be locked until sold" : "Buy request will be visible to sellers"}</span>
            </div>
          )}

          <Button onClick={handleUsdtCreate} disabled={usdtCreating} className="w-full font-mono text-xs">
            {usdtCreating ? "Creating..." : `Create ${usdtTab === "sell" ? "Sell" : "Buy"} Order`}
          </Button>
        </div>
      )}

      {/* USDT Listings */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {usdtTab === "buy" ? "Available Sell Orders" : "Active Buy Requests"}
          </h2>
          <span className="font-mono text-[10px] text-muted-foreground/50">{usdtListings.length} orders</span>
        </div>

        {usdtLoading ? (
          <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
        ) : usdtListings.length === 0 ? (
          <div className="text-center py-16 bg-card border border-border/30 rounded-xl">
            <DollarSign className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
            <p className="font-mono text-sm text-muted-foreground">No orders available</p>
            <p className="font-mono text-[11px] text-muted-foreground/50 mt-1">
              {usdtTab === "buy" ? "No one is selling USDT right now" : "No buy requests posted yet"}
            </p>
            <Button size="sm" className="mt-4 font-mono text-xs gap-1.5" onClick={() => setUsdtShowCreate(true)}>
              <Plus className="w-3.5 h-3.5" /> Create {usdtTab === "sell" ? "Sell" : "Buy"} Order
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {usdtListings.map(l => {
              const isMine = l.seller_id === myId;
              return (
                <div
                  key={l.id}
                  className={cn(
                    "bg-card border rounded-xl p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between transition-all",
                    isMine ? "border-primary/20" : "border-card-border hover:border-primary/30"
                  )}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                      <DollarSign className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono font-bold text-sm flex items-center gap-2 flex-wrap">
                        {Number(l.amount).toLocaleString()} USDT
                        {isMine && <Badge variant="outline" className="text-[8px] border-primary/30 text-primary/70">MINE</Badge>}
                        <UsdtPaymentBadge method={l.payment_method ?? "bkash"} />
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-3 flex-wrap">
                        <span className="text-primary font-bold">{Number(l.price_per_unit).toFixed(2)} BDT/unit</span>
                        <span>· by {l.seller_username}</span>
                        <span>· {new Date(l.created_at).toLocaleDateString()}</span>
                      </div>
                      {isMine && l.payment_details && (
                        <div className="mt-1 font-mono text-[9px] bg-muted/30 rounded px-2 py-0.5 inline-flex items-center gap-1 text-muted-foreground">
                          <BarChart3 className="w-2.5 h-2.5" /> {l.payment_details}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {isMine ? (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => handleUsdtCancel(l.id)}
                        disabled={usdtCancelling === l.id}
                        className="font-mono text-[10px] border-red-500/20 text-red-400 hover:bg-red-500/10 h-8"
                      >
                        <X className="w-3 h-3 mr-1" />
                        {usdtCancelling === l.id ? "..." : "Cancel"}
                      </Button>
                    ) : (
                      <div className="text-right">
                        <div className="font-mono text-[10px] text-muted-foreground mb-1">
                          Pay: <span className="text-foreground">{l.payment_details || "Contact seller"}</span>
                        </div>
                        {usdtTab === "buy" ? (
                          <UsdtBuyConfirmButton onBuy={(amount) => handleUsdtBuy(l.id, amount)} />
                        ) : (
                          <Button size="sm" className="font-mono text-[10px] gap-1 h-8">
                            <ShoppingCart className="w-3 h-3" /> Fulfill Order
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      {section === "store" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <p className="font-mono text-[11px] text-muted-foreground">
              These accounts are sold directly by AYZEN (not other users). Once purchased, the account is
              transferred straight into your own Vault — find it under Vault Market / My Vault afterwards.
            </p>
          </div>

          {/* Category filter */}
          <div className="flex gap-2 flex-wrap">
            {STORE_CATEGORIES.map(c => {
              const Icon = c.icon;
              const selected = storeCategory === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setStoreCategory(c.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono text-xs transition-all",
                    selected ? "bg-primary/15 border-primary/40 text-primary" : "border-border/40 text-muted-foreground hover:border-border"
                  )}
                >
                  <Icon className="w-3.5 h-3.5" /> {c.label}
                </button>
              );
            })}
          </div>

          {storeLoading ? (
            <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
          ) : storeListings.length === 0 ? (
            <div className="text-center py-16 bg-card border border-border/30 rounded-xl">
              <Store className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
              <p className="font-mono text-sm text-muted-foreground">No accounts in stock right now</p>
              <p className="font-mono text-[11px] text-muted-foreground/50 mt-1">Check back later, or try a different category.</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {storeListings.map(l => (
                <div key={l.id} className="bg-card border border-card-border rounded-xl p-4 flex flex-col gap-3 hover:border-primary/30 transition-all">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="font-mono text-[9px] uppercase border-primary/30 text-primary">{l.category}</Badge>
                    <Badge variant="outline" className="font-mono text-[9px] uppercase border-emerald-400/30 text-emerald-400">Official</Badge>
                  </div>
                  <p className="font-mono text-sm font-bold">{l.title}</p>
                  {l.description && <p className="font-mono text-[11px] text-muted-foreground line-clamp-2">{l.description}</p>}
                  <div className="flex items-center justify-between mt-auto pt-2">
                    <span className="font-mono text-sm font-bold text-primary">{Number(l.price).toFixed(2)} AZN</span>
                    <Button
                      size="sm"
                      onClick={() => handleStoreBuy(l.id)}
                      disabled={buyingListingId === l.id}
                      className="font-mono text-[10px] gap-1 h-8"
                    >
                      <ShoppingCart className="w-3 h-3" /> {buyingListingId === l.id ? "..." : "Buy"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
