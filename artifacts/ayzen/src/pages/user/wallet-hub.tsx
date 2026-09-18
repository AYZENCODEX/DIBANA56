import { useState, useEffect, useCallback, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Wallet, Send, ArrowUpRight, ArrowDownLeft, ArrowLeftRight, RefreshCw,
  Loader2, Copy, Check, Eye, EyeOff, ChevronDown,
  History, Plus, AlertCircle, User, Gem, ShieldAlert, Link2, Radio, Clock, CheckCircle2,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { WALLET_CURRENCY_CONFIG, WALLET_CHAINS, getChainInfo } from "@/config/wallet";
import { useSSEEvent } from "@/hooks/use-realtime";

// The vault wallet's real-time deposit watcher (services/deposit-watcher.ts)
// covers these five networks — same custodial address on every one of them.
const VAULT_CHAIN_VALUES = ["ETH", "BSC", "MATIC", "PLASMA", "ARB"] as const;

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Balances {
  azn: number;
  usdt: number;
  xp: number;
  bdt: number;
  credits: number;
}

interface Transfer {
  id: number;
  from_user_id: number;
  to_user_id: number;
  currency: string;
  amount: number;
  note: string | null;
  created_at: string;
  from_username: string | null;
  to_username: string | null;
}

interface Deposit {
  id: number;
  chain: string;
  token_symbol: string;
  amount: number;
  tx_hash: string;
  status: "pending" | "confirmed";
  confirmations: number;
  created_at: string;
  confirmed_at: string | null;
}

// Slow/medium/fast fee tiers for one chain — GET /api/wallets/gas-price.
// Mirrors GasPriceEstimate / GasFeeTier in api-server/src/lib/gas-health.ts.
type GasSpeed = "slow" | "medium" | "fast";
interface GasFeeTier {
  speed: GasSpeed;
  gasPriceGwei: number;
  maxPriorityFeePerGasGwei?: number;
  estimatedNativeCost: number;
  estimatedUsdCost: number;
}
interface GasPriceEstimate {
  chain: string;
  nativeSymbol: string;
  isEip1559: boolean;
  tiers: GasFeeTier[];
  updatedAt: string;
}

// Currency display config (label/colors/icon/emoji) lives in
// @/config/wallet.ts as WALLET_CURRENCY_CONFIG. Adding an internal ledger
// currency is one entry there.
const CURRENCY_CONFIG = WALLET_CURRENCY_CONFIG;
const HERO_CURRENCIES = ["USDT", "AZN", "XP", "BDT"] as const;

export default function WalletHub() {
  const { toast } = useToast();
  const token = localStorage.getItem("ayzen_token") ?? "";

  const [balances, setBalances] = useState<Balances>({ azn: 0, usdt: 0, xp: 0, bdt: 0, credits: 0 });
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [hideBalance, setHideBalance] = useState(false);

  // Built-in wallet address
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<number | null>(null);
  const [walletChain, setWalletChain] = useState<string>("ETH");
  const [onChain, setOnChain] = useState<{ balance: number; balanceUsd: number } | null>(null);
  const [syncingChain, setSyncingChain] = useState(false);
  const [creatingWallet, setCreatingWallet] = useState(false);

  // Shown exactly once right after generation — the user must back this up.
  const [revealMnemonic, setRevealMnemonic] = useState<string | null>(null);
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);

  // Add Funds (receive / deposit) dialog
  const [addFundsOpen, setAddFundsOpen] = useState(false);
  const [depositChain, setDepositChain] = useState<string>("ETH");
  const [deposits, setDeposits] = useState<Deposit[]>([]);

  // Withdraw form (real on-chain send from the built-in wallet) — mapped to
  // the "Transfer" action (moving value out to an external address).
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawChain, setWithdrawChain] = useState<string>("ETH");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  // Network fee (gas) preview + speed selection for the withdrawal above.
  // "medium" with no advanced fields = old behavior (signer/provider default).
  const [gasEstimate, setGasEstimate] = useState<GasPriceEstimate | null>(null);
  const [gasLoading, setGasLoading] = useState(false);
  const [withdrawSpeed, setWithdrawSpeed] = useState<GasSpeed>("medium");
  const [advancedGasOpen, setAdvancedGasOpen] = useState(false);
  const [advGasPriceGwei, setAdvGasPriceGwei] = useState("");
  const [advMaxFeeGwei, setAdvMaxFeeGwei] = useState("");
  const [advPriorityGwei, setAdvPriorityGwei] = useState("");

  // Send dialog (internal user-to-user transfer)
  const [sendOpen, setSendOpen] = useState(false);
  const [currency, setCurrency] = useState("USDT");
  const [toUser, setToUser] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  // Assets tab filter chips
  const [assetFilter, setAssetFilter] = useState<"all" | "internal" | "onchain">("all");
  const [mainTab, setMainTab] = useState<"assets" | "account">("assets");

  // Current user id from token
  const [myUserId, setMyUserId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [balRes, txRes, walRes, meRes, depRes] = await Promise.all([
        fetch(`${BASE}/api/wallets/ayzen-balance`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BASE}/api/wallets/transfers`,     { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BASE}/api/wallets`,               { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BASE}/api/auth/me`,               { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BASE}/api/wallets/deposits`,      { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (balRes.ok) setBalances(await balRes.json());
      if (txRes.ok) setTransfers(await txRes.json());
      if (walRes.ok) {
        const wallets = await walRes.json();
        const builtin = wallets.find((w: any) => w.label?.includes("Built-in") || w.label?.includes("AYZEN Built-in"));
        setWalletAddress(builtin?.address ?? null);
        setWalletId(builtin?.id ?? null);
        setWalletChain(builtin?.chain ?? "ETH");
        if (builtin) setOnChain({ balance: builtin.balance ?? 0, balanceUsd: builtin.balanceUsd ?? 0 });
      }
      if (meRes.ok) {
        const me = await meRes.json();
        setMyUserId(me?.id ?? null);
      }
      if (depRes.ok) setDeposits(await depRes.json());
    } catch {
      toast({ variant: "destructive", title: "Failed to load wallet data" });
    }
    setLoading(false);
  }, [token]);

  const loadDeposits = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/wallets/deposits`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setDeposits(await res.json());
    } catch { /* SSE will retry on the next event anyway */ }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // ── Real-time vault deposits (ETH/BSC/Polygon/Plasma/Arbitrum) ───────────
  // "detected" fires the instant a tx is seen on-chain (still pending
  // confirmations); "confirmed" fires once it crosses the chain's
  // confirmation threshold and the balance has actually been credited.
  useSSEEvent("deposit_detected", (data: any) => {
    toast({ title: "Deposit detected 👀", description: `${data.amount} ${data.symbol} incoming on ${data.chain} — waiting for confirmations.` });
    loadDeposits();
  }, [loadDeposits]);

  useSSEEvent("deposit_confirmed", (data: any) => {
    toast({ title: "Deposit confirmed ✓", description: `${data.amount} ${data.symbol} credited (${data.chain}).` });
    loadDeposits();
    load();
  }, [loadDeposits, load]);

  const createBuiltinWallet = async () => {
    setCreatingWallet(true);
    try {
      const res = await fetch(`${BASE}/api/wallets/builtin/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      if (res.ok) {
        setWalletAddress(d.address);
        setWalletId(d.id);
        setWalletChain(d.chain ?? "ETH");
        // Shown once — the API never returns this again.
        if (d.mnemonic) { setRevealMnemonic(d.mnemonic); setMnemonicConfirmed(false); }
        toast({ title: "Wallet generated ✓", description: "Back up your recovery phrase before doing anything else." });
      } else {
        toast({ variant: "destructive", title: d.error ?? "Failed to create wallet" });
        await load();
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setCreatingWallet(false);
  };

  const syncOnChainBalance = async () => {
    if (!walletId) return;
    setSyncingChain(true);
    try {
      const res = await fetch(`${BASE}/api/wallets/${walletId}/sync`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      if (res.ok) {
        setOnChain({ balance: d.balance ?? 0, balanceUsd: d.balanceUsd ?? 0 });
        toast({ title: "Balance synced" });
      } else toast({ variant: "destructive", title: d.error ?? "Sync failed" });
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSyncingChain(false);
  };

  // Live slow/medium/fast fee preview for the network currently selected in
  // the withdraw dialog. Refetched whenever that network changes while the
  // dialog is open; the dialog's own Advanced fields don't need this call.
  const fetchGasEstimate = useCallback(async (chain: string) => {
    setGasLoading(true);
    try {
      const res = await fetch(`${BASE}/api/wallets/gas-price?chain=${chain}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      setGasEstimate(res.ok ? d : null);
    } catch {
      setGasEstimate(null);
    }
    setGasLoading(false);
  }, [token]);

  useEffect(() => {
    if (!withdrawOpen) return;
    fetchGasEstimate(withdrawChain);
  }, [withdrawOpen, withdrawChain, fetchGasEstimate]);

  const activeTier = gasEstimate?.tiers.find(t => t.speed === withdrawSpeed) ?? null;

  const handleWithdrawOnChain = async () => {
    if (!walletId) return;
    if (!withdrawTo.trim()) { toast({ variant: "destructive", title: "Enter a destination address" }); return; }
    if (!withdrawAmount || parseFloat(withdrawAmount) <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }

    // Advanced gwei fields (if the user opened Advanced and typed a value)
    // always win over the slow/medium/fast tier pick.
    const advGasPrice = advancedGasOpen && advGasPriceGwei.trim() ? parseFloat(advGasPriceGwei) : undefined;
    const advMaxFee = advancedGasOpen && advMaxFeeGwei.trim() ? parseFloat(advMaxFeeGwei) : undefined;
    const advPriority = advancedGasOpen && advPriorityGwei.trim() ? parseFloat(advPriorityGwei) : undefined;
    const hasAdvanced = advGasPrice != null || advMaxFee != null || advPriority != null;
    if (advancedGasOpen && hasAdvanced && [advGasPrice, advMaxFee, advPriority].some(v => v != null && (!Number.isFinite(v) || v <= 0))) {
      toast({ variant: "destructive", title: "Gwei value must be a positive number" }); return;
    }

    setWithdrawing(true);
    try {
      const res = await fetch(`${BASE}/api/wallets/${walletId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to: withdrawTo.trim(), amount: parseFloat(withdrawAmount), chain: withdrawChain,
          ...(hasAdvanced
            ? { gasPriceGwei: advGasPrice, maxFeePerGasGwei: advMaxFee, maxPriorityFeePerGasGwei: advPriority }
            : { speed: withdrawSpeed }),
        }),
      });
      const d = await res.json();
      if (res.ok) {
        toast({ title: "Withdrawal broadcast ✓", description: `${withdrawChain} · Tx: ${d.txHash?.slice(0, 10)}…` });
        setWithdrawTo(""); setWithdrawAmount(""); setWithdrawOpen(false);
        setWithdrawSpeed("medium"); setAdvancedGasOpen(false);
        setAdvGasPriceGwei(""); setAdvMaxFeeGwei(""); setAdvPriorityGwei("");
        await syncOnChainBalance();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Withdrawal failed" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setWithdrawing(false);
  };

  const copyAddress = async () => {
    if (!walletAddress) return;
    await navigator.clipboard.writeText(walletAddress);
    setCopying(true);
    setTimeout(() => setCopying(false), 1500);
    toast({ title: "Copied!", description: "Wallet address copied to clipboard." });
  };

  const handleSend = async () => {
    if (!toUser.trim()) { toast({ variant: "destructive", title: "Enter recipient username or email" }); return; }
    if (!amount || parseFloat(amount) <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }
    setSending(true);
    try {
      const res = await fetch(`${BASE}/api/wallets/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ toUsername: toUser.trim(), currency, amount: parseFloat(amount), note: note.trim() || undefined }),
      });
      const d = await res.json();
      if (res.ok) {
        toast({ title: `${currency} Sent ✓`, description: `${amount} ${currency} → ${d.to}` });
        setToUser(""); setAmount(""); setNote(""); setSendOpen(false);
        await load();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Transfer failed" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSending(false);
  };

  const selectedBalance = {
    AZN: balances.azn, USDT: balances.usdt, XP: balances.xp, BDT: balances.bdt,
  }[currency] ?? 0;

  const isInsufficient = amount && parseFloat(amount) > selectedBalance;

  const heroAmount = selectedBalance;
  const cycleHeroCurrency = () => {
    const i = HERO_CURRENCIES.indexOf(currency as any);
    setCurrency(HERO_CURRENCIES[(i + 1) % HERO_CURRENCIES.length]);
  };

  const openSend = (cur?: string) => { if (cur) setCurrency(cur); setSendOpen(true); };

  const internalAssets = useMemo(
    () => ["USDT", "AZN", "XP", "BDT"].map(cur => ({ cur, amount: (balances as any)[cur.toLowerCase()] ?? 0, cfg: CURRENCY_CONFIG[cur] })),
    [balances]
  );

  const showInternal = assetFilter === "all" || assetFilter === "internal";
  const showOnchain = assetFilter === "all" || assetFilter === "onchain";

  return (
    <div className="space-y-5 page-enter">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Wallet className="w-6 h-6 text-primary" /> My Wallet
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">AYZEN built-in wallet · internal ledger + on-chain</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/nft-marketplace">
            <Button variant="outline" className="font-mono text-xs gap-2 border-primary/30 text-primary hover:bg-primary/10">
              <Gem className="w-3.5 h-3.5" /> NFT Market
            </Button>
          </Link>
          <Button onClick={load} disabled={loading} className="font-mono text-xs gap-2">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      {/* ── Hero: Est. Balance card ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-card-border bg-card elevation-2 p-6">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">Est. Balance</span>
          <button onClick={() => setHideBalance(v => !v)} className="text-muted-foreground/50 hover:text-primary transition-colors">
            {hideBalance ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>

        {loading ? (
          <div className="skeleton h-10 w-48 mt-2" />
        ) : (
          <button onClick={cycleHeroCurrency} className="flex items-baseline gap-2 mt-1 group">
            <span className="figure-lg text-4xl">
              {hideBalance ? "••••••" : heroAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </span>
            <span className={cn("font-mono text-sm font-bold flex items-center gap-0.5", CURRENCY_CONFIG[currency]?.color)}>
              {currency} <ChevronDown className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100" />
            </span>
          </button>
        )}

        {onChain && (
          <p className="font-mono text-[10px] text-muted-foreground/50 mt-1.5">
            On-chain ({walletChain}): {hideBalance ? "••••" : onChain.balance.toFixed(6)} {onChain.balanceUsd > 0 && !hideBalance && `(~$${onChain.balanceUsd.toFixed(2)})`}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2.5 mt-5">
          <Button onClick={() => setAddFundsOpen(true)} className="font-mono text-xs h-10 gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Funds
          </Button>
          <Button variant="secondary" onClick={() => openSend()} className="font-mono text-xs h-10 gap-1.5">
            <Send className="w-3.5 h-3.5" /> Send
          </Button>
          <Button
            variant="secondary"
            onClick={() => walletId ? setWithdrawOpen(true) : toast({ variant: "destructive", title: "Generate a wallet first", description: "Use Add Funds to create your on-chain wallet." })}
            className="font-mono text-xs h-10 gap-1.5"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" /> Transfer
          </Button>
        </div>
      </div>

      {/* ── Assets / Account tabs ───────────────────────────────────────── */}
      <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as any)}>
        <TabsList>
          <TabsTrigger value="assets" className="font-mono text-xs">Assets</TabsTrigger>
          <TabsTrigger value="account" className="font-mono text-xs">Account</TabsTrigger>
        </TabsList>

        {/* Assets tab */}
        <TabsContent value="assets" className="space-y-3 mt-4">
          <div className="flex items-center gap-2 flex-wrap">
            {([
              ["all", "All"],
              ["internal", "Internal"],
              ["onchain", "On-chain"],
            ] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setAssetFilter(val)}
                className={cn(
                  "px-3 py-1 rounded-full font-mono text-[10px] uppercase tracking-wider border transition-all",
                  assetFilter === val ? "bg-primary/10 text-primary border-primary/40" : "border-border/40 text-muted-foreground/60 hover:border-primary/30"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-16" />)}
            </div>
          ) : (
            <div className="divide-y divide-border/30 rounded-xl border border-card-border bg-card overflow-hidden">
              {showInternal && internalAssets.map(({ cur, amount: amt, cfg }) => (
                <div key={cur} className="flex items-center gap-3 px-4 py-3.5">
                  <div className={cn("w-10 h-10 rounded-full border flex items-center justify-center flex-shrink-0 text-base", cfg.bg, cfg.border)}>
                    {cfg.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-bold">{cur}</div>
                    <div className="font-mono text-[10px] text-muted-foreground/60">{cfg.desc}</div>
                  </div>
                  <div className="text-right mr-2">
                    <div className="figure-sm text-sm text-foreground">
                      {hideBalance ? "••••" : amt.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => openSend(cur)} className="font-mono text-[10px] h-7 px-2.5 gap-1">
                    <Send className="w-3 h-3" /> Send
                  </Button>
                </div>
              ))}

              {showOnchain && (
                walletAddress ? (
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <div className="w-10 h-10 rounded-full border flex items-center justify-center flex-shrink-0"
                      style={{ borderColor: "#22d3ee40", background: "#22d3ee15" }}>
                      <Link2 className="w-4 h-4" style={{ color: "#22d3ee" }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm font-bold">{walletChain}</span>
                        <Badge className="font-mono text-[9px] uppercase px-1.5 py-0 bg-primary/10 text-primary border-primary/20">custodial</Badge>
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground/60 truncate">{walletAddress}</div>
                    </div>
                    <div className="text-right mr-2">
                      <div className="figure-sm text-sm text-foreground">
                        {hideBalance ? "••••" : (onChain?.balance ?? 0).toFixed(6)}
                      </div>
                      {onChain && onChain.balanceUsd > 0 && !hideBalance && (
                        <div className="font-mono text-[9px] text-muted-foreground/50">~${onChain.balanceUsd.toFixed(2)}</div>
                      )}
                    </div>
                    <Button size="sm" variant="outline" onClick={syncOnChainBalance} disabled={syncingChain} className="font-mono text-[10px] h-7 px-2.5 gap-1">
                      <RefreshCw className={cn("w-3 h-3", syncingChain && "animate-spin")} /> Sync
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 px-4 py-4">
                    <div>
                      <p className="font-mono text-xs text-muted-foreground/70">No on-chain wallet yet</p>
                      <p className="font-mono text-[10px] text-muted-foreground/40 mt-0.5">Generate a real address to deposit external crypto</p>
                    </div>
                    <Button size="sm" onClick={createBuiltinWallet} disabled={creatingWallet} className="font-mono text-xs gap-1.5">
                      {creatingWallet ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      {creatingWallet ? "Generating..." : "Generate"}
                    </Button>
                  </div>
                )
              )}
            </div>
          )}
        </TabsContent>

        {/* Account tab */}
        <TabsContent value="account" className="space-y-4 mt-4">
          {/* Wallet address card */}
          {walletAddress ? (
            <div className="bg-card border border-primary/30 rounded-lg overflow-hidden elevation-2">
              <div className="px-4 py-4 flex items-center gap-3 flex-wrap">
                <div className="w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0"
                  style={{ borderColor: "#22d3ee40", background: "#22d3ee15" }}>
                  <div className="w-3 h-3 rounded-full" style={{ background: "#22d3ee" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-sm text-foreground">AYZEN Built-in Wallet</span>
                    <Badge className="font-mono text-[9px] uppercase px-1.5 py-0 bg-primary/10 text-primary border-primary/20">
                      {walletChain} · custodial
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-mono text-xs text-muted-foreground truncate">{walletAddress}</span>
                    <button onClick={copyAddress} className="text-muted-foreground hover:text-primary transition-colors shrink-0">
                      {copying ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button size="sm" variant="outline" onClick={syncOnChainBalance} disabled={syncingChain} className="font-mono text-xs gap-1.5">
                    <RefreshCw className={cn("w-3.5 h-3.5", syncingChain && "animate-spin")} /> Sync
                  </Button>
                  <Button size="sm" onClick={() => setWithdrawOpen(true)} className="font-mono text-xs gap-1.5">
                    <ArrowUpRight className="w-3.5 h-3.5" /> Withdraw
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-card border border-card-border rounded-lg px-4 py-3 flex items-center justify-between">
              <div>
                <p className="font-mono text-xs text-muted-foreground/70">No wallet yet</p>
                <p className="font-mono text-[10px] text-muted-foreground/40 mt-0.5">Generate your real AYZEN wallet — address + recovery phrase</p>
              </div>
              <Button size="sm" onClick={createBuiltinWallet} disabled={creatingWallet} className="font-mono text-xs gap-2">
                {creatingWallet ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {creatingWallet ? "Generating..." : "Generate Wallet"}
              </Button>
            </div>
          )}

          {/* Transfer History */}
          <div className="rounded-xl border border-card-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs uppercase tracking-widest text-primary font-bold">Transfer History</span>
            </div>

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-14" />)}
              </div>
            ) : transfers.length === 0 ? (
              <div className="empty-state">
                <History className="empty-state-icon" />
                <p className="empty-state-title">No transfers yet</p>
                <p className="empty-state-subtitle">Send tokens to see history here</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {transfers.map(tx => {
                  const isOut = tx.from_user_id === myUserId;
                  const other = isOut ? (tx.to_username ?? `User #${tx.to_user_id}`) : (tx.from_username ?? `User #${tx.from_user_id}`);
                  const cfg = CURRENCY_CONFIG[tx.currency] ?? { color: "text-muted-foreground", label: tx.currency };
                  return (
                    <div key={tx.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/20 border border-border/30 hover:border-border/60 transition-colors">
                      <div className={cn(
                        "w-8 h-8 rounded-full border flex items-center justify-center flex-shrink-0",
                        isOut ? "border-danger/30 bg-danger-muted" : "border-success/30 bg-success-muted"
                      )}>
                        {isOut
                          ? <ArrowUpRight className="w-3.5 h-3.5 text-danger" />
                          : <ArrowDownLeft className="w-3.5 h-3.5 text-success" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">{isOut ? "TO" : "FROM"}</span>
                          <span className="font-mono text-xs font-medium truncate">{other}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {tx.note && <span className="font-mono text-[9px] text-muted-foreground/50 truncate">{tx.note}</span>}
                          <span className="font-mono text-[9px] text-muted-foreground/30">
                            {new Date(tx.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className={cn("font-mono text-sm font-bold", isOut ? "text-red-400" : "text-emerald-400")}>
                          {isOut ? "-" : "+"}{tx.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </div>
                        <div className={cn("font-mono text-[9px]", (cfg as any).color)}>{tx.currency}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Add Funds (receive / deposit) dialog ───────────────────────── */}
      <Dialog open={addFundsOpen} onOpenChange={setAddFundsOpen}>
        <DialogContent className="font-mono">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" /> Add Funds
            </DialogTitle>
            <DialogDescription>Deposit to your AYZEN vault wallet, or ask a teammate to Send you internal balance.</DialogDescription>
          </DialogHeader>
          {walletAddress ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Network</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {VAULT_CHAIN_VALUES.map(c => {
                    const info = getChainInfo(c);
                    const active = depositChain === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setDepositChain(c)}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full font-mono text-[10px] uppercase tracking-wider border transition-all font-bold",
                          active ? "border-primary bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border"
                        )}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: info.color }} />
                        {info.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg bg-muted/20 border border-border/40 p-3 space-y-1.5">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Your {getChainInfo(depositChain).label} deposit address
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs break-all">{walletAddress}</span>
                  <button onClick={copyAddress} className="text-muted-foreground hover:text-primary transition-colors shrink-0">
                    {copying ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
                <Radio className="w-3 h-3 text-emerald-400 shrink-0" />
                This address works on all 5 networks above. Deposits are picked up automatically in real time — no manual sync needed.
              </p>

              {deposits.length > 0 && (
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Recent deposits</span>
                  {deposits.slice(0, 8).map(d => (
                    <div key={d.id} className="flex items-center justify-between rounded-md bg-muted/10 border border-border/30 px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {d.status === "confirmed"
                          ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                          : <Clock className="w-3 h-3 text-amber-400 shrink-0 animate-pulse" />}
                        <span className="text-[11px]">{d.amount} {d.token_symbol}</span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{d.chain}</Badge>
                      </div>
                      <span className="text-[9px] text-muted-foreground/60">
                        {d.status === "confirmed" ? "Credited" : `${d.confirmations} conf.`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <Button onClick={syncOnChainBalance} disabled={syncingChain} variant="outline" className="w-full font-mono text-xs gap-1.5">
                <RefreshCw className={cn("w-3.5 h-3.5", syncingChain && "animate-spin")} /> Force sync
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">You don't have an on-chain wallet yet. Generate one to get a real deposit address that works across ETH, BSC, Polygon, Plasma, and Arbitrum.</p>
              <Button onClick={createBuiltinWallet} disabled={creatingWallet} className="w-full font-mono text-xs gap-2">
                {creatingWallet ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {creatingWallet ? "Generating..." : "Generate Wallet"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Send (internal transfer) dialog ─────────────────────────────── */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="font-mono">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-4 h-4 text-primary" /> Send
            </DialogTitle>
            <DialogDescription>Transfer internal balance to another AYZEN user, individually or per team member.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Currency</Label>
              <div className="flex gap-2 flex-wrap">
                {["AZN", "USDT", "XP", "BDT"].map(cur => {
                  const cfg = CURRENCY_CONFIG[cur];
                  return (
                    <button
                      key={cur}
                      type="button"
                      onClick={() => setCurrency(cur)}
                      className={cn(
                        "flex items-center gap-1 px-3 py-1.5 rounded-full font-mono text-[10px] uppercase tracking-wider border transition-all font-bold",
                        currency === cur ? cn(cfg.bg, cfg.color, cfg.border.replace("/20", "/50")) : "border-border/40 text-muted-foreground/60 hover:border-primary/30"
                      )}
                    >
                      <span>{cfg.emoji}</span> {cur}
                    </button>
                  );
                })}
              </div>
              <p className="font-mono text-[10px] text-muted-foreground/50">
                Balance:{" "}
                <span className={CURRENCY_CONFIG[currency]?.color}>
                  {selectedBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {currency}
                </span>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                <User className="w-3 h-3" /> Recipient (username, email, or team member)
              </Label>
              <Input
                value={toUser}
                onChange={e => setToUser(e.target.value)}
                className="font-mono text-xs h-9 bg-input"
                placeholder="e.g. alice or alice@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Amount</Label>
              <div className="relative">
                <Input
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  type="number"
                  step="0.0001"
                  min="0"
                  className={cn("font-mono text-xs h-9 bg-input pr-16", isInsufficient && "border-red-500/50 focus-visible:ring-red-500/30")}
                  placeholder="0.00"
                />
                <button
                  type="button"
                  onClick={() => setAmount(String(selectedBalance))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[9px] uppercase text-primary hover:text-primary/80 border border-primary/30 hover:border-primary/50 rounded px-1.5 py-0.5 transition-all"
                >
                  Max
                </button>
              </div>
              {isInsufficient && (
                <p className="font-mono text-[10px] text-red-400 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Insufficient balance
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Note (optional)</Label>
              <Input
                value={note}
                onChange={e => setNote(e.target.value)}
                className="font-mono text-xs h-9 bg-input"
                placeholder="e.g. Task reward payment"
              />
            </div>

            {toUser && amount && parseFloat(amount) > 0 && !isInsufficient && (
              <div className="rounded-lg bg-primary/5 border border-primary/20 px-4 py-3 space-y-1">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Transfer Preview</div>
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-muted-foreground">To</span>
                  <span className="font-bold text-foreground">{toUser}</span>
                </div>
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-bold text-primary">{parseFloat(amount).toLocaleString()} {currency}</span>
                </div>
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-muted-foreground">Remaining</span>
                  <span className="text-muted-foreground">{(selectedBalance - parseFloat(amount)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {currency}</span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={handleSend}
              disabled={sending || !toUser || !amount || parseFloat(amount) <= 0 || !!isInsufficient}
              className="w-full font-mono text-xs gap-2 h-10"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {sending ? "Sending..." : `Send ${currency}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time recovery phrase reveal — shown only right after generation */}
      <Dialog open={!!revealMnemonic} onOpenChange={(o) => { if (!o && mnemonicConfirmed) setRevealMnemonic(null); }}>
        <DialogContent className="font-mono">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-400">
              <ShieldAlert className="w-4 h-4" /> Save your recovery phrase
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              This is shown once. Anyone with these 12 words can move funds out of this wallet.
              AYZEN stores it encrypted, but you should also save your own copy somewhere safe.
            </p>
            <div className="grid grid-cols-3 gap-1.5 bg-muted/20 border border-border/40 rounded-lg p-3">
              {revealMnemonic?.split(" ").map((w, i) => (
                <div key={i} className="text-[11px] px-2 py-1 rounded bg-card border border-border/30">
                  <span className="text-muted-foreground/40 mr-1">{i + 1}.</span>{w}
                </div>
              ))}
            </div>
            <button
              onClick={() => { if (revealMnemonic) { navigator.clipboard.writeText(revealMnemonic); toast({ title: "Copied" }); } }}
              className="flex items-center gap-1.5 text-[11px] text-primary hover:underline"
            >
              <Copy className="w-3 h-3" /> Copy to clipboard
            </button>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={mnemonicConfirmed} onChange={e => setMnemonicConfirmed(e.target.checked)} className="accent-primary" />
              I've saved this recovery phrase somewhere safe
            </label>
          </div>
          <DialogFooter>
            <Button disabled={!mnemonicConfirmed} onClick={() => setRevealMnemonic(null)} className="w-full font-mono text-xs">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer — real on-chain send from the built-in wallet */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="font-mono">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4 text-primary" /> Transfer out — vault wallet
            </DialogTitle>
            <DialogDescription>Move value from your vault wallet to an external address, on any network it's funded on.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Network</Label>
              <div className="flex gap-1.5 flex-wrap">
                {VAULT_CHAIN_VALUES.map(c => {
                  const info = getChainInfo(c);
                  const active = withdrawChain === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setWithdrawChain(c)}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full font-mono text-[10px] uppercase tracking-wider border transition-all font-bold",
                        active ? "border-primary bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border"
                      )}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: info.color }} />
                      {info.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <Input
              value={withdrawTo}
              onChange={e => setWithdrawTo(e.target.value)}
              placeholder="Destination address (0x...)"
              className="font-mono text-xs"
            />
            <Input
              value={withdrawAmount}
              onChange={e => setWithdrawAmount(e.target.value)}
              type="number"
              min="0"
              step="0.0001"
              placeholder={`Amount (${withdrawChain})`}
              className="font-mono text-xs"
            />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Tx Speed / Gas Price</Label>
                {gasLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
              </div>
              <div className="flex gap-1.5">
                {(["slow", "medium", "fast"] as GasSpeed[]).map(speed => {
                  const tier = gasEstimate?.tiers.find(t => t.speed === speed);
                  const active = withdrawSpeed === speed && !advancedGasOpen;
                  return (
                    <button
                      key={speed}
                      type="button"
                      onClick={() => { setWithdrawSpeed(speed); setAdvancedGasOpen(false); }}
                      className={cn(
                        "flex-1 flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg font-mono uppercase tracking-wider border transition-all",
                        active ? "border-primary bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border"
                      )}
                    >
                      <span className="text-[10px] font-bold">{speed}</span>
                      <span className="normal-case text-[9px] text-muted-foreground/70">
                        {tier ? `${tier.gasPriceGwei} gwei` : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
              {activeTier && !advancedGasOpen && (
                <p className="text-[10px] text-muted-foreground/60">
                  Est. fee: ~{activeTier.estimatedNativeCost.toFixed(6)} {gasEstimate?.nativeSymbol}
                  {activeTier.estimatedUsdCost > 0 ? ` (~$${activeTier.estimatedUsdCost.toFixed(2)})` : ""}
                </p>
              )}
              <button
                type="button"
                onClick={() => setAdvancedGasOpen(o => !o)}
                className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                {advancedGasOpen ? "Hide advanced" : "Advanced: set custom gwei limit"}
              </button>
              {advancedGasOpen && (
                <div className="space-y-1.5 pt-1.5 border-t border-border/30">
                  {gasEstimate?.isEip1559 ? (
                    <>
                      <Input
                        value={advMaxFeeGwei}
                        onChange={e => setAdvMaxFeeGwei(e.target.value)}
                        type="number" min="0" step="0.01"
                        placeholder="Max fee (gwei)"
                        className="font-mono text-xs"
                      />
                      <Input
                        value={advPriorityGwei}
                        onChange={e => setAdvPriorityGwei(e.target.value)}
                        type="number" min="0" step="0.01"
                        placeholder="Max priority fee (gwei)"
                        className="font-mono text-xs"
                      />
                    </>
                  ) : (
                    <Input
                      value={advGasPriceGwei}
                      onChange={e => setAdvGasPriceGwei(e.target.value)}
                      type="number" min="0" step="0.01"
                      placeholder="Gas price (gwei)"
                      className="font-mono text-xs"
                    />
                  )}
                  <p className="text-[9px] text-muted-foreground/60">A custom gwei value here overrides the speed tier picked above.</p>
                </div>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
              <AlertCircle className="w-3 h-3" /> This broadcasts a real on-chain transaction on {getChainInfo(withdrawChain).label} and cannot be reversed.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={handleWithdrawOnChain} disabled={withdrawing} className="w-full font-mono text-xs gap-1.5">
              {withdrawing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
              {withdrawing ? "Broadcasting..." : "Confirm Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
