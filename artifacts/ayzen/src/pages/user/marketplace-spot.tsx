import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  TrendingUp, TrendingDown, X, Lock, Sparkles, RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts?.headers ?? {}) } });

const PAIR = "AZN/USDT";

export default function SpotTradePage() {
  const { toast } = useToast();
  const [ticker, setTicker] = useState<any>(null);
  const [book, setBook] = useState<{ bids: any[]; asks: any[] }>({ bids: [], asks: [] });
  const [trades, setTrades] = useState<any[]>([]);
  const [candles, setCandles] = useState<any[]>([]);
  const [balances, setBalances] = useState<any>(null);
  const [myOrders, setMyOrders] = useState<any[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    try {
      const [t, ob, tr, cd, bal, ord] = await Promise.all([
        api("/spot/pairs").then(r => r.json()),
        api(`/spot/orderbook/${encodeURIComponent(PAIR)}`).then(r => r.json()),
        api(`/spot/trades/${encodeURIComponent(PAIR)}`).then(r => r.json()),
        api(`/spot/candles/${encodeURIComponent(PAIR)}?interval=1h&limit=48`).then(r => r.json()),
        api("/spot/balances").then(r => r.json()),
        api("/spot/orders?status=open").then(r => r.json()),
      ]);
      setTicker(Array.isArray(t) ? t[0] : null);
      setBook(ob);
      setTrades(Array.isArray(tr) ? tr : []);
      setCandles(Array.isArray(cd) ? cd : []);
      setBalances(bal);
      setMyOrders(Array.isArray(ord) ? ord : []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); const iv = setInterval(loadAll, 6000); return () => clearInterval(iv); }, [loadAll]);

  const lastPrice = ticker?.last_price ?? 0;
  const changePct = ticker?.change_24h_pct ?? 0;

  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;

  useEffect(() => {
    if (orderType === "limit" && !price && lastPrice) setPrice(String(lastPrice));
  }, [lastPrice, orderType]); // eslint-disable-line

  const estTotal = useMemo(() => {
    const p = orderType === "market" ? (side === "buy" ? bestAsk : bestBid) ?? lastPrice : Number(price);
    return (Number(qty) || 0) * (p || 0);
  }, [price, qty, orderType, side, bestAsk, bestBid, lastPrice]);

  const placeOrder = async () => {
    if (!qty || Number(qty) <= 0) { toast({ variant: "destructive", title: "Enter a valid quantity" }); return; }
    if (orderType === "limit" && (!price || Number(price) <= 0)) { toast({ variant: "destructive", title: "Enter a valid price" }); return; }
    setSubmitting(true);
    try {
      const r = await api("/spot/orders", {
        method: "POST",
        body: JSON.stringify({ pair: PAIR, side, order_type: orderType, price: Number(price) || undefined, qty: Number(qty) }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ variant: "destructive", title: d.error }); }
      else {
        toast({ title: `${side === "buy" ? "Buy" : "Sell"} order placed`, description: d.fills?.length ? `Filled ${d.fills.length} trade(s)` : "Resting on the order book" });
        setQty("");
        loadAll();
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setSubmitting(false);
  };

  const cancelOrder = async (id: number) => {
    const r = await api(`/spot/orders/${id}`, { method: "DELETE" });
    if (r.ok) { toast({ title: "Order cancelled" }); loadAll(); }
  };

  const maxQty = () => {
    if (!balances) return;
    if (side === "buy") {
      const p = orderType === "market" ? (bestAsk ?? lastPrice) : Number(price) || lastPrice;
      const avail = balances.usdt.balance - balances.usdt.locked;
      if (p > 0) setQty((avail / p).toFixed(4));
    } else {
      const avail = balances.azn.balance - balances.azn.locked;
      setQty(avail.toFixed(4));
    }
  };

  return (
    <div className="space-y-6 page-enter">
      {/* Header / ticker */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Spot Trading</h1>
            <Badge variant="outline" className="font-mono text-[9px]">{PAIR}</Badge>
          </div>
          <p className="text-muted-foreground font-mono text-sm">Live order book · matched instantly against other traders</p>
        </div>
        <div className="flex items-center gap-4">
          {loading ? <Skeleton className="h-10 w-32" /> : (
            <div className="text-right">
              <div className={cn("text-2xl font-bold font-mono", changePct >= 0 ? "text-emerald-400" : "text-red-400")}>
                {lastPrice.toFixed(4)} <span className="text-sm text-muted-foreground">USDT</span>
              </div>
              <div className={cn("text-xs font-mono flex items-center gap-1 justify-end", changePct >= 0 ? "text-emerald-400" : "text-red-400")}>
                {changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}% (24h)
              </div>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={loadAll} className="font-mono text-xs gap-2">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-card border border-card-border rounded-xl p-4">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={candles}>
            <defs>
              <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
            <XAxis dataKey="time" tick={{ fontSize: 9, fontFamily: "monospace" }} tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit" })} stroke="#4b5563" />
            <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fontFamily: "monospace" }} stroke="#4b5563" width={60} />
            <Tooltip contentStyle={{ background: "#0a0a0a", border: "1px solid #1f2937", fontFamily: "monospace", fontSize: 10 }} labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v: any) => [Number(v).toFixed(4), "close"]} />
            <Area type="monotone" dataKey="close" stroke="#22d3ee" fill="url(#priceGrad)" strokeWidth={1.5} />
          </AreaChart>
        </ResponsiveContainer>
        {candles.length === 0 && !loading && (
          <div className="text-center text-muted-foreground/40 font-mono text-xs -mt-8">No trades yet — place the first order to seed the chart</div>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Order book */}
        <div className="bg-card border border-card-border rounded-xl p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Order Book</div>
          <div className="grid grid-cols-2 gap-1 text-[9px] font-mono text-muted-foreground/60 mb-1">
            <span>Price (USDT)</span><span className="text-right">Qty (AZN)</span>
          </div>
          <div className="space-y-0.5 mb-2">
            {book.asks.slice(0, 8).reverse().map((a, i) => (
              <div key={i} className="grid grid-cols-2 text-[11px] font-mono relative">
                <div className="absolute inset-0 bg-red-500/10" style={{ width: `${Math.min(100, a.qty * 3)}%` }} />
                <span className="text-red-400 relative z-10">{a.price.toFixed(4)}</span>
                <span className="text-right relative z-10">{a.qty.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="text-center font-mono text-sm font-bold py-1 border-y border-border/30 mb-2">
            {lastPrice.toFixed(4)} <span className="text-[9px] text-muted-foreground">USDT</span>
          </div>
          <div className="space-y-0.5">
            {book.bids.slice(0, 8).map((b, i) => (
              <div key={i} className="grid grid-cols-2 text-[11px] font-mono relative">
                <div className="absolute inset-0 bg-emerald-500/10" style={{ width: `${Math.min(100, b.qty * 3)}%` }} />
                <span className="text-emerald-400 relative z-10">{b.price.toFixed(4)}</span>
                <span className="text-right relative z-10">{b.qty.toFixed(2)}</span>
              </div>
            ))}
          </div>
          {book.asks.length === 0 && book.bids.length === 0 && (
            <div className="text-center text-muted-foreground/40 font-mono text-xs py-6">Order book is empty</div>
          )}
        </div>

        {/* Buy/Sell panel */}
        <div className="bg-card border border-card-border rounded-xl p-4">
          <Tabs value={side} onValueChange={(v) => setSide(v as any)}>
            <TabsList className="grid grid-cols-2 w-full mb-3">
              <TabsTrigger value="buy" className="font-mono text-xs data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400">Buy</TabsTrigger>
              <TabsTrigger value="sell" className="font-mono text-xs data-[state=active]:bg-red-500/20 data-[state=active]:text-red-400">Sell</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex gap-1 mb-3">
            {(["limit", "market"] as const).map(t => (
              <button key={t} onClick={() => setOrderType(t)} className={cn("px-2 py-1 rounded text-[9px] font-mono uppercase tracking-wider border flex-1", orderType === t ? "bg-primary/15 text-primary border-primary/30" : "text-muted-foreground border-border/30")}>
                {t}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {orderType === "limit" && (
              <div>
                <label className="text-[9px] font-mono text-muted-foreground/60">Price (USDT)</label>
                <Input value={price} onChange={e => setPrice(e.target.value)} className="font-mono text-sm" />
              </div>
            )}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[9px] font-mono text-muted-foreground/60">Amount (AZN)</label>
                <button onClick={maxQty} className="text-[9px] font-mono text-primary">MAX</button>
              </div>
              <Input value={qty} onChange={e => setQty(e.target.value)} className="font-mono text-sm" />
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/60 flex justify-between">
              <span>Est. total</span><span>{estTotal.toFixed(4)} USDT</span>
            </div>
            {balances && (
              <div className="text-[9px] font-mono text-muted-foreground/50 flex justify-between">
                <span>Avail. USDT: {(balances.usdt.balance - balances.usdt.locked).toFixed(4)}</span>
                <span>Avail. AZN: {(balances.azn.balance - balances.azn.locked).toFixed(2)}</span>
              </div>
            )}
            <Button onClick={placeOrder} disabled={submitting} className={cn("w-full font-mono text-xs", side === "buy" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700")}>
              {submitting ? "..." : `${side === "buy" ? "Buy" : "Sell"} AZN`}
            </Button>
          </div>
        </div>

        {/* Recent trades */}
        <div className="bg-card border border-card-border rounded-xl p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Recent Trades</div>
          <div className="grid grid-cols-3 text-[9px] font-mono text-muted-foreground/60 mb-1">
            <span>Price</span><span className="text-right">Qty</span><span className="text-right">Time</span>
          </div>
          <div className="space-y-0.5 max-h-64 overflow-y-auto">
            {trades.map(t => (
              <div key={t.id} className="grid grid-cols-3 text-[10px] font-mono">
                <span className="text-primary">{t.price.toFixed(4)}</span>
                <span className="text-right">{t.qty.toFixed(2)}</span>
                <span className="text-right text-muted-foreground/50">{new Date(t.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
            {trades.length === 0 && <div className="text-center text-muted-foreground/40 font-mono text-xs py-6">No trades yet</div>}
          </div>
        </div>
      </div>

      {/* My open orders */}
      <div>
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-3">Open Orders</h2>
        {myOrders.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground/40 font-mono text-xs border border-dashed border-border/30 rounded-lg">No open orders</div>
        ) : (
          <div className="space-y-2">
            {myOrders.map(o => (
              <div key={o.id} className="bg-card border border-card-border rounded-lg px-4 py-3 flex items-center gap-3">
                <Badge variant="outline" className={cn("font-mono text-[9px]", o.side === "buy" ? "text-emerald-400 border-emerald-500/30" : "text-red-400 border-red-500/30")}>
                  {o.side.toUpperCase()}
                </Badge>
                <div className="flex-1 min-w-0 font-mono text-xs">
                  {o.order_type} · {(o.qty - o.filled_qty).toFixed(2)} AZN @ {o.price.toFixed(4)} USDT
                </div>
                <button onClick={() => cancelOrder(o.id)} className="text-muted-foreground/40 hover:text-red-400">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Staking teaser */}
      <div className="bg-card border border-amber-500/20 rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span className="font-mono text-xs text-amber-400">Earn passive yield on idle AZN/USDT</span>
        </div>
        <a href="/marketplace/staking">
          <Button size="sm" variant="outline" className="font-mono text-[10px] gap-1 border-amber-500/30 text-amber-400">
            <Lock className="w-3 h-3" /> Open Staking
          </Button>
        </a>
      </div>
    </div>
  );
}
