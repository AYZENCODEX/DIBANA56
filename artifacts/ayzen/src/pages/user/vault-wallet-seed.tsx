import { useState, useMemo, useEffect, useRef } from "react";
import { useListVaultEntries, customFetch, ApiError } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  Shield, Eye, EyeOff, Copy, Check, Save,
  Wallet, Loader2, AlertTriangle, Zap, Link as LinkIcon,
  CheckCircle2, ChevronDown, ArrowLeftRight, LayoutGrid, Settings2, KeyRound, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useWalletConnect } from "@/hooks/use-wallet-connect";
import { getVaultChains, type VaultChain } from "@/lib/vault-chains-api";
import { EntityPinGate } from "@/components/vault/entity-pin-gate";
import { PinInput } from "@/components/vault/pin-input";
import { verifyPin, getVaultSecurityStatus } from "@/lib/vault-security-api";
import { getVaultGasOverview, type VaultGasOverview, type EntityGasSummary } from "@/lib/gas-health-api";
import { GasRiskBadge } from "@/components/vault/gas-risk-badge";
import { GasChainRow } from "@/components/vault/gas-chain-row";

type EntryAny = any;

// Persists which vault wallet entity is "active" for the Overview switcher.
// Purely a client-side UI selection — no backend field for this exists.
const ACTIVE_WALLET_KEY = "ayzen_active_wallet_entity_id";

function getWallets(entry: EntryAny): string[] {
  return Array.isArray(entry.walletAddresses)
    ? entry.walletAddresses
    : typeof entry.walletAddresses === "string" && entry.walletAddresses
      ? entry.walletAddresses.split("\n").map((s: string) => s.trim()).filter(Boolean)
      : [];
}

// No chain metadata is stored per address today — infer EVM vs SVM from the
// address shape itself. "Unknown" covers anything that matches neither.
function detectChainType(address: string | undefined): "EVM" | "SVM" | "Unknown" {
  if (!address) return "Unknown";
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return "EVM";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "SVM";
  return "Unknown";
}

function ChainBadge({ address }: { address: string | undefined }) {
  const chain = detectChainType(address);
  return (
    <span
      className={cn(
        "font-mono text-[8px] uppercase px-1.5 py-0.5 rounded border flex-shrink-0",
        chain === "EVM" && "text-cyan-400 border-cyan-400/20 bg-cyan-400/10",
        chain === "SVM" && "text-violet-400 border-violet-400/20 bg-violet-400/10",
        chain === "Unknown" && "text-muted-foreground/50 border-border/20"
      )}
    >
      {chain}
    </span>
  );
}

// ── Reveal guard — a second, per-action check on top of the page-level
// EntityPinGate below. Getting into this page once per session (the gate)
// is not the same as being allowed to decrypt a specific seed phrase — this
// re-asks the entity PIN every single time "Reveal" is pressed, so a wallet
// left open on-screen (or a shared/unattended session) still can't dump a
// seed phrase without the PIN again. If no entity PIN has been set at all,
// it falls through immediately — same "nothing to gate on" rule the page
// gate itself uses.
function useRevealGuard() {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // undefined = user cancelled · null = no entity PIN set, nothing to gate ·
  // string = the reveal token to send with the /seed request.
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
            Re-enter your entity PIN — required every time a seed phrase is decrypted.
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

function SeedPhraseCard({ entry }: { entry: EntryAny }) {
  const [seed, setSeed] = useState("");
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const { toast } = useToast();
  const { requireReauth, dialog: pinDialog } = useRevealGuard();

  // ── Leak prevention around the decrypted phrase ─────────────────────────
  // Once decrypted into JS state, a phrase left on-screen indefinitely (or
  // sitting on the clipboard) is its own leak surface, separate from the
  // PIN/reveal-token gate above. So: auto-clear it from memory a short while
  // after reveal, clear it immediately if the tab is hidden or the window
  // loses focus (walked away / alt-tabbed), and wipe the clipboard a little
  // after a copy instead of leaving it there indefinitely.
  const AUTO_HIDE_MS = 25_000;
  const CLIPBOARD_WIPE_MS = 20_000;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearRevealed = () => {
    setRevealedSeed(null);
    setShown(false);
    setSecondsLeft(null);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  };

  const armAutoHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setSecondsLeft(Math.ceil(AUTO_HIDE_MS / 1000));
    countdownRef.current = setInterval(() => {
      setSecondsLeft(s => (s && s > 1 ? s - 1 : 0));
    }, 1000);
    hideTimerRef.current = setTimeout(clearRevealed, AUTO_HIDE_MS);
  };

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) clearRevealed(); };
    const onBlur = () => clearRevealed();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleClipboardWipe = (copiedValue: string) => {
    setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText();
        if (current === copiedValue) await navigator.clipboard.writeText("");
      } catch {
        // Clipboard read denied/unsupported — best-effort only, not fatal.
      }
    }, CLIPBOARD_WIPE_MS);
  };

  const handleSave = async () => {
    const words = seed.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24 && !seed.trim().startsWith("0x")) {
      toast({ variant: "destructive", title: "Invalid format", description: "Expected 12/24 seed words or a 0x private key" });
      return;
    }
    setSaving(true);
    try {
      await customFetch(`/vault/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ seedPhrase: seed.trim() }),
      });
      toast({ title: "Seed phrase saved", description: "Encrypted and stored securely" });
      entry.hasSeedPhrase = true;
      setSeed("");
    } catch {
      toast({ variant: "destructive", title: "Failed to save seed phrase" });
    } finally { setSaving(false); }
  };

  const handleReveal = async () => {
    // undefined = user cancelled the PIN prompt · null = no entity PIN set
    // (nothing to gate) · string = the single-use reveal token to send.
    const outcome = await requireReauth();
    if (outcome === undefined) return;
    setRevealing(true);
    try {
      const headers: Record<string, string> = outcome ? { "x-reveal-token": outcome } : {};
      const d = await customFetch<{ seedPhrase: string }>(`/vault/${entry.id}/seed`, { headers });
      setRevealedSeed(d.seedPhrase);
      setShown(true);
      armAutoHide();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && (err.data as any)?.code === "REVEAL_TOKEN_REQUIRED") {
        toast({ variant: "destructive", title: "PIN check expired", description: "Press Reveal again to re-verify." });
      } else if (err instanceof ApiError && err.status === 429) {
        toast({ variant: "destructive", title: "Too many attempts", description: (err.data as any)?.solution ?? "Try again shortly." });
      } else {
        toast({ variant: "destructive", title: "Failed to decrypt seed phrase" });
      }
    } finally { setRevealing(false); }
  };

  const handleCopy = async () => {
    const val = revealedSeed ?? seed;
    if (!val) return;
    await navigator.clipboard.writeText(val);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    scheduleClipboardWipe(val);
  };

  const wallets = getWallets(entry);

  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3 hover:border-primary/20 transition-all">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
          <Shield className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs font-bold text-foreground">{entry.projectName}</p>
          <p className="font-mono text-[9px] text-muted-foreground/50">{entry.entitySerial}</p>
        </div>
        <Badge
          variant="outline"
          className={cn("font-mono text-[9px] border flex-shrink-0",
            entry.hasSeedPhrase
              ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
              : "text-muted-foreground/50 bg-muted/10"
          )}
        >
          {entry.hasSeedPhrase ? "✓ Seed Stored" : "No Seed"}
        </Badge>
      </div>

      {/* Wallet addresses */}
      {wallets.length > 0 && (
        <div className="space-y-1">
          <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">Wallet Addresses</p>
          {wallets.map((w, i) => (
            <div key={i} className="flex items-center gap-2 bg-muted/10 rounded-lg px-2.5 py-1.5 border border-border/20">
              <Wallet className="w-2.5 h-2.5 text-emerald-400 flex-shrink-0" />
              <span className="font-mono text-[10px] text-foreground/70 flex-1 truncate">{w}</span>
              <ChainBadge address={w} />
            </div>
          ))}
        </div>
      )}

      {/* Seed phrase section — importing a wallet into this entity means
          giving its recovery phrase here so AYZEN can encrypt and store it. */}
      {entry.hasSeedPhrase ? (
        <div className="space-y-2">
          {revealedSeed ? (
            <>
              <div className={cn("font-mono text-xs bg-muted/20 rounded-lg p-3 border border-border/30 break-all leading-relaxed", !shown && "blur-sm select-none")}>
                {revealedSeed}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setShown(s => !s)} className="font-mono text-xs gap-1.5 flex-1">
                  {shown ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {shown ? "Hide" : "Show"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleCopy} className={cn("font-mono text-xs gap-1.5 flex-1", copied ? "text-emerald-400 border-emerald-400/30" : "")}>
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex items-center gap-1.5 p-2 bg-amber-400/5 border border-amber-400/20 rounded-lg">
                <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
                <p className="font-mono text-[9px] text-amber-400">Never share your seed phrase with anyone</p>
              </div>
              {secondsLeft != null && (
                <p className="font-mono text-[9px] text-muted-foreground/40 text-center">
                  Auto-hides in {secondsLeft}s — leaving the tab clears it immediately
                </p>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReveal}
              disabled={revealing}
              className="font-mono text-xs gap-1.5 w-full"
            >
              {revealing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
              Reveal Seed Phrase
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            value={seed}
            onChange={e => setSeed(e.target.value)}
            className="font-mono text-xs bg-input resize-none h-20 placeholder:text-muted-foreground/30"
            placeholder="Enter 12 or 24 seed words separated by spaces, or a 0x private key..."
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !seed.trim()}
            className="font-mono text-xs gap-1.5 w-full"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Encrypt & Save
          </Button>
        </div>
      )}
      {pinDialog}
    </div>
  );
}

function WalletConnectPanel() {
  const { state: wc, connect, switchChain, sendTransaction, sendTokenTransaction, hasMetaMask } = useWalletConnect();
  const { toast } = useToast();
  const [toAddr, setToAddr] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);

  // Network + currency picker — sourced live from GET /wallets/vault-chains
  // so this always matches what AYZEN actually watches for deposits and
  // will resolve on withdrawal (ETH/BNB/POL/XPL native, USDT everywhere,
  // ARB's own token on Arbitrum).
  const [vaultChains, setVaultChains] = useState<VaultChain[]>([]);
  useEffect(() => { getVaultChains().then(setVaultChains).catch(() => {}); }, []);
  const [chain, setChain] = useState("ETH");
  const [currency, setCurrency] = useState("ETH");
  const activeChain = vaultChains.find(c => c.chain === chain);
  const currencyOptions = activeChain
    ? [{ symbol: activeChain.nativeSymbol, isNative: true, contract: null as string | null, decimals: 18 },
       ...activeChain.tokens.map(t => ({ symbol: t.symbol, isNative: false, contract: t.contract, decimals: t.decimals }))]
    : [];
  const selectedCurrency = currencyOptions.find(c => c.symbol === currency) ?? currencyOptions[0];

  const handleConnect = async () => {
    const addr = await connect();
    if (!addr) toast({ variant: "destructive", title: wc.error ?? "Wallet connection failed" });
  };

  const handleSend = async () => {
    if (!toAddr || !amount) return;
    if (!wc.address) { toast({ variant: "destructive", title: "Connect a wallet first" }); return; }
    setSending(true);
    try {
      if (activeChain && wc.chainId !== activeChain.chainId) {
        await switchChain(activeChain.chainId); // best-effort — MetaMask may prompt, or already be on it
      }
      const txHash = selectedCurrency && !selectedCurrency.isNative && selectedCurrency.contract
        ? await sendTokenTransaction(selectedCurrency.contract, toAddr, amount, selectedCurrency.decimals, wc.address)
        : await sendTransaction(toAddr, amount, wc.address);
      if (txHash) toast({ title: "Transaction sent", description: txHash.slice(0, 20) + "..." });
      else toast({ variant: "destructive", title: "Transaction failed" });
    } finally { setSending(false); }
  };

  return (
    <div className="bg-card border border-primary/20 rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Zap className="w-4 h-4 text-primary" />
        <span className="font-mono text-xs font-bold text-primary">Real-Time Wallet Connect</span>
        <Badge variant="outline" className="font-mono text-[9px] ml-auto">MetaMask</Badge>
      </div>

      {!wc.isConnected ? (
        <div className="space-y-3">
          <p className="font-mono text-[10px] text-muted-foreground/60">
            Connect your MetaMask wallet to interact with your entities and sign transactions in real-time.
          </p>
          {!hasMetaMask && (
            <div className="flex items-center gap-2 p-2.5 bg-amber-400/5 border border-amber-400/20 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <p className="font-mono text-[9px] text-amber-400">MetaMask not detected. Install the browser extension first.</p>
            </div>
          )}
          <Button onClick={handleConnect} disabled={wc.isConnecting || !hasMetaMask} className="font-mono text-xs gap-1.5 w-full">
            {wc.isConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LinkIcon className="w-3.5 h-3.5" />}
            {wc.isConnecting ? "Connecting..." : "Connect MetaMask"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-2.5 bg-emerald-400/5 border border-emerald-400/20 rounded-lg">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-[9px] text-emerald-400 font-bold">Connected</p>
              <p className="font-mono text-[9px] text-muted-foreground/60 truncate">{wc.address}</p>
            </div>
            {wc.chainId && (
              <Badge variant="outline" className="font-mono text-[9px]">Chain {wc.chainId}</Badge>
            )}
          </div>

          <div className="space-y-2">
            <p className="font-mono text-[10px] text-muted-foreground/50 uppercase tracking-widest">Send</p>
            <div className="grid grid-cols-2 gap-2">
              <Select value={chain} onValueChange={v => { setChain(v); setCurrency(vaultChains.find(c => c.chain === v)?.nativeSymbol ?? v); }}>
                <SelectTrigger className="font-mono text-xs h-8 bg-input border-border">
                  <SelectValue placeholder="Network" />
                </SelectTrigger>
                <SelectContent>
                  {vaultChains.map(c => (
                    <SelectItem key={c.chain} value={c.chain} className="font-mono text-xs">{c.chain}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="font-mono text-xs h-8 bg-input border-border">
                  <SelectValue placeholder="Currency" />
                </SelectTrigger>
                <SelectContent>
                  {currencyOptions.map(c => (
                    <SelectItem key={c.symbol} value={c.symbol} className="font-mono text-xs">{c.symbol}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <input
              value={toAddr}
              onChange={e => setToAddr(e.target.value)}
              className="w-full font-mono text-xs bg-input border border-border rounded-lg px-3 py-2 h-8 text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/50"
              placeholder="0x recipient address..."
            />
            <input
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full font-mono text-xs bg-input border border-border rounded-lg px-3 py-2 h-8 text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/50"
              placeholder={`Amount in ${currency || "ETH"} (e.g. 0.001)`}
            />
            <Button
              onClick={handleSend}
              disabled={sending || !toAddr || !amount}
              className="font-mono text-xs gap-1.5 w-full"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Send {currency || "Transaction"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Overview tab — active wallet + switcher ─────────────────────────────────
function OverviewTab({
  entries, activeId, setActiveId,
}: { entries: EntryAny[]; activeId: number | null; setActiveId: (id: number) => void }) {
  const walletEntries = useMemo(() => entries.filter(e => getWallets(e).length > 0), [entries]);
  const active = walletEntries.find(e => e.id === activeId) ?? walletEntries[0] ?? null;
  const activeWallets = active ? getWallets(active) : [];

  return (
    <div className="space-y-4">
      <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40">Active Wallet</p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="font-mono text-[10px] gap-1.5 h-7" disabled={walletEntries.length === 0}>
                <ArrowLeftRight className="w-3 h-3" /> Switch <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="font-mono w-64">
              <DropdownMenuLabel className="text-[9px] uppercase tracking-widest text-muted-foreground/50">Vault Wallets</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {walletEntries.map(e => (
                <DropdownMenuItem key={e.id} onClick={() => setActiveId(e.id)} className="text-xs gap-2">
                  <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", e.id === active?.id ? "bg-primary" : "bg-muted-foreground/20")} />
                  <span className="flex-1 truncate">{e.projectName}</span>
                  {e.id === active?.id && <Check className="w-3 h-3 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {!active ? (
          <div className="text-center py-6 text-muted-foreground/50 font-mono text-xs">
            No active wallet yet — add a wallet address to a vault entity first
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                <Wallet className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm font-bold text-foreground">{active.projectName}</p>
                <p className="font-mono text-[9px] text-muted-foreground/50">{active.entitySerial}</p>
              </div>
              <Badge
                variant="outline"
                className={cn("font-mono text-[9px] border flex-shrink-0",
                  active.hasSeedPhrase
                    ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
                    : "text-muted-foreground/50 bg-muted/10"
                )}
              >
                {active.hasSeedPhrase ? "✓ Seed Stored" : "No Seed"}
              </Badge>
            </div>

            <div className="space-y-1.5">
              {activeWallets.map((w, i) => (
                <div key={i} className="flex items-center gap-2 bg-muted/10 rounded-lg px-2.5 py-1.5 border border-border/20">
                  <ChainBadge address={w} />
                  <span className="font-mono text-[10px] text-foreground/70 flex-1 truncate">{w}</span>
                </div>
              ))}
            </div>

            <Link href={`/vault/entity/${active.id}/access`}>
              <Button size="sm" variant="outline" className="font-mono text-xs w-full gap-1.5">
                <LinkIcon className="w-3 h-3" /> Access Wallet
              </Button>
            </Link>
          </>
        )}
      </div>

      <SupportedDepositsCard />
      <WalletConnectPanel />
    </div>
  );
}

// Read-only summary of every network + currency the vault wallet watches
// for real-time deposits (and will resolve on withdrawal) — sourced live
// from GET /wallets/vault-chains so it can never drift from the backend
// registry (lib/tokens.ts).
function SupportedDepositsCard() {
  const [chains, setChains] = useState<VaultChain[]>([]);
  useEffect(() => { getVaultChains().then(setChains).catch(() => {}); }, []);
  if (chains.length === 0) return null;

  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-2.5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40">
        Supported Deposits — same address on every network
      </p>
      <div className="space-y-1.5">
        {chains.map(c => (
          <div key={c.chain} className="flex items-center gap-2 bg-muted/10 rounded-lg px-2.5 py-1.5 border border-border/20">
            <Badge variant="outline" className="font-mono text-[9px] flex-shrink-0">{c.chain}</Badge>
            <div className="flex items-center gap-1 flex-wrap flex-1">
              <Badge className="font-mono text-[9px] px-1.5 py-0 bg-primary/10 text-primary border-primary/20">{c.nativeSymbol}</Badge>
              {c.tokens.map(t => (
                <Badge key={t.symbol} variant="outline" className="font-mono text-[9px] px-1.5 py-0">{t.symbol}</Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Wallet tab — sidebar-style list of every vault wallet entity ──────────
function WalletListTab({
  entries, activeId, setActiveId,
}: { entries: EntryAny[]; activeId: number | null; setActiveId: (id: number) => void }) {
  const walletEntries = useMemo(() => entries.filter(e => getWallets(e).length > 0), [entries]);

  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">
        Vault Wallet Entities ({walletEntries.length})
      </p>
      {walletEntries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground/50 font-mono text-xs">
          No wallet entities yet · add a wallet address to a vault entity to see it here
        </div>
      ) : (
        <div className="divide-y divide-border/30 rounded-xl border border-card-border bg-card overflow-hidden">
          {walletEntries.map(e => {
            const wallets = getWallets(e);
            const primary = wallets[0];
            const isActive = e.id === activeId;
            return (
              <div key={e.id} className={cn("flex items-center gap-3 px-4 py-3.5", isActive && "bg-primary/5")}>
                <button
                  onClick={() => setActiveId(e.id)}
                  title="Set as active wallet"
                  className={cn(
                    "w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0 transition-all",
                    isActive ? "bg-primary/15 border-primary/30" : "bg-muted/20 border-border/30 hover:border-primary/30"
                  )}
                >
                  <Wallet className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground/50")} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono text-xs font-bold text-foreground truncate">{e.projectName}</span>
                    <ChainBadge address={primary} />
                    {isActive && <Badge className="font-mono text-[8px] px-1.5 py-0 bg-primary/10 text-primary border-primary/20">Active</Badge>}
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground/50 truncate">{primary}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="font-mono text-[9px] text-muted-foreground/40">Project: {e.projectName}</p>
                    {wallets.length > 1 && (
                      <p className="font-mono text-[9px] text-muted-foreground/30">+{wallets.length - 1} more address{wallets.length > 2 ? "es" : ""}</p>
                    )}
                  </div>
                </div>
                <Link href={`/vault/entity/${e.id}/access`}>
                  <Button size="sm" variant="outline" className="font-mono text-[10px] h-7 px-2.5 gap-1 flex-shrink-0">
                    Access Wallet
                  </Button>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Gas tab — whole-entity gas health across every vault entity's wallet(s) ─
// Total native-coin (gas) value on hand, a health/risk banner (any entity
// running critically low anywhere flips this red), and a per-entity list —
// clicking one deep-links straight to that entity's own Gas tab.
function GasOverviewTab() {
  const [data, setData] = useState<VaultGasOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const result = await getVaultGasOverview();
      setData(result);
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  }

  const worstRisk = data?.atRiskCount
    ? (data.atRisk.some(e => e.risk === "critical") ? "critical" : "warning")
    : "healthy";

  return (
    <div className="space-y-4">
      {/* Whole-entity totals + health banner */}
      <div className="bg-card border border-card-border rounded-xl px-4 py-3 flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5">
            <Zap className="w-3 h-3" /> Total Gas — All Entities
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="font-mono text-lg font-bold text-foreground">
              ${(data?.totalUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
            <GasRiskBadge risk={worstRisk as any} />
          </div>
          <p className="font-mono text-[9px] text-muted-foreground/40 mt-0.5">
            {data?.entityCount ?? 0} entities checked · {data?.atRiskCount ?? 0} at risk
          </p>
        </div>
        <Button
          size="sm" variant="outline" disabled={refreshing}
          onClick={() => load(true)}
          className="font-mono text-[10px] gap-1.5 flex-shrink-0"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          {refreshing ? "Checking chains…" : "Refresh"}
        </Button>
      </div>

      {/* Risk / health rules — who's running low, surfaced first */}
      {(data?.atRisk?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-red-400/70 px-1 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Needs Attention
          </p>
          <div className="divide-y divide-border/30 rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
            {data!.atRisk.map((e) => (
              <Link key={e.id} href={`/vault/entity/${e.id}?tab=gas`}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-red-500/5 cursor-pointer transition-colors">
                  <GasRiskBadge risk={e.risk} />
                  <span className="font-mono text-xs font-bold text-foreground flex-1 truncate">{e.projectName}</span>
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    ${e.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Every checked entity — click to expand its per-chain breakdown inline, or open the entity's own Gas tab */}
      <div className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">
          Every Entity ({data?.entities.length ?? 0})
        </p>
        {(data?.entities.length ?? 0) === 0 ? (
          <div className="text-center py-12 text-muted-foreground/50 font-mono text-xs">
            No entity has a wallet address to check yet
          </div>
        ) : (
          <div className="space-y-1.5">
            {data!.entities.map((e: EntityGasSummary) => {
              const expanded = expandedId === e.id;
              return (
                <div key={e.id} className="rounded-xl border border-card-border bg-card overflow-hidden">
                  <button
                    onClick={() => setExpandedId(expanded ? null : e.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/10 transition-colors text-left"
                  >
                    <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0 transition-transform", expanded && "rotate-180")} />
                    <span className="font-mono text-xs font-bold text-foreground flex-1 truncate">{e.projectName}</span>
                    <span className="font-mono text-[10px] text-muted-foreground/50">
                      ${e.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                    <GasRiskBadge risk={e.risk} />
                  </button>
                  {expanded && (
                    <div className="px-4 pb-3 space-y-1.5">
                      {e.chains.length === 0 ? (
                        <p className="font-mono text-[9px] text-muted-foreground/30 py-2">No gas on any watched chain</p>
                      ) : (
                        e.chains.map((c) => <GasChainRow key={`${c.chain}-${c.address}`} snapshot={c} />)
                      )}
                      <Link href={`/vault/entity/${e.id}?tab=gas`}>
                        <Button size="sm" variant="outline" className="font-mono text-[10px] w-full gap-1.5 mt-1">
                          <LinkIcon className="w-3 h-3" /> Open Entity's Gas Tab
                        </Button>
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="font-mono text-[9px] text-muted-foreground/30 leading-relaxed px-1">
        Risk is judged by transaction headroom, not raw balance: an entity flips to "Low Gas" once it can't
        cover ~5 more sends on a chain, and "Critical" once it can't cover even one — this works fairly across
        cheap chains (Polygon, BSC, Plasma) and expensive ones (Ethereum mainnet) alike.
      </p>
    </div>
  );
}

// ── Settings tab — import a wallet into the vault via its seed phrase ─────
function SettingsTab({ entries, isLoading }: { entries: EntryAny[]; isLoading: boolean }) {
  const withSeed = entries.filter(e => e.hasSeedPhrase).length;
  const withWallet = entries.filter(e => getWallets(e).length > 0).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Entities", value: entries.length, color: "text-primary" },
          { label: "With Seed Phrase", value: withSeed, color: "text-emerald-400" },
          { label: "With Wallet", value: withWallet, color: "text-violet-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3 text-center">
            <p className={cn("font-mono text-xl font-bold", s.color)}>{s.value}</p>
            <p className="font-mono text-[9px] text-muted-foreground/50 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 p-2.5 bg-muted/10 border border-border/20 rounded-lg">
        <KeyRound className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
        <p className="font-mono text-[9px] text-muted-foreground/50 leading-relaxed">
          To import a wallet into a vault entity, give its recovery phrase (12/24 words) or private key below — it's encrypted before storage.
        </p>
      </div>

      <div className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">
          Entity Seed Phrases
        </p>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground/50 font-mono text-xs">
            No entities · Add entities to manage seed phrases
          </div>
        ) : (
          entries.map(e => <SeedPhraseCard key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}

// Page-level layer: same shared entity-view PIN gate used by
// vault-entity-access.tsx / vault-entity-detail.tsx — this page shows
// wallet addresses and can trigger seed-phrase decryption, so it gets the
// same treatment as any other entity-sensitive surface. (The per-reveal
// PIN re-check in useRevealGuard above is a second, independent layer on
// top of this one, scoped to the actual decrypt action.)
type WalletHubTab = "overview" | "wallet" | "gas" | "settings";

interface VaultWalletSeedProps {
  // Driven by the Wallet Hub sidebar routes (/vault/wallet-hub/:subtab) — both
  // optional so the legacy /vault?tab=wallet usage (no props) keeps working
  // exactly as before, defaulting to the internal "overview" tab.
  initialTab?: WalletHubTab;
  onTabChange?: (tab: WalletHubTab) => void;
}

export default function VaultWalletSeed({ initialTab, onTabChange }: VaultWalletSeedProps = {}) {
  return (
    <EntityPinGate>
      <VaultWalletSeedContent initialTab={initialTab} onTabChange={onTabChange} />
    </EntityPinGate>
  );
}

function VaultWalletSeedContent({ initialTab, onTabChange }: VaultWalletSeedProps) {
  const { data, isLoading } = useListVaultEntries();
  const entries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];

  const [tab, setTab] = useState<WalletHubTab>(initialTab ?? "overview");

  // Keep in sync when the route changes which sub-tab is active (e.g. the
  // Wallet Hub sidebar links) without remounting this component.
  useEffect(() => {
    if (initialTab && initialTab !== tab) setTab(initialTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  const handleTabChange = (v: string) => {
    const next = v as WalletHubTab;
    setTab(next);
    onTabChange?.(next);
  };
  const [activeId, setActiveIdState] = useState<number | null>(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_WALLET_KEY) : null;
    return stored ? Number(stored) : null;
  });

  const setActiveId = (id: number) => {
    setActiveIdState(id);
    localStorage.setItem(ACTIVE_WALLET_KEY, String(id));
  };

  // Default the active wallet to the first entity that has one, once entries
  // load — only if nothing was picked (or persisted) yet.
  useEffect(() => {
    if (activeId != null) return;
    const first = entries.find(e => getWallets(e).length > 0);
    if (first) setActiveId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="overview" className="font-mono text-xs gap-1.5"><LayoutGrid className="w-3 h-3" /> Overview</TabsTrigger>
        <TabsTrigger value="wallet" className="font-mono text-xs gap-1.5"><Wallet className="w-3 h-3" /> Wallet</TabsTrigger>
        <TabsTrigger value="gas" className="font-mono text-xs gap-1.5"><Zap className="w-3 h-3" /> Gas</TabsTrigger>
        <TabsTrigger value="settings" className="font-mono text-xs gap-1.5"><Settings2 className="w-3 h-3" /> Settings</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="mt-4">
        <OverviewTab entries={entries} activeId={activeId} setActiveId={setActiveId} />
      </TabsContent>
      <TabsContent value="wallet" className="mt-4">
        <WalletListTab entries={entries} activeId={activeId} setActiveId={setActiveId} />
      </TabsContent>
      <TabsContent value="gas" className="mt-4">
        <GasOverviewTab />
      </TabsContent>
      <TabsContent value="settings" className="mt-4">
        <SettingsTab entries={entries} isLoading={isLoading} />
      </TabsContent>
    </Tabs>
  );
}
