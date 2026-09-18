import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ArrowDownToLine, ArrowUpFromLine,
  Copy, Check, RefreshCw, TrendingUp, History,
  Wallet, BarChart3, ArrowRight, Zap, Image, Vault, Gamepad2,
} from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { MARKETPLACE_HUB_CONFIG } from "@/config/marketplace";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts?.headers ?? {}) } });

// Market card config (label/icon/color/href per wallet) now lives in
// @/config/marketplace.ts as MARKETPLACE_HUB_CONFIG. Adding a market
// wallet card is one entry there.
const MARKET_CONFIG = MARKETPLACE_HUB_CONFIG;

export default function MarketplaceWalletHub() {
  const { toast } = useToast();
  const [wallets, setWallets] = useState<Record<string, any>>({});
  const [transactions, setTransactions] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [txLoading, setTxLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<{ type: "deposit" | "withdraw"; market: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [processing, setProcessing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [txFilter, setTxFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [w, s] = await Promise.all([
        api("/marketplace/wallet").then(r => r.json()),
        api("/marketplace/wallet/summary").then(r => r.json()),
      ]);
      setWallets(w);
      setSummary(s);
    } catch {}
    setLoading(false);
  }, []);

  const loadTx = useCallback(async () => {
    setTxLoading(true);
    try {
      const params = txFilter !== "all" ? `?market_type=${txFilter}` : "";
      const r = await api(`/marketplace/wallet/transactions${params}`).then(r => r.json());
      setTransactions(Array.isArray(r) ? r : []);
    } catch {}
    setTxLoading(false);
  }, [txFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTx(); }, [loadTx]);

  const handleAction = async () => {
    if (!activeAction || !amount || Number(amount) <= 0) { toast({ title: "Enter valid amount" }); return; }
    setProcessing(true);
    try {
      const path = `/marketplace/wallet/${activeAction.market}/${activeAction.type}`;
      const r = await api(path, { method: "POST", body: JSON.stringify({ amount: Number(amount) }) });
      const d = await r.json();
      if (!r.ok) toast({ variant: "destructive", title: d.error });
      else {
        toast({ title: `${activeAction.type === "deposit" ? "Deposited" : "Withdrawn"} ${amount} AZN` });
        setAmount(""); setActiveAction(null); load();
      }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setProcessing(false);
  };

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 2000);
  };

  const total = summary?.total_balance ?? 0;
  const pieData = Object.entries(MARKET_CONFIG).map(([k, cfg]) => ({
    name: cfg.label,
    value: Number(wallets[k]?.balance ?? 0),
    color: cfg.color,
  })).filter(d => d.value > 0);

  const MARKET_TX_ICONS: Record<string, React.ElementType> = { azn: Zap, nft: Image, vault: Vault, game: Gamepad2 };

  return (
    <div className="space-y-6 page-enter">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Market Wallet</h1>
          </div>
          <p className="text-muted-foreground font-mono text-sm">3 independent marketplace wallets · Deposit & withdraw anytime</p>
        </div>
        <Button variant="outline" onClick={() => { load(); loadTx(); }} className="font-mono text-xs gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Portfolio overview */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2 bg-card border border-card-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-4 h-4 text-primary" />
            <span className="font-mono text-xs uppercase tracking-widest text-primary font-bold">Total Portfolio</span>
          </div>
          <div className="text-4xl font-bold font-mono text-foreground mb-1">
            {loading ? <Skeleton className="h-10 w-40" /> : <>{total.toLocaleString()}<span className="text-xl text-muted-foreground"> AZN</span></>}
          </div>
          <div className="text-xs font-mono text-muted-foreground mb-4">≈ ${(total * 0.01).toFixed(2)} USD</div>
          <div className="flex items-center gap-4 text-[11px] font-mono">
            <div><span className="text-muted-foreground">Earned: </span><span className="text-emerald-400">{summary?.total_earned?.toFixed(2) ?? "0"} AZN</span></div>
            <div><span className="text-muted-foreground">Trades: </span><span className="text-primary">{Object.values(summary?.trades ?? {}).reduce((a: any, b: any) => a + b, 0) as number}</span></div>
          </div>
        </div>
        <div className="bg-card border border-card-border rounded-xl p-5 flex flex-col items-center justify-center">
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" strokeWidth={0}>
                    {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#0a0a0a", border: "1px solid #1f2937", fontFamily: "monospace", fontSize: 10 }} formatter={(v: any) => [`${Number(v).toFixed(0)} AZN`, ""]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-3 mt-2">
                {pieData.map(d => (
                  <div key={d.name} className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                    <span className="font-mono text-[9px] text-muted-foreground">{d.name.split(" ")[0]}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-center text-muted-foreground/40 font-mono text-xs">Deposit to see portfolio breakdown</div>
          )}
        </div>
      </div>

      {/* 3 Wallet Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        {Object.entries(MARKET_CONFIG).map(([type, cfg]) => {
          const w = wallets[type];
          const Icon = cfg.icon;
          return (
            <div key={type} className={cn("bg-card border rounded-xl overflow-hidden", cfg.border)}>
              <div className={cn("px-4 py-3 border-b flex items-center justify-between", cfg.bg, cfg.border)}>
                <div className="flex items-center gap-2">
                  <Icon className={cn("w-4 h-4", cfg.accent)} />
                  <span className={cn("font-mono text-xs font-bold uppercase tracking-wider", cfg.accent)}>{cfg.label}</span>
                </div>
                <Badge variant="outline" className={cn("font-mono text-[8px]", cfg.accent, cfg.border)}>WALLET</Badge>
              </div>
              <div className="p-4 space-y-3">
                {loading ? <Skeleton className="h-10 w-full" /> : (
                  <>
                    <div>
                      <div className={cn("text-2xl font-bold font-mono", cfg.accent)}>{Number(w?.balance ?? 0).toLocaleString()} <span className="text-sm text-muted-foreground">AZN</span></div>
                      <div className="text-[10px] font-mono text-muted-foreground/60">Available: {Number(w?.available ?? 0).toFixed(2)} · Locked: {Number(w?.locked_balance ?? 0).toFixed(2)}</div>
                    </div>
                    <div className="flex items-center gap-1 bg-muted/20 rounded px-2 py-1.5">
                      <span className="font-mono text-[9px] text-muted-foreground/50 flex-1 truncate">{w?.address ?? "Loading..."}</span>
                      <button onClick={() => copyAddr(w?.address ?? "")} className="text-muted-foreground/40 hover:text-primary">
                        {copied === w?.address ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button size="sm" variant="outline" onClick={() => { setActiveAction({ type: "deposit", market: type }); setAmount(""); }} className={cn("font-mono text-[9px] h-7 gap-1", cfg.border, cfg.accent)}>
                        <ArrowDownToLine className="w-3 h-3" /> Deposit
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setActiveAction({ type: "withdraw", market: type }); setAmount(""); }} className="font-mono text-[9px] h-7 gap-1 border-border/40 text-muted-foreground">
                        <ArrowUpFromLine className="w-3 h-3" /> Withdraw
                      </Button>
                    </div>
                    <a href={cfg.href}>
                      <Button size="sm" className={cn("w-full font-mono text-[9px] h-7 gap-1 border-0 text-white", type === "azn" ? "bg-primary hover:bg-primary/90" : type === "nft" ? "bg-violet-600 hover:bg-violet-700" : "bg-amber-600 hover:bg-amber-700")}>
                        <ArrowRight className="w-3 h-3" /> Go to Market
                      </Button>
                    </a>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Deposit/Withdraw action panel */}
      {activeAction && (
        <div className="bg-card border border-primary/30 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-widest text-primary font-bold flex items-center gap-2">
              {activeAction.type === "deposit" ? <ArrowDownToLine className="w-3.5 h-3.5" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />}
              {activeAction.type === "deposit" ? "Deposit to" : "Withdraw from"} {MARKET_CONFIG[activeAction.market as keyof typeof MARKET_CONFIG].label}
            </h3>
            <button onClick={() => setActiveAction(null)}><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          <div className="font-mono text-[10px] text-muted-foreground/60">
            {activeAction.type === "deposit"
              ? "Transfers AZN from your main wallet balance to the marketplace wallet."
              : "Returns AZN from marketplace wallet back to your main AZN balance."}
          </div>
          <div className="flex gap-3">
            <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount (AZN)" className="font-mono text-sm flex-1" />
            <Button onClick={handleAction} disabled={processing} className="font-mono text-xs min-w-24">
              {processing ? "..." : activeAction.type === "deposit" ? "Deposit" : "Withdraw"}
            </Button>
          </div>
        </div>
      )}

      {/* Transaction history */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Transaction History</h2>
          <div className="flex gap-1">
            {["all", "azn", "nft", "vault", "game"].map(f => (
              <button key={f} onClick={() => setTxFilter(f)} className={cn("px-2 py-1 rounded text-[9px] font-mono uppercase tracking-wider border transition-all", txFilter === f ? "bg-primary/15 text-primary border-primary/30" : "text-muted-foreground border-border/30")}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {txLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        ) : transactions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground/40 font-mono text-xs">No transactions yet</div>
        ) : (
          <div className="space-y-2">
            {transactions.map(tx => {
              const Icon = MARKET_TX_ICONS[tx.market_type] ?? Wallet;
              const cfg = MARKET_CONFIG[tx.market_type as keyof typeof MARKET_CONFIG];
              return (
                <div key={tx.id} className="bg-card border border-card-border rounded-lg px-4 py-3 flex items-center gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", cfg?.bg ?? "bg-muted/20")}>
                    <Icon className={cn("w-3.5 h-3.5", cfg?.accent ?? "text-muted-foreground")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs font-bold">{tx.market_type.toUpperCase()} #{tx.listing_id}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/60">{tx.buyer_username} → {tx.seller_username} · {new Date(tx.created_at).toLocaleString()}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm font-bold text-primary">{Number(tx.amount).toFixed(2)} AZN</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50">fee: {Number(tx.fee).toFixed(2)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function X({ className }: { className?: string }) {
  return <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>;
}
