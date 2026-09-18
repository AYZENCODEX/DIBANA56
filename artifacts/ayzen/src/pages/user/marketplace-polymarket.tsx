// Season 1 / Phase 2 — Polymarket page.
// Wired to the real backend (artifacts/api-server/src/routes/polymarket.ts):
// real markets (Gamma API), a real on-chain USDC balance for the user's own
// Polygon wallet, and REAL money orders signed by that wallet. There is no
// paper-trading mode here — every buy/sell places a live order.
import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearch, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  LineChart, Wallet, BarChart3, Bot, TrendingUp, TrendingDown,
  History, Sparkles, Clock, Loader2, RefreshCw, Search, ShieldAlert,
} from "lucide-react";

import { POLYMARKET_STATUS_COLOR } from "@/config/marketplace";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type PolyTab = "wallet" | "overview" | "ai-agent" | "market" | "order-history";

const TABS: { id: PolyTab; label: string; icon: React.ElementType }[] = [
  { id: "overview",     label: "Overview",      icon: BarChart3 },
  { id: "market",       label: "Market",        icon: LineChart },
  { id: "wallet",       label: "Wallet",        icon: Wallet },
  { id: "ai-agent",     label: "AI Agent",      icon: Bot },
  { id: "order-history",label: "Order History", icon: History },
];

const STATUS_COLOR = POLYMARKET_STATUS_COLOR;

interface WalletOption { id: number; label: string; address: string; chain: string }
interface GammaMarket {
  id: string;
  question: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  volume?: string | number;
  endDate?: string;
}
interface Trade {
  id: number;
  marketId: string;
  marketQuestion: string | null;
  outcome: string;
  price: number;
  sizeUsdc: number;
  status: string;
  createdAt: string;
}

function parsePrices(m: GammaMarket): { yes: number | null; no: number | null } {
  try {
    const p = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
    return { yes: p?.[0] != null ? parseFloat(p[0]) : null, no: p?.[1] != null ? parseFloat(p[1]) : null };
  } catch { return { yes: null, no: null }; }
}
function parseTokenIds(m: GammaMarket): { yes: string | null; no: string | null } {
  try {
    const ids = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : null;
    return { yes: ids?.[0] ?? null, no: ids?.[1] ?? null };
  } catch { return { yes: null, no: null }; }
}

export default function MarketplacePolymarket() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const rawSearch = useSearch();
  const tabParam = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch).get("tab") as PolyTab | null;
  const activeTab: PolyTab = TABS.some(t => t.id === tabParam) ? (tabParam as PolyTab) : "overview";

  const token = localStorage.getItem("ayzen_token") ?? "";
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);

  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [walletId, setWalletId] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  const [search, setSearch] = useState("");
  const [markets, setMarkets] = useState<GammaMarket[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(true);

  const [trades, setTrades] = useState<Trade[]>([]);

  const [tradeOpen, setTradeOpen] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState<GammaMarket | null>(null);
  const [selectedOutcome, setSelectedOutcome] = useState<"YES" | "NO">("YES");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadWallets = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/wallets`, { headers: authHeaders });
      const data = await res.json();
      const list: WalletOption[] = (data.wallets ?? data ?? []);
      const matic = list.filter(w => (w.chain ?? "").toUpperCase() === "MATIC");
      setWallets(matic);
      setWalletId(prev => prev ?? matic[0]?.id ?? null);
    } catch { /* non-fatal */ }
  }, [authHeaders]);

  const loadBalance = useCallback(async (id: number) => {
    setLoadingBalance(true);
    try {
      const res = await fetch(`${BASE}/api/polymarket/balance?walletId=${id}`, { headers: authHeaders });
      const data = await res.json();
      setBalance(res.ok ? data.balance : null);
    } catch { setBalance(null); } finally { setLoadingBalance(false); }
  }, [authHeaders]);

  const loadMarkets = useCallback(async (q?: string) => {
    setLoadingMarkets(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (q) params.set("search", q);
      const res = await fetch(`${BASE}/api/polymarket/markets?${params}`, { headers: authHeaders });
      const data = await res.json();
      setMarkets(res.ok ? (data.markets ?? []) : []);
      if (!res.ok) toast({ variant: "destructive", title: data.error ?? "Failed to load markets" });
    } catch {
      setMarkets([]);
    } finally { setLoadingMarkets(false); }
  }, [authHeaders, toast]);

  const loadTrades = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/polymarket/trades`, { headers: authHeaders });
      const data = await res.json();
      setTrades(res.ok ? (data.trades ?? []) : []);
    } catch { setTrades([]); }
  }, [authHeaders]);

  useEffect(() => { loadWallets(); loadMarkets(); loadTrades(); }, [loadWallets, loadMarkets, loadTrades]);
  useEffect(() => { if (walletId !== null) loadBalance(walletId); }, [walletId, loadBalance]);

  function openTrade(market: GammaMarket, outcome: "YES" | "NO") {
    if (!walletId) {
      toast({ variant: "destructive", title: "No Polygon wallet", description: "Create one in Wallet Hub first." });
      return;
    }
    const { yes, no } = parsePrices(market);
    const suggested = outcome === "YES" ? yes : no;
    setSelectedMarket(market);
    setSelectedOutcome(outcome);
    setPrice(suggested != null ? suggested.toFixed(2) : "");
    setSize("");
    setTradeOpen(true);
  }

  async function submitTrade() {
    if (!selectedMarket || !walletId) return;
    const priceNum = parseFloat(price);
    const sizeNum = parseFloat(size);
    if (!priceNum || priceNum <= 0 || priceNum >= 1) {
      toast({ variant: "destructive", title: "Invalid price", description: "Must be between 0.01 and 0.99" });
      return;
    }
    if (!sizeNum || sizeNum <= 0) {
      toast({ variant: "destructive", title: "Invalid size", description: "Enter a USDC amount greater than 0" });
      return;
    }
    const { yes, no } = parseTokenIds(selectedMarket);
    const tokenId = selectedOutcome === "YES" ? yes : no;
    if (!tokenId) {
      toast({ variant: "destructive", title: "Market unavailable", description: "Could not resolve a CLOB token id" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE}/api/polymarket/trade`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          walletId, marketId: selectedMarket.id, marketQuestion: selectedMarket.question,
          tokenId, outcome: selectedOutcome, price: priceNum, sizeUsdc: sizeNum, confirm: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ variant: "destructive", title: "Order failed", description: data.error ?? "Unknown error" });
      } else {
        toast({ title: "Order submitted", description: `${selectedOutcome} @ $${priceNum} · $${sizeNum} USDC` });
        setTradeOpen(false);
        loadTrades();
        loadBalance(walletId);
      }
    } catch (err: any) {
      toast({ variant: "destructive", title: "Order failed", description: err?.message ?? "Network error" });
    } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase text-glow flex items-center gap-2">
            <LineChart className="w-6 h-6 text-primary" /> Polymarket
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-0.5">
            Real prediction markets — orders are signed and funded by your own wallet, live
          </p>
        </div>
        {wallets.length > 0 && (
          <select
            className="bg-background border rounded-md px-2 py-1.5 text-xs font-mono uppercase"
            value={walletId ?? ""}
            onChange={(e) => setWalletId(parseInt(e.target.value, 10))}
          >
            {wallets.map(w => (
              <option key={w.id} value={w.id}>{w.label} · {w.address.slice(0, 6)}…{w.address.slice(-4)}</option>
            ))}
          </select>
        )}
      </div>

      <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <p className="font-mono text-[11px] text-amber-200/80">
          This page places REAL orders funded by your own on-chain wallet. There is no paper-trading
          mode here. Double-check price and size before confirming — orders can't be recalled once submitted.
        </p>
      </div>

      {/* Section is now selected from the main sidebar's Polymarket ▸
          Overview/Market/Wallet/AI Agent/Order History — this page just
          renders whichever ?tab= is active, no in-page nav needed. */}
      <div className="space-y-4">
      {activeTab === "overview" && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Open Trades", value: trades.filter(t => t.status === "submitted").length, icon: BarChart3, color: "text-primary" },
            { label: "Failed Orders", value: trades.filter(t => t.status === "failed").length, icon: TrendingDown, color: "text-red-400" },
            { label: "Total Trades", value: trades.length, icon: LineChart, color: "text-violet-400" },
            { label: "Wallet Balance", value: balance != null ? `$${balance.toFixed(2)}` : "—", icon: TrendingUp, color: "text-amber-400" },
          ].map(card => (
            <div key={card.label} className="bg-card border border-card-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50">{card.label}</span>
                <card.icon className={cn("w-4 h-4", card.color)} />
              </div>
              <div className={cn("text-xl font-bold font-mono", card.color)}>{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {activeTab === "market" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search markets…" className="pl-9 font-mono text-sm"
                value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") loadMarkets(search); }}
              />
            </div>
            <Button variant="outline" onClick={() => loadMarkets(search)} disabled={loadingMarkets}>
              {loadingMarkets ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {markets.map(m => {
              const { yes } = parsePrices(m);
              return (
                <div key={m.id} className="bg-card border border-card-border rounded-lg p-4 hover:border-primary/30 transition-all card-lift">
                  <p className="text-sm font-mono font-medium mb-3 leading-snug">{m.question}</p>
                  <div className="flex items-center justify-between text-xs font-mono mb-3">
                    <span className="text-muted-foreground">Volume: <span className="text-foreground">${Number(m.volume ?? 0).toLocaleString()}</span></span>
                    {m.endDate && <span className="flex items-center gap-1 text-muted-foreground"><Clock className="w-3 h-3" /> ends {new Date(m.endDate).toLocaleDateString()}</span>}
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-emerald-400/60 to-emerald-400 rounded-full" style={{ width: `${(yes ?? 0) * 100}%` }} />
                    </div>
                    <span className="font-mono text-xs font-bold text-emerald-400">{yes != null ? Math.round(yes * 100) : "—"}%</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1 font-mono uppercase text-[10px] border-emerald-400/30 text-emerald-400" onClick={() => openTrade(m, "YES")}>Yes</Button>
                    <Button size="sm" variant="outline" className="flex-1 font-mono uppercase text-[10px] border-red-400/30 text-red-400" onClick={() => openTrade(m, "NO")}>No</Button>
                  </div>
                </div>
              );
            })}
            {!loadingMarkets && markets.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground col-span-2">No markets found.</p>
            )}
          </div>
        </div>
      )}

      {activeTab === "wallet" && (
        <div className="max-w-md space-y-4">
          <div className="bg-card border border-card-border rounded-lg p-5">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 mb-1">On-chain USDC Balance</div>
            <div className="text-3xl font-bold font-mono text-primary">
              {loadingBalance ? <Loader2 className="w-6 h-6 animate-spin" /> : balance != null ? `$${balance.toFixed(2)}` : "—"}
            </div>
            <div className="text-xs font-mono text-muted-foreground mt-1">
              {wallets.length > 0 ? "This is your real Polygon wallet's live USDC balance." : "No Polygon wallet yet — create one in Wallet Hub."}
            </div>
            <div className="flex gap-2 mt-4">
              <Button variant="outline" className="flex-1 font-mono uppercase text-xs" onClick={() => setLocation("/wallet")}>
                Manage in Wallet Hub
              </Button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "ai-agent" && (
        <div className="max-w-lg bg-card border border-card-border rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 font-mono font-bold text-sm">
              <Bot className="w-4 h-4 text-violet-400" /> AI Trading Agent
            </span>
            <Badge variant="outline" className="font-mono text-[9px] uppercase border-violet-400/30 text-violet-400">Preview</Badge>
          </div>
          <p className="text-xs font-mono text-muted-foreground leading-relaxed">
            This panel will let you configure an automated agent to trade prediction markets on your behalf based on
            rules you set. Not connected to any model or execution engine yet — this is a layout preview only.
          </p>
          <Button disabled variant="outline" className="w-full font-mono uppercase text-xs cursor-not-allowed opacity-60">
            <Sparkles className="w-3.5 h-3.5 mr-1.5" /> Configure Agent (coming soon)
          </Button>
        </div>
      )}

      {activeTab === "order-history" && (
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-card-border hover:bg-transparent">
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground/60">Market</TableHead>
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground/60">Side</TableHead>
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground/60">Size</TableHead>
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground/60">Price</TableHead>
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground/60">Status</TableHead>
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground/60">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map(o => (
                <TableRow key={o.id} className="border-card-border">
                  <TableCell className="font-mono text-xs">{o.marketQuestion ?? o.marketId}</TableCell>
                  <TableCell className={cn("font-mono text-xs font-bold", o.outcome === "YES" ? "text-emerald-400" : "text-red-400")}>{o.outcome}</TableCell>
                  <TableCell className="font-mono text-xs">{o.sizeUsdc}</TableCell>
                  <TableCell className="font-mono text-xs">{o.price.toFixed(2)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("font-mono text-[9px] uppercase", STATUS_COLOR[o.status])}>{o.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{new Date(o.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
              {trades.length === 0 && (
                <TableRow><TableCell colSpan={6} className="font-mono text-xs text-muted-foreground text-center py-6">No trades yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      </div>

      <Dialog open={tradeOpen} onOpenChange={setTradeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono uppercase text-sm">
              <Wallet className="w-4 h-4" /> Confirm real order
            </DialogTitle>
          </DialogHeader>
          {selectedMarket && (
            <div className="space-y-4">
              <p className="text-sm font-mono leading-snug">{selectedMarket.question}</p>
              <Badge variant="outline" className={selectedOutcome === "YES" ? "text-emerald-400 border-emerald-400/30" : "text-red-400 border-red-400/30"}>
                {selectedOutcome}
              </Badge>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="pm-price" className="font-mono text-xs">Price (0.01–0.99)</Label>
                  <Input id="pm-price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.62" />
                </div>
                <div>
                  <Label htmlFor="pm-size" className="font-mono text-xs">Size (USDC)</Label>
                  <Input id="pm-size" value={size} onChange={(e) => setSize(e.target.value)} placeholder="10" />
                </div>
              </div>
              <p className="font-mono text-[11px] text-amber-400/80 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" /> This places a real GTC order funded by your own wallet.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTradeOpen(false)}>Cancel</Button>
            <Button onClick={submitTrade} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirm real order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
