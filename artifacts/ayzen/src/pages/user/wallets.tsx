import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Wallet, Plus, Trash2, RefreshCw, Star, Copy, Check,
  ChevronDown, ChevronUp, ExternalLink, Shield, AlertCircle, Loader2,
  Key, Send, Eye, EyeOff, ArrowUpRight, X, Zap, Link2, Gem, Landmark,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWalletConnect } from "@/hooks/use-wallet-connect";
import { WALLET_CHAINS, getChainInfo, getExplorerUrl } from "@/config/wallet";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { getVaultChains, type VaultChain } from "@/lib/vault-chains-api";
import { HealthChecklistCard, HealthScoreBadge } from "@/components/vault/health-checklist";
import { WALLET_HEALTH_CHECKS } from "@/config/columns/entity-view";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { PinInput } from "@/components/vault/pin-input";
import { verifyPin, getVaultSecurityStatus } from "@/lib/vault-security-api";
import { ApiError } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface WalletEntry {
  id: number;
  userId: number;
  label: string;
  address: string;
  chain: string;
  chainId: number | null;
  balance: number;
  balanceUsd: number;
  tokenCount: number;
  nftCount: number;
  txCount: number;
  isPrimary: boolean;
  autoFinanceSync: boolean;
  lastSyncedAt: string | null;
  notes: string | null;
  encryptedPhrase?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Chain list + block-explorer URLs now live in @/config/wallet.ts as
// WALLET_CHAINS / getExplorerUrl. Adding a supported chain is one entry
// there (network dot color, address prefix, and explorer link together).
const CHAINS = WALLET_CHAINS;
const chainInfo = getChainInfo;
const explorerUrl = getExplorerUrl;

function shortenAddr(addr: string) {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// ── Reveal guard — required every time "Reveal" is pressed on a saved
// phrase, same defense-in-depth pattern as pages/user/vault-wallet-seed.tsx's
// useRevealGuard(). GET /wallets/:id/phrase now requires a fresh reveal
// token from a successful entity-PIN verify (see routes/wallets.ts) — this
// is the UI half of that, so "Reveal" doesn't just start failing with a 403.
// If no entity PIN has been set at all, resolves immediately with null
// (nothing to gate on — same rule the backend uses).
function useRevealGuard() {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const resolverRef = useRef<((v: string | null | undefined) => void) | null>(null);

  const requireReauth = (): Promise<string | null | undefined> => {
    return new Promise(async (resolve) => {
      try {
        const status = await getVaultSecurityStatus();
        if (!status.entityPinSet) { resolve(null); return; }
      } catch {
        resolve(null); return; // status unknown — don't block on a network hiccup
      }
      resolverRef.current = resolve;
      setPin("");
      setError(null);
      setOpen(true);
    });
  };

  const submit = async (candidate: string) => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await verifyPin("entity", candidate);
      if (result.valid) {
        setOpen(false);
        resolverRef.current?.(result.revealToken ?? null);
        resolverRef.current = null;
      } else {
        setError("Incorrect PIN");
        setPin("");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError((err.data as any)?.solution ?? "Too many attempts — try again shortly.");
      } else {
        setError("Could not verify PIN — try again.");
      }
      setPin("");
    } finally { setChecking(false); }
  };

  const cancel = () => {
    setOpen(false);
    resolverRef.current?.(undefined);
    resolverRef.current = null;
  };

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => { if (!o) cancel(); }}>
      <DialogContent className="font-mono max-w-xs">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Shield className="w-4 h-4 text-primary" /> Confirm PIN to reveal
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            Re-enter your entity PIN — required every time this phrase is decrypted.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <PinInput value={pin} onChange={setPin} onComplete={submit} disabled={checking} error={!!error} />
          {checking && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
          {error && <p className="text-[10px] text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={cancel} className="font-mono text-xs w-full">Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { requireReauth, dialog };
}

// ─── Phrase Modal ─────────────────────────────────────────────────────────────
function PhraseModal({ wallet, token, onClose }: { wallet: WalletEntry; token: string; onClose: () => void }) {
  const { toast } = useToast();
  const [phrase, setPhrase] = useState("");
  const [showPhrase, setShowPhrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSaved, setHasSaved] = useState(!!wallet.encryptedPhrase);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const { requireReauth, dialog: reauthDialog } = useRevealGuard();

  const handleSave = async () => {
    if (!phrase.trim()) { toast({ variant: "destructive", title: "Enter a seed phrase or private key" }); return; }
    const words = phrase.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24 && !phrase.trim().startsWith("0x")) {
      toast({ variant: "destructive", title: "Invalid phrase", description: "Expected 12/24 words or a 0x private key" });
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/wallets/${wallet.id}/phrase`, {
        method: "POST", headers, body: JSON.stringify({ phrase: phrase.trim() }),
      });
      const d = await r.json();
      if (r.ok) {
        toast({ title: "🔒 Phrase encrypted & saved" });
        setHasSaved(true);
        setPhrase("");
      } else {
        toast({ variant: "destructive", title: d.error ?? "Failed to save" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setLoading(false);
  };

  const handleReveal = async () => {
    const revealToken = await requireReauth();
    if (revealToken === undefined) return; // user cancelled the PIN prompt
    setLoading(true);
    try {
      const revealHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (revealToken) revealHeaders["x-reveal-token"] = revealToken;
      const r = await fetch(`${BASE}/api/wallets/${wallet.id}/phrase`, { headers: revealHeaders });
      const d = await r.json();
      if (r.ok) {
        setPhrase(d.phrase);
        setShowPhrase(true);
      } else if (d.code === "REVEAL_TOKEN_REQUIRED") {
        toast({ variant: "destructive", title: "PIN check expired", description: "Please try Reveal again." });
      } else {
        toast({ variant: "destructive", title: d.error ?? "Failed to decrypt" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setLoading(false);
  };

  return (
    <>
    {reauthDialog}
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-primary/20 rounded-xl w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-card-border">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-primary" />
            <span className="font-mono font-bold text-sm">Seed Phrase Vault</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="font-mono text-[10px] text-amber-300/80 leading-relaxed">
              Phrase is encrypted server-side with AES-256. Never share with anyone. AYZEN staff will never ask for your phrase.
            </p>
          </div>

          <div className="bg-background border border-card-border rounded-md px-3 py-2.5">
            <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Wallet</div>
            <div className="font-mono text-xs font-bold text-foreground">{wallet.label}</div>
            <div className="font-mono text-[10px] text-muted-foreground">{shortenAddr(wallet.address)} · {wallet.chain}</div>
          </div>

          {hasSaved ? (
            <div className="space-y-3">
              <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 text-center">
                <div className="font-mono text-xs text-primary mb-1">🔒 Phrase saved & encrypted</div>
                <div className="font-mono text-[10px] text-muted-foreground">Encrypted with AES-256-CBC</div>
              </div>
              {showPhrase && phrase ? (
                <div className="bg-red-900/10 border border-red-500/20 rounded-md p-3">
                  <div className="text-[9px] font-mono uppercase tracking-widest text-red-400 mb-2">⚠ Phrase (keep private)</div>
                  <div className="font-mono text-xs text-foreground break-all leading-relaxed">{phrase}</div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full font-mono text-xs gap-2 border-amber-500/20 text-amber-400 hover:bg-amber-500/10"
                  onClick={handleReveal}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                  Reveal Encrypted Phrase
                </Button>
              )}
              <Button
                variant="outline"
                className="w-full font-mono text-xs gap-2 border-primary/20 text-primary hover:bg-primary/10"
                onClick={() => { setHasSaved(false); setPhrase(""); setShowPhrase(false); }}
              >
                <Key className="w-3.5 h-3.5" /> Update Phrase
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Seed Phrase / Private Key
                </label>
                <div className="relative">
                  <textarea
                    value={phrase}
                    onChange={e => setPhrase(e.target.value)}
                    placeholder="word1 word2 word3 ... (12 or 24 words) or 0x private key"
                    className="w-full bg-input border border-border rounded-md px-3 py-2.5 font-mono text-xs text-foreground placeholder-muted-foreground/40 resize-none h-20 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    style={{ filter: showPhrase ? "none" : "blur(3px)" }}
                    onFocus={() => setShowPhrase(true)}
                  />
                  {!showPhrase && (
                    <button
                      className="absolute inset-0 flex items-center justify-center text-muted-foreground font-mono text-xs"
                      onClick={() => setShowPhrase(true)}
                    >
                      <Eye className="w-4 h-4 mr-1" /> Click to reveal input
                    </button>
                  )}
                </div>
              </div>
              <Button
                onClick={handleSave}
                disabled={loading || !phrase.trim()}
                className="w-full font-mono text-xs gap-2"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                Encrypt & Save Phrase
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

// ─── Send Modal ────────────────────────────────────────────────────────────────
function SendModal({ wallet, token, onClose }: { wallet: WalletEntry; token: string; onClose: () => void }) {
  const { toast } = useToast();
  const { state: wc, connect, sendTransaction, hasMetaMask } = useWalletConnect();
  const [form, setForm] = useState({ to: "", amount: "", token: wallet.chain });
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // Currencies AYZEN actually watches deposits/withdrawals for on this
  // wallet's chain (native coin + any ERC-20s, e.g. USDT everywhere, ARB on
  // Arbitrum) — sourced live from GET /wallets/vault-chains so this never
  // drifts out of sync with the backend registry. Chains outside that
  // registry (SOL, BTC, TRX, OP, BASE, AVAX, ...) fall back to the old
  // freeform token field below.
  const [vaultChains, setVaultChains] = useState<VaultChain[]>([]);
  useEffect(() => { getVaultChains().then(setVaultChains).catch(() => {}); }, []);
  const currentVaultChain = vaultChains.find(c => c.chain === wallet.chain.toUpperCase());
  const currencyOptions = currentVaultChain
    ? [currentVaultChain.nativeSymbol, ...currentVaultChain.tokens.map(t => t.symbol)]
    : null;
  // Default the picker to the chain's native symbol once known (e.g. "POL"
  // for a MATIC-chain wallet, not the raw chain id) — only while the field
  // still holds its untouched initial value, so this never clobbers a pick.
  useEffect(() => {
    if (currentVaultChain && form.token === wallet.chain) {
      setForm(f => (f.token === wallet.chain ? { ...f, token: currentVaultChain.nativeSymbol } : f));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVaultChain]);

  const handleConnect = async () => {
    const addr = await connect();
    if (!addr) toast({ variant: "destructive", title: wc.error ?? "Wallet connection failed" });
  };

  const handleSend = async () => {
    if (!form.to.trim()) { toast({ variant: "destructive", title: "Enter recipient address" }); return; }
    if (!form.amount || parseFloat(form.amount) <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }
    setSending(true);

    // If wallet is connected via MetaMask, sign on-chain
    if (wc.isConnected && wc.address) {
      const hash = await sendTransaction(form.to.trim(), form.amount, wc.address);
      if (hash) {
        setTxHash(hash);
        // Log to backend
        await fetch(`${BASE}/api/wallets/${wallet.id}/send`, {
          method: "POST", headers,
          body: JSON.stringify({ to: form.to.trim(), amount: parseFloat(form.amount), token: form.token, txHash: hash }),
        }).catch(() => {});
        toast({ title: "✅ Transaction sent!", description: `TX: ${hash.slice(0, 20)}…` });
        setSending(false);
        return;
      } else {
        toast({ variant: "destructive", title: "Transaction rejected or failed" });
        setSending(false);
        return;
      }
    }

    // Fallback: log intent to backend
    try {
      const r = await fetch(`${BASE}/api/wallets/${wallet.id}/send`, {
        method: "POST", headers,
        body: JSON.stringify({ to: form.to.trim(), amount: parseFloat(form.amount), token: form.token }),
      });
      const d = await r.json();
      if (r.ok) {
        setTxHash("pending");
        toast({ title: "📤 Transaction queued", description: "Connect MetaMask to broadcast on-chain." });
      } else {
        toast({ variant: "destructive", title: d.error ?? "Send failed" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSending(false);
  };

  const info = chainInfo(wallet.chain);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-primary/20 rounded-xl w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-card-border">
          <div className="flex items-center gap-2">
            <Send className="w-4 h-4 text-primary" />
            <span className="font-mono font-bold text-sm">Send Transaction</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {txHash && txHash !== "pending" ? (
            <div className="text-center space-y-4 py-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <Check className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <div className="font-mono font-bold text-sm text-foreground">Transaction Sent!</div>
                <div className="font-mono text-xs text-muted-foreground mt-1">
                  {form.amount} {form.token} → {shortenAddr(form.to)}
                </div>
              </div>
              <a href={`${explorerUrl(form.to, wallet.chain).replace(/address.*/, `tx/${txHash}`)}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                <ExternalLink className="w-3 h-3" /> View on Explorer
              </a>
              <Button onClick={onClose} className="w-full font-mono text-xs">Close</Button>
            </div>
          ) : (
            <>
              {/* Wallet connect strip */}
              <div className={cn(
                "rounded-lg border px-3 py-2.5 flex items-center justify-between",
                wc.isConnected ? "border-emerald-500/20 bg-emerald-500/5" : "border-border bg-background"
              )}>
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">
                    {wc.isConnected ? "Connected Wallet" : "Sign with Wallet"}
                  </div>
                  <div className="font-mono text-xs text-foreground">
                    {wc.isConnected ? shortenAddr(wc.address ?? "") : hasMetaMask ? "MetaMask detected" : "No wallet detected"}
                  </div>
                  {wc.chainId && <div className="font-mono text-[9px] text-muted-foreground">Chain ID: {wc.chainId}</div>}
                </div>
                {!wc.isConnected ? (
                  <Button size="sm" onClick={handleConnect} disabled={wc.isConnecting || !hasMetaMask}
                    className="font-mono text-[10px] gap-1.5 h-7 px-3">
                    {wc.isConnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                    {hasMetaMask ? "Connect" : "Install MetaMask"}
                  </Button>
                ) : (
                  <div className="flex items-center gap-1 text-emerald-400">
                    <Check className="w-3.5 h-3.5" />
                    <span className="font-mono text-[10px]">Ready</span>
                  </div>
                )}
              </div>

              <div className="bg-background border border-card-border rounded-md px-3 py-2.5">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">From Wallet</div>
                <div className="font-mono text-xs font-bold text-foreground">{wallet.label}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{shortenAddr(wallet.address)}</div>
                {wallet.balanceUsd > 0 && (
                  <div className="font-mono text-[10px] text-primary mt-0.5">
                    {wallet.balance.toFixed(6)} {wallet.chain} (${wallet.balanceUsd.toFixed(2)})
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Recipient <span className="text-red-400">*</span>
                </label>
                <Input value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value.trim() }))}
                  placeholder={`${info.prefix}address...`}
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Amount <span className="text-red-400">*</span></label>
                  <Input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="0.0" min="0" step="any"
                    className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50" />
                </div>
                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Token</label>
                  {currencyOptions ? (
                    <Select value={form.token} onValueChange={v => setForm(f => ({ ...f, token: v }))}>
                      <SelectTrigger className="font-mono text-xs h-10 bg-input border-border focus:ring-primary/50">
                        <SelectValue placeholder={wallet.chain} />
                      </SelectTrigger>
                      <SelectContent>
                        {currencyOptions.map(sym => (
                          <SelectItem key={sym} value={sym} className="font-mono text-xs">{sym}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={form.token} onChange={e => setForm(f => ({ ...f, token: e.target.value.toUpperCase() }))}
                      placeholder={wallet.chain}
                      className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50" />
                  )}
                </div>
              </div>

              {!wc.isConnected && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2.5 flex items-start gap-2">
                  <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="font-mono text-[10px] text-amber-300/80">Connect MetaMask above to sign & broadcast on-chain. Otherwise the transaction will be queued.</p>
                </div>
              )}

              <Button onClick={handleSend} disabled={sending || !form.to.trim() || !form.amount} className="w-full font-mono text-xs gap-2">
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sending ? "Broadcasting..." : wc.isConnected ? `Sign & Send ${form.token || wallet.chain}` : `Queue Send`}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function UserWallets() {
  const { token } = useAuth();
  const { toast } = useToast();

  const [wallets, setWallets] = useState<WalletEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [phraseWallet, setPhraseWallet] = useState<WalletEntry | null>(null);
  const [sendWallet, setSendWallet] = useState<WalletEntry | null>(null);
  const [liveIndicator, setLiveIndicator] = useState(false);
  const [tokens, setTokens] = useState({ azn: 0, credits: 0, usdt: 0 });
  const [creatingBuiltin, setCreatingBuiltin] = useState(false);
  const [activeTab, setActiveTab] = useState<"wallets" | "nfts">("wallets");
  const [myNfts, setMyNfts] = useState<any[]>([]);
  const [nftsLoading, setNftsLoading] = useState(false);

  const [form, setForm] = useState({ address: "", chain: "ETH", label: "", notes: "", phrase: "", showPhraseField: false });
  const [adding, setAdding] = useState(false);
  const [activeWalletId, setActiveWalletId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Feature 3: EVM/SVM network type filter for Add Wallet panel
  const [networkType, setNetworkType] = useState<"all" | "evm" | "svm">("all");

  // Feature 3 & 4: Per-wallet expanded sub-tab + profile tokens (localStorage-persisted)
  const [walletSubTab, setWalletSubTab] = useState<Record<number, "details" | "profile" | "gas" | "health">>({});
  const [walletTokens, setWalletTokens] = useState<Record<number, Array<{ id: string; name: string; price: number; amount: number; blockchain: string }>>>(() => {
    try { return JSON.parse(localStorage.getItem("ayzen_wallet_tokens") ?? "{}"); } catch { return {}; }
  });
  const [addTokenForm, setAddTokenForm] = useState<Record<number, { name: string; price: string; amount: string; blockchain: string }>>({});

  const saveTokens = (next: typeof walletTokens) => {
    setWalletTokens(next);
    localStorage.setItem("ayzen_wallet_tokens", JSON.stringify(next));
  };

  const addToken = (walletId: number) => {
    const f = addTokenForm[walletId];
    if (!f?.name?.trim()) return;
    const token = { id: Date.now().toString(), name: f.name.trim(), price: parseFloat(f.price) || 0, amount: parseFloat(f.amount) || 0, blockchain: f.blockchain || "ETH" };
    saveTokens({ ...walletTokens, [walletId]: [...(walletTokens[walletId] ?? []), token] });
    setAddTokenForm(prev => ({ ...prev, [walletId]: { name: "", price: "", amount: "", blockchain: "" } }));
  };

  const removeToken = (walletId: number, tokenId: string) => {
    saveTokens({ ...walletTokens, [walletId]: (walletTokens[walletId] ?? []).filter(t => t.id !== tokenId) });
  };

  // EVM chains: all 0x-prefix chains. SVM: SOL.
  const EVM_CHAINS = new Set(["ETH", "BSC", "MATIC", "ARB", "OP", "BASE", "AVAX", "LINEA", "ZKSYNC", "SCROLL", "FTM"]);
  const SVM_CHAINS = new Set(["SOL"]);
  const GAS_WARNING_CHAINS = new Set(["BSC", "BASE", "MATIC", "ARB"]);

  const filteredAddChains = CHAINS.filter(c => {
    if (networkType === "evm") return EVM_CHAINS.has(c.value);
    if (networkType === "svm") return SVM_CHAINS.has(c.value);
    return true;
  });

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const sseRef = useRef<EventSource | null>(null);

  const fetchWallets = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/wallets`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setWallets(await r.json());
    } catch { }
    setLoading(false);
  }, [token]);

  const fetchTokens = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE}/api/wallets/tokens`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setTokens(await r.json());
    } catch { }
  }, [token]);

  const fetchNfts = useCallback(async () => {
    if (!token) return;
    setNftsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/nft-subscriptions/my-nfts`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setMyNfts(await r.json());
    } catch { }
    setNftsLoading(false);
  }, [token]);

  useEffect(() => {
    fetchWallets();
    fetchTokens();
    // Auto-refresh every 30s
    const interval = setInterval(() => { fetchWallets(); fetchTokens(); }, 30000);
    return () => clearInterval(interval);
  }, [fetchWallets, fetchTokens]);

  const handleCreateBuiltin = async () => {
    setCreatingBuiltin(true);
    try {
      const r = await fetch(`${BASE}/api/wallets/builtin/create`, { method: "POST", headers });
      const d = await r.json();
      if (r.ok) {
        toast({ title: "🎉 AYZEN Built-in Wallet created!", description: "Your personal software wallet is ready." });
        await fetchWallets();
      } else {
        toast({ variant: "destructive", title: d.error ?? "Failed to create wallet" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setCreatingBuiltin(false);
  };

  // Real-time SSE — auto-reconnect with exponential backoff
  useEffect(() => {
    if (!token) return;
    let mounted = true;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!mounted) return;
      const url = `${BASE}/api/events?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      sseRef.current = es;

      es.onopen = () => { retryCount = 0; };

      es.addEventListener("wallets_updated", () => {
        setLiveIndicator(true);
        setTimeout(() => setLiveIndicator(false), 2000);
        fetchWallets();
      });

      es.onerror = () => {
        es.close();
        sseRef.current = null;
        if (mounted) {
          const delay = Math.min(1000 * 2 ** Math.min(retryCount++, 5), 30000);
          retryTimer = setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      sseRef.current?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [token, fetchWallets]);

  const copyAddr = (id: number, addr: string) => {
    navigator.clipboard.writeText(addr).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const handleAdd = async () => {
    if (!form.address.trim()) { toast({ variant: "destructive", title: "Enter a wallet address" }); return; }
    setAdding(true);
    try {
      const r = await fetch(`${BASE}/api/wallets`, {
        method: "POST", headers,
        body: JSON.stringify({ address: form.address.trim(), chain: form.chain, label: form.label.trim() || undefined, notes: form.notes.trim() || undefined }),
      });
      const data = await r.json();
      if (r.ok) {
        toast({ title: "✅ Wallet added", description: `${form.chain} · ${shortenAddr(form.address)}` });
        setForm({ address: "", chain: "ETH", label: "", notes: "", phrase: "", showPhraseField: false });
        setShowAdd(false);
        await fetchWallets();
      } else {
        toast({ variant: "destructive", title: data.error ?? "Failed to add wallet" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setAdding(false);
  };

  const handleSync = async (id: number) => {
    setSyncing(id);
    try {
      const r = await fetch(`${BASE}/api/wallets/${id}/sync`, { method: "POST", headers });
      if (r.ok) {
        const updated = await r.json();
        setWallets(ws => ws.map(w => w.id === id ? updated : w));
        toast({ title: "Wallet synced" });
      } else {
        toast({ variant: "destructive", title: "Sync failed" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSyncing(null);
  };

  const handleSetPrimary = async (id: number) => {
    try {
      const r = await fetch(`${BASE}/api/wallets/${id}`, {
        method: "PATCH", headers, body: JSON.stringify({ isPrimary: true }),
      });
      if (r.ok) { await fetchWallets(); toast({ title: "Primary wallet updated" }); }
    } catch { }
  };

  const handleToggleFinanceSync = async (id: number, next: boolean) => {
    setWallets(ws => ws.map(w => w.id === id ? { ...w, autoFinanceSync: next } : w)); // optimistic
    try {
      const r = await fetch(`${BASE}/api/wallets/${id}`, {
        method: "PATCH", headers, body: JSON.stringify({ autoFinanceSync: next }),
      });
      if (r.ok) {
        toast({ title: next ? "Finance auto-sync enabled" : "Finance auto-sync disabled", description: next ? "Deposits and withdrawals on this wallet will post to Finance automatically." : "This wallet's activity will no longer post to Finance." });
      } else {
        setWallets(ws => ws.map(w => w.id === id ? { ...w, autoFinanceSync: !next } : w)); // revert
        toast({ variant: "destructive", title: "Failed to update" });
      }
    } catch {
      setWallets(ws => ws.map(w => w.id === id ? { ...w, autoFinanceSync: !next } : w));
      toast({ variant: "destructive", title: "Connection error" });
    }
  };

  const handleDelete = async (id: number) => {
    setDeleting(id);
    try {
      const r = await fetch(`${BASE}/api/wallets/${id}`, { method: "DELETE", headers });
      if (r.ok) {
        setWallets(ws => ws.filter(w => w.id !== id));
        toast({ title: "Wallet removed" });
      } else {
        toast({ variant: "destructive", title: "Failed to remove" });
      }
    } catch { }
    setDeleting(null);
  };

  const totalUsd = wallets.reduce((s, w) => s + (w.balanceUsd ?? 0), 0);
  const chains = [...new Set(wallets.map(w => w.chain))];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {phraseWallet && <PhraseModal wallet={phraseWallet} token={token ?? ""} onClose={() => setPhraseWallet(null)} />}
      {sendWallet && <SendModal wallet={sendWallet} token={token ?? ""} onClose={() => setSendWallet(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Wallet className="w-6 h-6 text-primary" /> My Wallets
            {liveIndicator && (
              <span className="flex items-center gap-1 text-[9px] font-mono text-primary bg-primary/10 border border-primary/20 rounded-full px-2 py-0.5 animate-pulse">
                <Zap className="w-2.5 h-2.5" /> LIVE
              </span>
            )}
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            {wallets.length} wallet{wallets.length !== 1 ? "s" : ""} · {chains.length} chain{chains.length !== 1 ? "s" : ""}
            {totalUsd > 0 && <> · <span className="text-primary">${totalUsd.toFixed(2)} USD</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!wallets.some(w => w.label?.includes("AYZEN Built-in")) && (
            <Button variant="outline" onClick={handleCreateBuiltin} disabled={creatingBuiltin} className="font-mono text-xs gap-2 border-primary/30 text-primary hover:bg-primary/10">
              {creatingBuiltin ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Built-in Wallet
            </Button>
          )}
          <Button onClick={() => setShowAdd(s => !s)} className="font-mono text-xs gap-2">
            <Plus className="w-4 h-4" />
            Add Wallet
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b border-border/40">
        {(["wallets", "nfts"] as const).map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); if (tab === "nfts" && myNfts.length === 0) fetchNfts(); }}
            className={cn(
              "flex items-center gap-1.5 px-5 py-2 text-[11px] font-mono uppercase tracking-wider border-b-2 transition-all -mb-px",
              activeTab === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}>
            {tab === "wallets" ? <Wallet className="w-3 h-3" /> : <Gem className="w-3 h-3" />}
            {tab === "wallets" ? `Wallets (${wallets.length})` : "NFTs"}
          </button>
        ))}
      </div>

      {/* AYZEN Token Balance Banner */}
      {activeTab === "wallets" && <>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "AZN Balance", value: tokens.azn.toFixed(2), suffix: "AZN", color: "text-cyan-400", bg: "bg-cyan-500/5", border: "border-cyan-500/20", icon: "⚡" },
          { label: "USDT Balance", value: tokens.usdt.toFixed(2), suffix: "USDT", color: "text-emerald-400", bg: "bg-emerald-500/5", border: "border-emerald-500/20", icon: "💵" },
          { label: "Credits", value: tokens.credits.toString(), suffix: "CR", color: "text-violet-400", bg: "bg-violet-500/5", border: "border-violet-500/20", icon: "🎯" },
        ].map(t => (
          <div key={t.label} className={`${t.bg} border ${t.border} rounded-xl p-4 flex flex-col gap-1`}>
            <div className="flex items-center gap-1.5">
              <span className="text-sm">{t.icon}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{t.label}</span>
            </div>
            <div className={`font-mono text-xl font-bold ${t.color}`}>{t.value}</div>
            <div className="font-mono text-[10px] text-muted-foreground/50">{t.suffix} · Auto-refreshes every 30s</div>
          </div>
        ))}
      </div>

      {/* Stats row */}
      {wallets.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Total Wallets", value: wallets.length.toString() },
            { label: "Total USD", value: `$${totalUsd.toFixed(2)}` },
            { label: "Chains", value: chains.join(", ") || "—" },
          ].map(({ label, value }) => (
            <div key={label} className="bg-card border border-card-border rounded-lg px-4 py-3">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
              <div className="font-mono font-bold text-sm text-primary truncate">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Add Wallet Panel */}
      {showAdd && (
        <div className="bg-card border border-primary/20 rounded-lg overflow-hidden">
          <div className="bg-primary/5 border-b border-primary/15 px-5 py-4 flex items-center justify-between">
            <div className="font-mono font-bold text-sm text-primary">+ New Wallet</div>
            <button onClick={() => setShowAdd(false)} className="text-muted-foreground hover:text-foreground text-xs font-mono">✕ Cancel</button>
          </div>
          <div className="px-5 py-5 space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Network / Chain</label>
                {/* EVM / SVM / All filter toggle */}
                <div className="flex gap-0.5 p-0.5 bg-muted/20 rounded-md border border-border/30">
                  {(["all", "evm", "svm"] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => { setNetworkType(t); if ((t === "svm" && EVM_CHAINS.has(form.chain)) || (t === "evm" && SVM_CHAINS.has(form.chain))) setForm(f => ({ ...f, chain: t === "evm" ? "ETH" : "SOL" })); }}
                      className={cn(
                        "px-2 py-0.5 rounded font-mono text-[9px] uppercase tracking-wider transition-all",
                        networkType === t ? "bg-card text-primary font-bold shadow-sm border border-border/40" : "text-muted-foreground/50 hover:text-muted-foreground"
                      )}
                    >{t === "all" ? "All" : t === "evm" ? "EVM" : "SVM"}</button>
                  ))}
                </div>
              </div>
              {networkType !== "all" && (
                <p className="font-mono text-[9px] text-muted-foreground/50">
                  {networkType === "evm" ? "EVM = Ethereum-compatible (0x address)" : "SVM = Solana Virtual Machine"}
                </p>
              )}
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                {filteredAddChains.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setForm(f => ({ ...f, chain: c.value }))}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-md border px-2 py-2 transition-all font-mono text-[9px] uppercase tracking-wider",
                      form.chain === c.value
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-muted/20 text-muted-foreground hover:border-primary/20 hover:bg-primary/5"
                    )}
                  >
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} />
                    {c.value}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Wallet Address <span className="text-red-400">*</span>
                </label>
                <Input
                  value={form.address}
                  onChange={e => setForm(f => ({ ...f, address: e.target.value.trim() }))}
                  placeholder={chainInfo(form.chain).prefix + "address..."}
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                  onKeyDown={e => e.key === "Enter" && handleAdd()}
                />
              </div>
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Label (optional)</label>
                <Input
                  value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder={`My ${chainInfo(form.chain).label} Wallet`}
                  className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
                  onKeyDown={e => e.key === "Enter" && handleAdd()}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Notes (optional)</label>
              <Input
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. Main farming wallet, Hardware wallet..."
                className="font-mono text-xs h-10 bg-input border-border focus-visible:ring-primary/50"
              />
            </div>

            <Button onClick={handleAdd} disabled={adding || !form.address.trim()} className="font-mono text-xs gap-2">
              {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {adding ? "Adding..." : "Add Wallet"}
            </Button>
          </div>
        </div>
      )}

      {/* Wallet List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-card border border-card-border rounded-lg h-20 animate-pulse" />
          ))}
        </div>
      ) : wallets.length === 0 ? (
        <div className="bg-card border border-card-border rounded-lg px-6 py-12 text-center">
          <Wallet className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground">No wallets added yet</p>
          <p className="font-mono text-xs text-muted-foreground/50 mt-1">Click "Add Wallet" to track your on-chain activity</p>
          <Button onClick={() => setShowAdd(true)} className="font-mono text-xs gap-2 mt-5">
            <Plus className="w-3.5 h-3.5" /> Add Your First Wallet
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {wallets.map(wallet => {
            const info = chainInfo(wallet.chain);
            const isExpanded = expandedId === wallet.id;
            const isSyncing = syncing === wallet.id;
            const isDeleting = deleting === wallet.id;
            const copied = copiedId === wallet.id;

            return (
              <div key={wallet.id} className={cn(
                "bg-card border rounded-lg overflow-hidden transition-all",
                wallet.isPrimary ? "border-primary/30" : "border-card-border"
              )}>
                <div className="px-4 py-4">
                  <div className="flex items-center gap-3">
                    {/* Chain dot */}
                    <div className="w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0"
                      style={{ borderColor: info.color + "40", background: info.color + "15" }}>
                      <div className="w-3 h-3 rounded-full" style={{ background: info.color }} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-sm text-foreground">{wallet.label}</span>
                        <Badge variant="outline" className="font-mono text-[9px] uppercase px-1.5 py-0" style={{ color: info.color, borderColor: info.color + "40" }}>
                          {info.label}
                        </Badge>
                        {wallet.isPrimary && (
                          <Badge className="font-mono text-[9px] uppercase px-1.5 py-0 bg-primary/10 text-primary border-primary/20">
                            ★ Primary
                          </Badge>
                        )}
                        {wallet.encryptedPhrase && (
                          <Badge className="font-mono text-[9px] uppercase px-1.5 py-0 bg-amber-500/10 text-amber-400 border-amber-500/20">
                            🔒 Phrase
                          </Badge>
                        )}
                        <HealthScoreBadge checks={WALLET_HEALTH_CHECKS} entry={wallet} />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-xs text-muted-foreground">{shortenAddr(wallet.address)}</span>
                        <button onClick={() => copyAddr(wallet.id, wallet.address)} className="text-muted-foreground hover:text-primary transition-colors">
                          {copied ? <Check className="w-3 h-3 text-primary" /> : <Copy className="w-3 h-3" />}
                        </button>
                        <a href={explorerUrl(wallet.address, wallet.chain)} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>

                    {/* Balance */}
                    <div className="text-right flex-shrink-0">
                      {wallet.balanceUsd > 0 ? (
                        <>
                          <div className="font-mono font-bold text-sm text-primary">${wallet.balanceUsd.toFixed(2)}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{wallet.balance.toFixed(4)} {wallet.chain}</div>
                        </>
                      ) : (
                        <div className="font-mono text-[10px] text-muted-foreground/50">Not synced</div>
                      )}
                    </div>

                    {/* Quick actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => setSendWallet(wallet)}
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30 flex items-center justify-center transition-all"
                        title="Send"
                      >
                        <Send className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handleSync(wallet.id)}
                        disabled={isSyncing}
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30 flex items-center justify-center transition-all"
                        title="Sync balance"
                      >
                        <RefreshCw className={cn("w-3.5 h-3.5", isSyncing && "animate-spin")} />
                      </button>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : wallet.id)}
                        className="w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-border/80 flex items-center justify-center transition-all"
                      >
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded details — with sub-tabs: Details | Profile | Gas */}
                {isExpanded && (() => {
                  const subTab = walletSubTab[wallet.id] ?? "details";
                  const setSubTab = (t: "details" | "profile" | "gas" | "health") => setWalletSubTab(prev => ({ ...prev, [wallet.id]: t }));
                  const tokens = walletTokens[wallet.id] ?? [];
                  const tokenForm = addTokenForm[wallet.id] ?? { name: "", price: "", amount: "", blockchain: "" };
                  const isWarning = GAS_WARNING_CHAINS.has(wallet.chain) && wallet.balanceUsd < 0.05;

                  return (
                    <div className="border-t border-card-border bg-muted/10">
                      {/* Sub-tab bar */}
                      <div className="flex items-center gap-0 border-b border-border/30 px-4">
                        {(["details", "profile", "gas", "health"] as const).map(t => (
                          <button
                            key={t}
                            onClick={() => setSubTab(t)}
                            className={cn(
                              "px-3 py-2 font-mono text-[10px] uppercase tracking-wider border-b-2 -mb-px transition-all flex items-center gap-1",
                              subTab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground/50 hover:text-muted-foreground"
                            )}
                          >
                            {t === "gas" && isWarning && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
                            {t}
                          </button>
                        ))}
                      </div>

                      <div className="px-4 py-4 space-y-4">
                        {/* ── Details sub-tab ── */}
                        {subTab === "details" && <>
                          <div className="grid grid-cols-3 gap-3">
                            {[
                              { label: "Balance", value: wallet.balance > 0 ? `${wallet.balance.toFixed(6)} ${wallet.chain}` : "—" },
                              { label: "USD Value", value: wallet.balanceUsd > 0 ? `$${wallet.balanceUsd.toFixed(2)}` : "—" },
                              { label: "Transactions", value: wallet.txCount > 0 ? wallet.txCount.toLocaleString() : "—" },
                            ].map(({ label, value }) => (
                              <div key={label} className="bg-background border border-card-border rounded-md px-3 py-2">
                                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">{label}</div>
                                <div className="font-mono text-xs font-bold text-foreground">{value}</div>
                              </div>
                            ))}
                          </div>
                          <div className="bg-background border border-card-border rounded-md px-3 py-2">
                            <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Full Address</div>
                            <div className="font-mono text-[11px] text-foreground break-all">{wallet.address}</div>
                          </div>
                          {wallet.notes && (
                            <div className="bg-background border border-card-border rounded-md px-3 py-2">
                              <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Notes</div>
                              <div className="font-mono text-[11px] text-foreground">{wallet.notes}</div>
                            </div>
                          )}
                          {wallet.lastSyncedAt && (
                            <p className="text-[9px] font-mono text-muted-foreground/40">
                              Last synced: {new Date(wallet.lastSyncedAt).toLocaleString()}
                            </p>
                          )}
                          <div className="flex gap-2 flex-wrap">
                            {!wallet.isPrimary && (
                              <Button variant="outline" size="sm" onClick={() => handleSetPrimary(wallet.id)} className="font-mono text-[10px] gap-1.5 h-7 px-3 border-primary/20 text-primary hover:bg-primary/10">
                                <Star className="w-3 h-3" /> Set Primary
                              </Button>
                            )}
                            <Button variant="outline" size="sm" onClick={() => handleSync(wallet.id)} disabled={isSyncing} className="font-mono text-[10px] gap-1.5 h-7 px-3">
                              <RefreshCw className={cn("w-3 h-3", isSyncing && "animate-spin")} />
                              {isSyncing ? "Syncing..." : "Sync Now"}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setSendWallet(wallet)} className="font-mono text-[10px] gap-1.5 h-7 px-3 border-primary/20 text-primary hover:bg-primary/10">
                              <Send className="w-3 h-3" /> Send
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setPhraseWallet(wallet)} className="font-mono text-[10px] gap-1.5 h-7 px-3 border-amber-500/20 text-amber-400 hover:bg-amber-500/10">
                              <Key className="w-3 h-3" /> {wallet.encryptedPhrase ? "View Phrase" : "Save Phrase"}
                            </Button>
                            <a href={explorerUrl(wallet.address, wallet.chain)} target="_blank" rel="noopener noreferrer">
                              <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1.5 h-7 px-3">
                                <ExternalLink className="w-3 h-3" /> Explorer
                              </Button>
                            </a>
                            <Button variant="outline" size="sm" onClick={() => handleToggleFinanceSync(wallet.id, !wallet.autoFinanceSync)}
                              className={cn("font-mono text-[10px] gap-1.5 h-7 px-3",
                                wallet.autoFinanceSync ? "border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10" : "border-card-border text-muted-foreground")}>
                              <Landmark className="w-3 h-3" /> {wallet.autoFinanceSync ? "Finance Sync: On" : "Finance Sync: Off"}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => handleDelete(wallet.id)} disabled={isDeleting}
                              className="font-mono text-[10px] gap-1.5 h-7 px-3 border-red-500/20 text-red-400 hover:bg-red-500/10 ml-auto">
                              {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                              {isDeleting ? "Removing..." : "Remove"}
                            </Button>
                          </div>
                        </>}

                        {/* ── Profile sub-tab — token holdings ── */}
                        {subTab === "profile" && (
                          <div className="space-y-3">
                            <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">Token Holdings · stored locally</div>

                            {/* Token list */}
                            {tokens.length === 0 ? (
                              <div className="py-6 text-center border border-dashed border-border/30 rounded-lg">
                                <div className="font-mono text-[10px] text-muted-foreground/40">No tokens added yet</div>
                              </div>
                            ) : (
                              <div className="space-y-1.5">
                                <div className="grid grid-cols-12 gap-2 px-2 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/40">
                                  <span className="col-span-4">Token</span>
                                  <span className="col-span-3 text-right">Price</span>
                                  <span className="col-span-3 text-right">Amount</span>
                                  <span className="col-span-2" />
                                </div>
                                {tokens.map(t => (
                                  <div key={t.id} className="grid grid-cols-12 gap-2 items-center bg-background border border-card-border rounded-md px-2 py-1.5">
                                    <div className="col-span-4">
                                      <div className="font-mono text-xs font-bold text-foreground">{t.name}</div>
                                      <div className="font-mono text-[9px] text-muted-foreground/50">{t.blockchain}</div>
                                    </div>
                                    <div className="col-span-3 text-right font-mono text-[11px] text-emerald-400">${t.price.toFixed(4)}</div>
                                    <div className="col-span-3 text-right font-mono text-[11px] text-foreground">{t.amount}</div>
                                    <div className="col-span-2 text-right">
                                      <button onClick={() => removeToken(wallet.id, t.id)} className="text-muted-foreground/30 hover:text-red-400 transition-colors p-0.5">
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                {tokens.length > 0 && (
                                  <div className="text-right font-mono text-[10px] text-primary pt-1">
                                    Total: ${tokens.reduce((s, t) => s + t.price * t.amount, 0).toFixed(2)}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Add token form */}
                            <div className="border border-border/30 rounded-lg p-3 space-y-2">
                              <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">Add Token</div>
                              <div className="grid grid-cols-2 gap-2">
                                <input
                                  value={tokenForm.name}
                                  onChange={e => setAddTokenForm(p => ({ ...p, [wallet.id]: { ...tokenForm, name: e.target.value } }))}
                                  placeholder="Token name (e.g. USDC)"
                                  className="font-mono text-[11px] h-8 px-2 rounded-md bg-input border border-border/50 focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/30"
                                />
                                <input
                                  value={tokenForm.blockchain}
                                  onChange={e => setAddTokenForm(p => ({ ...p, [wallet.id]: { ...tokenForm, blockchain: e.target.value } }))}
                                  placeholder="Chain (e.g. ETH, BSC)"
                                  className="font-mono text-[11px] h-8 px-2 rounded-md bg-input border border-border/50 focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/30"
                                />
                                <input
                                  value={tokenForm.price}
                                  type="number"
                                  min={0}
                                  onChange={e => setAddTokenForm(p => ({ ...p, [wallet.id]: { ...tokenForm, price: e.target.value } }))}
                                  placeholder="Price (USD)"
                                  className="font-mono text-[11px] h-8 px-2 rounded-md bg-input border border-border/50 focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/30"
                                />
                                <input
                                  value={tokenForm.amount}
                                  type="number"
                                  min={0}
                                  onChange={e => setAddTokenForm(p => ({ ...p, [wallet.id]: { ...tokenForm, amount: e.target.value } }))}
                                  placeholder="Amount"
                                  className="font-mono text-[11px] h-8 px-2 rounded-md bg-input border border-border/50 focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/30"
                                />
                              </div>
                              <Button size="sm" onClick={() => addToken(wallet.id)} disabled={!tokenForm.name?.trim()} className="font-mono text-[10px] gap-1.5 h-7">
                                <Plus className="w-3 h-3" /> Add Token
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* ── Gas sub-tab ── */}
                        {subTab === "gas" && (
                          <div className="space-y-3">
                            <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">Gas Balance · Native Token</div>

                            {/* Current chain gas card */}
                            <div className={cn(
                              "rounded-lg border p-4 space-y-2",
                              isWarning ? "border-amber-400/40 bg-amber-400/5" : "border-card-border bg-background"
                            )}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <div className="w-3 h-3 rounded-full" style={{ background: info.color }} />
                                  <span className="font-mono font-bold text-sm text-foreground">{info.label}</span>
                                  <span className="font-mono text-[9px] text-muted-foreground/50 uppercase">{wallet.chain}</span>
                                </div>
                                {isWarning && (
                                  <span className="flex items-center gap-1 font-mono text-[9px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-full px-2 py-0.5">
                                    <AlertCircle className="w-3 h-3" /> LOW GAS
                                  </span>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase mb-0.5">Native Balance</div>
                                  <div className="font-mono font-bold text-foreground">{wallet.balance > 0 ? `${wallet.balance.toFixed(6)} ${wallet.chain}` : "Not synced"}</div>
                                </div>
                                <div>
                                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase mb-0.5">USD Value</div>
                                  <div className={cn("font-mono font-bold", wallet.balanceUsd > 0 ? (isWarning ? "text-amber-400" : "text-emerald-400") : "text-muted-foreground/50")}>
                                    {wallet.balanceUsd > 0 ? `$${wallet.balanceUsd.toFixed(4)}` : "—"}
                                  </div>
                                </div>
                              </div>
                              {isWarning && (
                                <div className="flex items-start gap-2 pt-1 border-t border-amber-400/20">
                                  <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                                  <p className="font-mono text-[10px] text-amber-400/80">
                                    Balance below $0.05 — transactions on {info.label} may fail. Top up {wallet.chain} to continue farming.
                                  </p>
                                </div>
                              )}
                            </div>

                            {/* Warning thresholds info */}
                            <div className="border border-border/20 rounded-lg p-3 space-y-1.5">
                              <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">Warning Threshold — $0.05</div>
                              <div className="grid grid-cols-2 gap-1.5">
                                {["BSC", "BASE", "MATIC", "ARB"].map(c => {
                                  const ci = chainInfo(c);
                                  const isThisChain = wallet.chain === c;
                                  return (
                                    <div key={c} className={cn(
                                      "flex items-center gap-2 px-2 py-1.5 rounded-md font-mono text-[10px]",
                                      isThisChain ? (isWarning ? "bg-amber-400/10 text-amber-400 border border-amber-400/20" : "bg-emerald-400/5 text-emerald-400 border border-emerald-400/20") : "text-muted-foreground/40"
                                    )}>
                                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ci.color }} />
                                      <span>{ci.label}</span>
                                      {isThisChain && <span className="ml-auto text-[9px]">{wallet.balanceUsd > 0 ? `$${wallet.balanceUsd.toFixed(3)}` : "—"}</span>}
                                    </div>
                                  );
                                })}
                              </div>
                              <p className="font-mono text-[9px] text-muted-foreground/30 pt-1">
                                Wallets on these chains are monitored. Warnings fire when native token balance drops below $0.05.
                              </p>
                            </div>

                            <Button variant="outline" size="sm" onClick={() => handleSync(wallet.id)} disabled={isSyncing} className="font-mono text-[10px] gap-1.5 h-7 px-3">
                              <RefreshCw className={cn("w-3 h-3", isSyncing && "animate-spin")} />
                              {isSyncing ? "Syncing..." : "Refresh Balance"}
                            </Button>
                          </div>
                        )}

                        {/* ── Health sub-tab — same checklist pattern as Entity/KYC Health ── */}
                        {subTab === "health" && (
                          <HealthChecklistCard title="Wallet Health" checks={WALLET_HEALTH_CHECKS} entry={wallet} />
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* Security note */}
      <div className="flex items-start gap-2 text-[10px] font-mono text-muted-foreground/40">
        <Shield className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>Public addresses are tracked for activity monitoring. Seed phrases are encrypted with AES-256-CBC before storage.</span>
      </div>
      </>}

      {/* NFT Tab */}
      {activeTab === "nfts" && (
        <div className="space-y-4">
          {nftsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : myNfts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <Gem className="w-10 h-10 text-muted-foreground/30" />
              <div className="font-mono text-sm text-muted-foreground">No NFTs yet</div>
              <p className="font-mono text-[11px] text-muted-foreground/50">Mint NFT passes or earn them through the platform.</p>
              <Button size="sm" variant="outline" onClick={fetchNfts} className="font-mono text-xs gap-1.5">
                <RefreshCw className="w-3 h-3" /> Refresh
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-muted-foreground">{myNfts.length} NFT{myNfts.length !== 1 ? "s" : ""} owned</span>
                <Button size="sm" variant="ghost" onClick={fetchNfts} className="font-mono text-xs gap-1 h-7">
                  <RefreshCw className="w-3 h-3" /> Refresh
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {myNfts.map((nft: any) => {
                  const planColor: Record<string, string> = {
                    pro: "text-cyan-400 border-cyan-500/30 bg-cyan-500/5",
                    enterprise: "text-amber-400 border-amber-500/30 bg-amber-500/5",
                    lifetime_pro: "text-violet-400 border-violet-500/30 bg-violet-500/5",
                    lifetime_enterprise: "text-rose-400 border-rose-500/30 bg-rose-500/5",
                    username: "text-emerald-400 border-emerald-500/30 bg-emerald-500/5",
                  };
                  const cls = planColor[nft.plan] ?? "text-primary border-primary/30 bg-primary/5";
                  return (
                    <div key={nft.id} className={cn("border rounded-xl p-4 space-y-2", cls)}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Gem className="w-4 h-4" />
                          <span className="font-mono font-bold text-xs uppercase">{nft.plan.replace(/_/g, " ")}</span>
                        </div>
                        {nft.is_listed && (
                          <Badge variant="outline" className="text-[9px] font-mono border-amber-500/30 text-amber-400">Listed</Badge>
                        )}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground/70 truncate">{nft.token_id}</div>
                      {nft.badge_name && (
                        <div className="font-mono text-[10px] text-muted-foreground/60">Badge: {nft.badge_name}</div>
                      )}
                      <div className="font-mono text-[10px] text-muted-foreground/50">
                        {nft.expires_at
                          ? `Expires: ${new Date(nft.expires_at).toLocaleDateString()}`
                          : nft.nft_type === "username" ? "Permanent collectible" : "No expiry"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
