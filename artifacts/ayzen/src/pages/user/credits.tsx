import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Coins, ArrowRightLeft, Crown, Zap, Check, Loader2, Copy,
  RefreshCw, Clock, AlertCircle, Shield, ExternalLink, X,
  ChevronDown, ChevronUp, Sparkles, Star, Gift,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface CreditsData {
  credits: {
    balance: number;
    aznBalance: number;
    totalPurchased: number;
    totalSpent: number;
  };
  transactions: Array<{
    id: number;
    type: string;
    method: string | null;
    credits: number;
    aznAmount: number;
    amountBDT: number | null;
    amountUSDT: number | null;
    referenceId: string | null;
    status: string;
    notes: string | null;
    createdAt: string;
  }>;
  packages: Array<{
    id: string;
    label: string;
    credits: number;
    priceBDT: number;
    priceUSDT: number;
    bonus: number;
  }>;
  rates: { creditsPerAzn: number; aznForPro: number; aznForEnterprise: number };
  paymentInfo: { bkash: string; nagad: string; usdt: string; usdtNetwork: string };
  // PHASE 5b — every metered action + its current effective cost (code
  // default, or an admin's override from the credit console). Powers the
  // new "Rates" tab below so a user can see what a Vault/Local/KYC/Game
  // entity view or any other metered action costs before they trigger it.
  meteredActions: Array<{ key: string; app: string; label: string; cost: number }>;
}

const APP_LABELS: Record<string, string> = {
  sylo: "Sylo (Vault)", ryft: "Ryft (Finance)", wisp: "Wisp (Mail)",
  zynth: "Zynth (AI)", verve: "Verve (Marketplace)", skarn: "Skarn (Protocols)",
  astra: "Astra (Extension)", workspace: "Workspace",
};
const APP_ICONS: Record<string, string> = {
  sylo: "🔐", ryft: "💰", wisp: "✉️", zynth: "🤖", verve: "🛒", skarn: "🌾", astra: "🧩", workspace: "🗂️",
};

const METHOD_ICONS: Record<string, string> = { bkash: "💳", nagad: "📱", binance_usdt: "₮" };
const METHOD_LABELS: Record<string, string> = { bkash: "bKash", nagad: "Naggad", binance_usdt: "Binance USDT" };
const STATUS_COLORS: Record<string, string> = {
  pending: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  approved: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  rejected: "text-red-400 border-red-400/30 bg-red-400/10",
};

export default function CreditsPage() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<CreditsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"buy" | "swap" | "sell" | "transfer" | "history" | "rates">("buy");

  const [selectedPkg, setSelectedPkg] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<string>("bkash");
  const [refId, setRefId] = useState("");
  const [senderNum, setSenderNum] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const [swapAmount, setSwapAmount] = useState("");
  const [swapping, setSwapping] = useState(false);

  const [sellAmount, setSellAmount] = useState("");
  const [sellMethod, setSellMethod] = useState("bkash");
  const [sellAccount, setSellAccount] = useState("");
  const [selling, setSelling] = useState(false);

  const [transferTo, setTransferTo] = useState("");
  const [transferAmt, setTransferAmt] = useState("");
  const [transferring, setTransferring] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const handleTransfer = async () => {
    const amount = parseFloat(transferAmt);
    if (!transferTo.trim()) { toast({ variant: "destructive", title: "Enter a username" }); return; }
    if (!amount || amount < 0.01) { toast({ variant: "destructive", title: "Minimum transfer is 0.01 AZN" }); return; }
    setTransferring(true);
    try {
      const r = await fetch(`${BASE}/api/credits/transfer`, {
        method: "POST", headers,
        body: JSON.stringify({ toUsername: transferTo.trim(), amount }),
      });
      const d = await r.json();
      if (r.ok) {
        toast({ title: `💸 Sent ${amount} AZN to @${transferTo}`, description: d.message });
        setTransferTo(""); setTransferAmt("");
        await fetchData();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Transfer failed" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setTransferring(false);
  };

  const handleSellAzn = async () => {
    const amount = parseFloat(sellAmount);
    if (!amount || amount < 1) { toast({ variant: "destructive", title: "Minimum sell is 1 AZN" }); return; }
    if (!sellAccount.trim()) { toast({ variant: "destructive", title: "Enter your account number / wallet address" }); return; }
    setSelling(true);
    try {
      const r = await fetch(`${BASE}/api/credits/sell-azn`, {
        method: "POST", headers,
        body: JSON.stringify({ aznAmount: amount, method: sellMethod, accountNumber: sellAccount.trim() }),
      });
      const d = await r.json();
      if (r.ok) {
        toast({ title: "✅ Sell Request Submitted!", description: d.message });
        setSellAmount(""); setSellAccount("");
        await fetchData();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Sell failed" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSelling(false);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/credits`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setData(await r.json());
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const handlePurchase = async () => {
    if (!selectedPkg) { toast({ variant: "destructive", title: "Select a package" }); return; }
    if (!refId.trim()) { toast({ variant: "destructive", title: "Enter your transaction ID" }); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`${BASE}/api/credits/purchase`, {
        method: "POST", headers,
        body: JSON.stringify({ packageId: selectedPkg, method: selectedMethod, referenceId: refId.trim(), senderNumber: senderNum.trim() || undefined }),
      });
      const d = await r.json();
      if (r.ok) {
        setSubmitted(true);
        toast({ title: "✅ Payment submitted!", description: "Credits will be added after admin approval." });
        await fetchData();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Failed to submit" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSubmitting(false);
  };

  const handleSwap = async () => {
    const n = parseInt(swapAmount, 10);
    if (!n || n < (data?.rates.creditsPerAzn ?? 100)) {
      toast({ variant: "destructive", title: `Minimum ${data?.rates.creditsPerAzn ?? 100} credits` }); return;
    }
    setSwapping(true);
    try {
      const r = await fetch(`${BASE}/api/credits/swap`, { method: "POST", headers, body: JSON.stringify({ credits: n }) });
      const d = await r.json();
      if (r.ok) {
        toast({ title: `⚡ Swapped! Got ${d.aznReceived} AZN`, description: `New AZN Balance: ${d.newAznBalance}` });
        setSwapAmount("");
        await fetchData();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Swap failed" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSwapping(false);
  };

  const pkg = selectedPkg ? data?.packages.find(p => p.id === selectedPkg) : null;
  const aznPreview = Math.floor(parseInt(swapAmount || "0", 10) / (data?.rates.creditsPerAzn ?? 100));

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        {[1, 2, 3].map(i => <div key={i} className="bg-card border border-card-border rounded-lg h-24 animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header balances */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <Coins className="w-6 h-6 text-primary" /> Credits & AZN
        </h1>
        <p className="text-muted-foreground font-mono text-xs mt-1">Buy credits → swap for AZN → pay subscriptions</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Credit Balance", value: (data?.credits.balance ?? 0).toLocaleString(), suffix: "CR", color: "text-primary" },
          { label: "AZN Balance", value: (data?.credits.aznBalance ?? 0).toFixed(2), suffix: "AZN", color: "text-amber-400" },
          { label: "Total Bought", value: (data?.credits.totalPurchased ?? 0).toLocaleString(), suffix: "CR", color: "text-emerald-400" },
          { label: "Swap Rate", value: `${data?.rates.creditsPerAzn ?? 100} CR`, suffix: "= 1 AZN", color: "text-violet-400" },
        ].map(({ label, value, suffix, color }) => (
          <div key={label} className="bg-card border border-card-border rounded-lg px-4 py-3">
            <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
            <div className={cn("font-mono font-bold text-lg leading-none", color)}>{value}</div>
            <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{suffix}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border border-border rounded-lg overflow-hidden bg-card">
        {(["buy", "swap", "sell", "transfer", "history", "rates"] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={cn(
              "flex-1 py-2.5 text-xs font-mono uppercase tracking-widest transition-colors",
              activeTab === t ? "bg-primary/15 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "buy" ? "💳 Buy" : t === "swap" ? "⚡ Swap" : t === "sell" ? "💰 Sell" : t === "transfer" ? "💸 Send" : t === "history" ? "📋 History" : "🏷️ Rates"}
          </button>
        ))}
      </div>

      {/* ── BUY TAB ────────────────────────────────────────────────────── */}
      {activeTab === "buy" && !submitted && (
        <div className="space-y-5">
          {/* Packages */}
          <div>
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">Select Package</div>
            <div className="grid grid-cols-2 gap-3">
              {data?.packages.map(pkg => (
                <button
                  key={pkg.id}
                  onClick={() => setSelectedPkg(pkg.id)}
                  className={cn(
                    "text-left rounded-lg border px-4 py-4 transition-all",
                    selectedPkg === pkg.id
                      ? "border-primary/50 bg-primary/10"
                      : "border-card-border bg-card hover:border-primary/20 hover:bg-primary/5"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-bold text-sm text-foreground">{pkg.label}</span>
                    {pkg.bonus > 0 && (
                      <Badge className="font-mono text-[8px] px-1.5 py-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/20">
                        +{pkg.bonus}%
                      </Badge>
                    )}
                  </div>
                  <div className="font-mono text-xl font-bold text-primary">{pkg.credits.toLocaleString()}<span className="text-xs text-muted-foreground ml-1">CR</span></div>
                  <div className="font-mono text-[10px] text-muted-foreground mt-1.5 space-y-0.5">
                    <div>৳ {pkg.priceBDT.toLocaleString()} BDT</div>
                    <div>${pkg.priceUSDT} USDT</div>
                  </div>
                  {selectedPkg === pkg.id && <Check className="w-4 h-4 text-primary mt-2" />}
                </button>
              ))}
            </div>
          </div>

          {/* Payment Method */}
          <div>
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">Payment Method</div>
            <div className="grid grid-cols-3 gap-2">
              {["bkash", "nagad", "binance_usdt"].map(m => (
                <button
                  key={m}
                  onClick={() => setSelectedMethod(m)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 transition-all",
                    selectedMethod === m
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-card-border bg-card text-muted-foreground hover:border-primary/20"
                  )}
                >
                  <span className="text-xl">{METHOD_ICONS[m]}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider">{METHOD_LABELS[m]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Payment Instructions */}
          {pkg && (
            <div className="bg-card border border-primary/20 rounded-lg overflow-hidden">
              <div className="bg-primary/5 border-b border-primary/15 px-5 py-3">
                <div className="font-mono text-xs font-bold text-primary">
                  {METHOD_ICONS[selectedMethod]} {selectedMethod === "binance_usdt" ? "Send USDT" : `Send via ${METHOD_LABELS[selectedMethod]}`}
                </div>
              </div>
              <div className="px-5 py-4 space-y-3">
                {selectedMethod !== "binance_usdt" ? (
                  <>
                    <div className="flex items-center justify-between bg-background border border-card-border rounded-md px-3 py-2.5">
                      <div>
                        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                          {selectedMethod === "bkash" ? "bKash Number" : "Naggad Number"}
                        </div>
                        <div className="font-mono font-bold text-sm text-foreground mt-0.5">
                          {selectedMethod === "bkash" ? data?.paymentInfo.bkash : data?.paymentInfo.nagad}
                        </div>
                      </div>
                      <button
                        onClick={() => copyText("num", selectedMethod === "bkash" ? (data?.paymentInfo.bkash ?? "") : (data?.paymentInfo.nagad ?? ""))}
                        className="text-muted-foreground hover:text-primary"
                      >
                        {copiedKey === "num" ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-background border border-card-border rounded-md px-3 py-2.5">
                      <div>
                        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Amount (BDT)</div>
                        <div className="font-mono font-bold text-sm text-primary">৳ {pkg.priceBDT.toLocaleString()}</div>
                      </div>
                      <button onClick={() => copyText("bdt", String(pkg.priceBDT))} className="text-muted-foreground hover:text-primary">
                        {copiedKey === "bdt" ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Send <span className="text-primary font-bold">৳{pkg.priceBDT}</span> to the number above via {METHOD_LABELS[selectedMethod]}. Use "Send Money" (not Payment).
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between bg-background border border-card-border rounded-md px-3 py-2.5">
                      <div>
                        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                          USDT Address ({data?.paymentInfo.usdtNetwork})
                        </div>
                        <div className="font-mono text-[11px] text-foreground mt-0.5 break-all">{data?.paymentInfo.usdt}</div>
                      </div>
                      <button onClick={() => copyText("usdt", data?.paymentInfo.usdt ?? "")} className="text-muted-foreground hover:text-primary flex-shrink-0 ml-2">
                        {copiedKey === "usdt" ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-background border border-card-border rounded-md px-3 py-2.5">
                      <div>
                        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">Amount (USDT)</div>
                        <div className="font-mono font-bold text-sm text-primary">${pkg.priceUSDT} USDT</div>
                      </div>
                      <button onClick={() => copyText("usdt_amt", String(pkg.priceUSDT))} className="text-muted-foreground hover:text-primary">
                        {copiedKey === "usdt_amt" ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="font-mono text-[10px] text-amber-300/80">
                      Send exactly <span className="text-primary font-bold">${pkg.priceUSDT} USDT</span> on {data?.paymentInfo.usdtNetwork} network to the address above.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Proof fields */}
          {pkg && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {selectedMethod === "binance_usdt" ? "TX Hash / Transaction ID" : "Transaction ID (TrxID)"} <span className="text-red-400">*</span>
                </label>
                <Input
                  value={refId}
                  onChange={e => setRefId(e.target.value)}
                  placeholder={selectedMethod === "binance_usdt" ? "0x... or TXID" : "e.g. 8AB23DF1E0..."}
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                />
              </div>
              {selectedMethod !== "binance_usdt" && (
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Your {METHOD_LABELS[selectedMethod]} Number
                  </label>
                  <Input
                    value={senderNum}
                    onChange={e => setSenderNum(e.target.value)}
                    placeholder="+880 1X XXXX XXXX"
                    className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                  />
                </div>
              )}
              <Button
                onClick={handlePurchase}
                disabled={submitting || !refId.trim() || !selectedPkg}
                className="w-full font-mono text-xs gap-2 h-11"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {submitting ? "Submitting..." : `Submit Payment Proof — ${pkg?.credits.toLocaleString()} CR`}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Submitted success */}
      {activeTab === "buy" && submitted && (
        <div className="bg-card border border-emerald-500/20 rounded-xl px-6 py-10 text-center space-y-4">
          <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
            <Check className="w-7 h-7 text-emerald-400" />
          </div>
          <div>
            <div className="font-mono font-bold text-lg text-foreground">Payment Submitted!</div>
            <div className="font-mono text-xs text-muted-foreground mt-1">Credits will be added after admin verification (1–2 hours).</div>
          </div>
          <Button variant="outline" onClick={() => { setSubmitted(false); setRefId(""); setSenderNum(""); setSelectedPkg(null); }} className="font-mono text-xs gap-2">
            <RefreshCw className="w-3.5 h-3.5" /> Submit Another
          </Button>
        </div>
      )}

      {/* ── SWAP TAB ──────────────────────────────────────────────────────── */}
      {activeTab === "swap" && (
        <div className="space-y-5">
          <div className="bg-card border border-primary/20 rounded-xl overflow-hidden">
            <div className="bg-primary/5 border-b border-primary/15 px-5 py-4">
              <div className="font-mono font-bold text-sm text-primary flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4" /> Credits → AZN Token
              </div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                Rate: {data?.rates.creditsPerAzn ?? 100} Credits = 1 AZN · You have {(data?.credits.balance ?? 0).toLocaleString()} CR
              </div>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Credits to Swap</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={swapAmount}
                    onChange={e => setSwapAmount(e.target.value)}
                    placeholder={`Min ${data?.rates.creditsPerAzn ?? 100}`}
                    min={data?.rates.creditsPerAzn ?? 100}
                    step={data?.rates.creditsPerAzn ?? 100}
                    className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                  />
                  <div className="flex gap-1">
                    {[100, 500, 1000, 5000].map(amt => (
                      <button
                        key={amt}
                        onClick={() => setSwapAmount(String(amt))}
                        className="px-2 h-10 rounded-md border border-border text-[9px] font-mono text-muted-foreground hover:border-primary/30 hover:text-primary transition-all"
                      >
                        {amt >= 1000 ? `${amt / 1000}K` : amt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-background border border-card-border rounded-md px-4 py-3 flex items-center justify-between">
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">You Receive</div>
                  <div className="font-mono font-bold text-2xl text-amber-400">{aznPreview}<span className="text-sm ml-1.5 text-muted-foreground">AZN</span></div>
                </div>
                <Sparkles className="w-8 h-8 text-amber-400/30" />
              </div>

              <Button
                onClick={handleSwap}
                disabled={swapping || !swapAmount || parseInt(swapAmount, 10) < (data?.rates.creditsPerAzn ?? 100)}
                className="w-full font-mono text-xs gap-2 h-11 bg-amber-500 hover:bg-amber-500/90 text-black"
              >
                {swapping ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                {swapping ? "Swapping..." : `Swap ${swapAmount || "0"} Credits → ${aznPreview} AZN`}
              </Button>
            </div>
          </div>

          {/* AZN use cases */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-card border border-primary/20 rounded-lg px-4 py-4">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-4 h-4 text-primary" />
                <span className="font-mono font-bold text-xs text-primary">Pro Plan</span>
              </div>
              <div className="font-mono text-2xl font-bold text-foreground">{data?.rates.aznForPro ?? 200}<span className="text-sm text-muted-foreground ml-1">AZN</span></div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">per month</div>
            </div>
            <div className="bg-card border border-amber-400/20 rounded-lg px-4 py-4">
              <div className="flex items-center gap-2 mb-2">
                <Crown className="w-4 h-4 text-amber-400" />
                <span className="font-mono font-bold text-xs text-amber-400">Enterprise Plan</span>
              </div>
              <div className="font-mono text-2xl font-bold text-foreground">{data?.rates.aznForEnterprise ?? 1000}<span className="text-sm text-muted-foreground ml-1">AZN</span></div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">per month</div>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[10px] font-mono text-muted-foreground/50">
            <Shield className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>AZN tokens are stored server-side. On-chain AZN (Base L2) can be claimed after KYC is complete.</span>
          </div>
        </div>
      )}

      {/* ── SELL AZN TAB ─────────────────────────────────────────────────────── */}
      {activeTab === "sell" && (
        <div className="space-y-5">
          <div className="bg-amber-400/5 border border-amber-400/20 rounded-xl overflow-hidden">
            <div className="bg-amber-400/10 border-b border-amber-400/15 px-5 py-4">
              <div className="font-mono font-bold text-sm text-amber-400 flex items-center gap-2">
                <Coins className="w-4 h-4" /> Sell AZN → Cash
              </div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                Convert your AZN back to BDT/USDT. Admin sends payment within 24 hours.
              </div>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div className="grid grid-cols-3 gap-3 bg-background rounded-lg border border-card-border p-3">
                <div className="text-center">
                  <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest mb-1">AZN Balance</div>
                  <div className="font-mono font-bold text-amber-400">{(data?.credits.aznBalance ?? 0).toFixed(2)}</div>
                </div>
                <div className="text-center border-x border-border">
                  <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest mb-1">AZN Price</div>
                  <div className="font-mono font-bold text-primary">$0.01</div>
                </div>
                <div className="text-center">
                  <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest mb-1">Rate</div>
                  <div className="font-mono font-bold text-emerald-400">৳1.30</div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">AZN Amount to Sell</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={sellAmount}
                    onChange={e => setSellAmount(e.target.value)}
                    placeholder="Min 1 AZN"
                    min={1}
                    step={1}
                    className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                  />
                  <div className="flex gap-1">
                    {[10, 50, 100, 500].map(amt => (
                      <button key={amt} onClick={() => setSellAmount(String(amt))}
                        className="px-2 h-10 rounded-md border border-border text-[9px] font-mono text-muted-foreground hover:border-amber-400/30 hover:text-amber-400 transition-all">
                        {amt}
                      </button>
                    ))}
                  </div>
                </div>
                {sellAmount && parseFloat(sellAmount) > 0 && (
                  <div className="font-mono text-[10px] text-amber-400 mt-1">
                    ≈ ৳{(parseFloat(sellAmount) * 1.30).toFixed(2)} BDT &nbsp;|&nbsp; ${(parseFloat(sellAmount) * 0.01).toFixed(4)} USD
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Withdrawal Method</label>
                <div className="grid grid-cols-3 gap-2">
                  {(["bkash", "nagad", "binance_usdt"] as const).map(m => (
                    <button key={m} onClick={() => setSellMethod(m)}
                      className={cn("flex flex-col items-center gap-1 rounded-lg border px-2 py-3 transition-all",
                        sellMethod === m ? "border-amber-400/50 bg-amber-400/10 text-amber-400" : "border-card-border bg-card text-muted-foreground hover:border-amber-400/20")}>
                      <span className="text-lg">{METHOD_ICONS[m]}</span>
                      <span className="font-mono text-[9px] uppercase tracking-wider">{METHOD_LABELS[m]}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {sellMethod === "binance_usdt" ? "Binance Wallet Address" : `Your ${METHOD_LABELS[sellMethod]} Number`}
                </label>
                <Input
                  value={sellAccount}
                  onChange={e => setSellAccount(e.target.value)}
                  placeholder={sellMethod === "binance_usdt" ? "0x... or Binance UID" : "+880 1X XXXX XXXX"}
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                />
              </div>

              <div className="bg-background border border-amber-400/20 rounded-md px-4 py-3 font-mono text-[10px] text-muted-foreground">
                <span className="text-amber-400 font-bold">ℹ Note:</span> AZN is deducted immediately. Admin sends payment within 24 hours. Minimum: 1 AZN.
              </div>

              <Button
                onClick={handleSellAzn}
                disabled={selling || !sellAmount || parseFloat(sellAmount) < 1 || !sellAccount.trim()}
                className="w-full font-mono text-xs gap-2 h-11 bg-amber-500 hover:bg-amber-500/90 text-black"
              >
                {selling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                {selling ? "Processing..." : `Request Withdrawal — ${sellAmount || "0"} AZN`}
              </Button>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[10px] font-mono text-muted-foreground/50">
            <Shield className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>All sell requests are reviewed by admin. On-chain redemption will be available after KYC launch.</span>
          </div>
        </div>
      )}

      {/* ── TRANSFER TAB ─────────────────────────────────────────────────────── */}
      {activeTab === "transfer" && (
        <div className="space-y-5">
          <div className="bg-card border border-primary/20 rounded-xl overflow-hidden">
            <div className="bg-primary/5 border-b border-primary/15 px-5 py-4">
              <div className="font-mono font-bold text-sm text-primary flex items-center gap-2">
                💸 Send AZN to Operator
              </div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                Transfer AZN tokens directly to any AYZEN operator by username. Instant settlement.
              </div>
            </div>
            <div className="px-5 py-5 space-y-4">
              {/* Balance display */}
              <div className="bg-background border border-card-border rounded-md px-4 py-3 flex items-center justify-between">
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Your AZN Balance</div>
                  <div className="font-mono font-bold text-2xl text-amber-400">{(data?.credits.aznBalance ?? 0).toFixed(4)}<span className="text-sm ml-1.5 text-muted-foreground">AZN</span></div>
                </div>
                <Coins className="w-8 h-8 text-amber-400/20" />
              </div>

              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Recipient Username</label>
                <Input
                  value={transferTo}
                  onChange={e => setTransferTo(e.target.value)}
                  placeholder="e.g. operator123"
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Amount (AZN)</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={transferAmt}
                    onChange={e => setTransferAmt(e.target.value)}
                    placeholder="Min 0.01"
                    min={0.01}
                    step={0.01}
                    className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                  />
                  <div className="flex gap-1">
                    {[1, 5, 10, 50].map(amt => (
                      <button key={amt} onClick={() => setTransferAmt(String(amt))}
                        className="px-2 h-10 rounded-md border border-border text-[9px] font-mono text-muted-foreground hover:border-primary/30 hover:text-primary transition-all">
                        {amt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-background border border-card-border rounded-md px-4 py-3 font-mono text-[10px] text-muted-foreground">
                <span className="text-primary font-bold">ℹ Note:</span> Transfers are instant and irreversible. Make sure the username is correct before confirming.
              </div>

              <Button
                onClick={handleTransfer}
                disabled={transferring || !transferTo.trim() || !transferAmt || parseFloat(transferAmt) < 0.01}
                className="w-full font-mono text-xs gap-2 h-11"
              >
                {transferring ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>💸</span>}
                {transferring ? "Sending..." : `Send ${transferAmt || "0"} AZN to @${transferTo || "..."}`}
              </Button>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[10px] font-mono text-muted-foreground/50">
            <Shield className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>AZN transfers are logged on both sides. The recipient is notified instantly.</span>
          </div>
        </div>
      )}

      {/* ── RATES TAB — what every metered action currently costs ──────────── */}
      {activeTab === "rates" && (
        <div className="space-y-4">
          <div className="bg-background border border-card-border rounded-md px-4 py-3 font-mono text-[10px] text-muted-foreground">
            <span className="text-primary font-bold">ℹ Note:</span> Core browsing (viewing your lists, basic wallet, basic mail) always stays free. Only the actions below draw from your credit balance — prices can change any time from the admin console, this list always reflects the live rate.
          </div>
          {data?.meteredActions.length === 0 ? (
            <div className="bg-card border border-card-border rounded-lg px-6 py-10 text-center">
              <p className="font-mono text-sm text-muted-foreground">No metered actions configured</p>
            </div>
          ) : (
            Object.entries(
              (data?.meteredActions ?? []).reduce<Record<string, typeof data.meteredActions>>((acc, a) => {
                (acc[a.app] ??= []).push(a);
                return acc;
              }, {})
            ).map(([app, actions]) => (
              <div key={app} className="bg-card border border-card-border rounded-lg overflow-hidden">
                <div className="bg-background/40 border-b border-card-border px-4 py-2.5 font-mono text-xs font-bold text-foreground flex items-center gap-2">
                  <span>{APP_ICONS[app] ?? "⚙️"}</span> {APP_LABELS[app] ?? app}
                </div>
                <div className="divide-y divide-card-border">
                  {actions.map(a => (
                    <div key={a.key} className="px-4 py-2.5 flex items-center justify-between">
                      <span className="font-mono text-xs text-muted-foreground">{a.label}</span>
                      <Badge className={cn("font-mono text-[10px] px-2 py-0.5 border",
                        a.cost === 0
                          ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10"
                          : "text-primary border-primary/30 bg-primary/10")}>
                        {a.cost === 0 ? "FREE" : `${a.cost} CR`}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── HISTORY TAB ────────────────────────────────────────────────────── */}
      {activeTab === "history" && (
        <div className="space-y-3">
          {data?.transactions.length === 0 ? (
            <div className="bg-card border border-card-border rounded-lg px-6 py-10 text-center">
              <Clock className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="font-mono text-sm text-muted-foreground">No transactions yet</p>
            </div>
          ) : (
            data?.transactions.map(tx => (
              <div key={tx.id} className="bg-card border border-card-border rounded-lg px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="text-xl">{tx.method ? METHOD_ICONS[tx.method] ?? "⚙️" : "⚙️"}</div>
                    <div>
                      <div className="font-mono text-xs font-bold text-foreground capitalize">
                        {tx.type.replace(/_/g, " ")}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        {tx.notes ?? (tx.referenceId ? `Ref: ${tx.referenceId.slice(0, 16)}…` : "")}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    {tx.credits !== 0 && (
                      <div className={cn("font-mono font-bold text-sm", tx.credits > 0 ? "text-emerald-400" : "text-red-400")}>
                        {tx.credits > 0 ? "+" : ""}{tx.credits.toLocaleString()} CR
                      </div>
                    )}
                    {tx.aznAmount !== 0 && (
                      <div className={cn("font-mono text-xs", tx.aznAmount > 0 ? "text-amber-400" : "text-red-400")}>
                        {tx.aznAmount > 0 ? "+" : ""}{tx.aznAmount} AZN
                      </div>
                    )}
                    <Badge className={cn("font-mono text-[8px] uppercase px-1.5 py-0 mt-1 border", STATUS_COLORS[tx.status] ?? "")}>
                      {tx.status}
                    </Badge>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
