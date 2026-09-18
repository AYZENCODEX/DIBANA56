import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Coins, Check, X, Loader2, RefreshCw, Clock, Tag, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const METHOD_ICONS: Record<string, string> = { bkash: "💳", nagad: "📱", binance_usdt: "₮" };
const METHOD_LABELS: Record<string, string> = { bkash: "bKash", nagad: "Naggad", binance_usdt: "Binance USDT" };
const APP_LABELS: Record<string, string> = {
  sylo: "Sylo (Vault · Local · KYC · Game)", ryft: "Ryft (Finance)", wisp: "Wisp (Mail)",
  zynth: "Zynth (AI)", verve: "Verve (Marketplace)", skarn: "Skarn (Protocols)",
  astra: "Astra (Extension)", workspace: "Workspace",
};
const APP_ICONS: Record<string, string> = {
  sylo: "🔐", ryft: "💰", wisp: "✉️", zynth: "🤖", verve: "🛒", skarn: "🌾", astra: "🧩", workspace: "🗂️",
};

interface PendingTx {
  id: number;
  userId: number;
  type: string;
  method: string | null;
  credits: number;
  amountBDT: number | null;
  amountUSDT: number | null;
  referenceId: string | null;
  notes: string | null;
  status: string;
  createdAt: string;
}

// ── PHASE 5b — admin credit console (pricing/usage), on top of the
// existing top-up Approvals panel below. Wired to routes/admin-credit-
// console.ts, which is already generic over every key in credit-meter.ts's
// METERED_ACTIONS — so this UI works unchanged for the new sylo.local_
// account_view / sylo.kyc_entry_view / sylo.game_entry_view actions too,
// no per-action UI code needed.
interface AdminAction {
  key: string;
  app: string;
  label: string;
  defaultCost: number;
  effectiveCost: number;
  override: { cost: number | null; enabled: boolean; updatedBy: number | null; updatedAt: string } | null;
}
interface UsageRow { actionKey: string; app: string; label: string; chargeCount: number; totalCredits: number; }

export default function AdminCreditsPage() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<"approvals" | "rates">("approvals");

  const [pending, setPending] = useState<PendingTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});

  const [actions, setActions] = useState<AdminAction[]>([]);
  const [usage, setUsage] = useState<Record<string, UsageRow>>({});
  const [ratesLoading, setRatesLoading] = useState(true);
  const [draftCost, setDraftCost] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/credits`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setPending(await r.json());
    } catch { }
    setLoading(false);
  }, [token]);

  const fetchRates = useCallback(async () => {
    setRatesLoading(true);
    try {
      const [actionsRes, usageRes] = await Promise.all([
        fetch(`${BASE}/api/admin/credits/actions`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BASE}/api/admin/credits/usage`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (actionsRes.ok) {
        const d = await actionsRes.json();
        setActions(d.actions ?? []);
      }
      if (usageRes.ok) {
        const d = await usageRes.json();
        const byKey: Record<string, UsageRow> = {};
        for (const row of d.usage ?? []) if (row.actionKey) byKey[row.actionKey] = row;
        setUsage(byKey);
      }
    } catch { }
    setRatesLoading(false);
  }, [token]);

  useEffect(() => { fetchPending(); }, [fetchPending]);
  useEffect(() => { if (tab === "rates") fetchRates(); }, [tab, fetchRates]);

  const handleSaveCost = async (key: string) => {
    const raw = draftCost[key];
    const cost = raw === undefined || raw === "" ? null : parseInt(raw, 10);
    if (cost !== null && (!Number.isInteger(cost) || cost < 0)) {
      toast({ variant: "destructive", title: "Cost must be a non-negative whole number" });
      return;
    }
    setSavingKey(key);
    try {
      const r = await fetch(`${BASE}/api/admin/credits/actions/${key}`, {
        method: "PATCH", headers, body: JSON.stringify({ cost }),
      });
      if (r.ok) {
        toast({ title: `✅ ${key} repriced` });
        setDraftCost(d => { const n = { ...d }; delete n[key]; return n; });
        await fetchRates();
      } else {
        const d = await r.json();
        toast({ variant: "destructive", title: d.error ?? "Failed to save" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSavingKey(null);
  };

  const handleToggleEnabled = async (key: string, enabled: boolean) => {
    setSavingKey(key);
    try {
      const r = await fetch(`${BASE}/api/admin/credits/actions/${key}`, {
        method: "PATCH", headers, body: JSON.stringify({ enabled }),
      });
      if (r.ok) {
        toast({ title: enabled ? `Fee re-enabled for ${key}` : `Fee waived for ${key}` });
        await fetchRates();
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSavingKey(null);
  };

  const handleResetOverride = async (key: string) => {
    setSavingKey(key);
    try {
      const r = await fetch(`${BASE}/api/admin/credits/actions/${key}`, { method: "DELETE", headers });
      if (r.ok) {
        toast({ title: `Reverted to code default` });
        await fetchRates();
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setSavingKey(null);
  };

  const handleApprove = async (id: number) => {
    setProcessing(id);
    try {
      const r = await fetch(`${BASE}/api/admin/credits/${id}/approve`, {
        method: "POST", headers, body: JSON.stringify({ note: notes[id] }),
      });
      if (r.ok) {
        toast({ title: "✅ Credits approved & added to user" });
        await fetchPending();
      } else {
        const d = await r.json();
        toast({ variant: "destructive", title: d.error ?? "Failed to approve" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setProcessing(null);
  };

  const handleReject = async (id: number) => {
    setProcessing(id);
    try {
      const r = await fetch(`${BASE}/api/admin/credits/${id}/reject`, {
        method: "POST", headers, body: JSON.stringify({ note: notes[id] ?? "Rejected" }),
      });
      if (r.ok) {
        toast({ title: "Transaction rejected" });
        await fetchPending();
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setProcessing(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Coins className="w-6 h-6 text-primary" /> AYZEN Credits
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            {tab === "approvals"
              ? `${pending.length} pending verification${pending.length !== 1 ? "s" : ""}`
              : "Reprice or waive any metered action — takes effect on the very next request"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={tab === "approvals" ? fetchPending : fetchRates} disabled={tab === "approvals" ? loading : ratesLoading} className="font-mono text-xs gap-2">
          <RefreshCw className={cn("w-3.5 h-3.5", (tab === "approvals" ? loading : ratesLoading) && "animate-spin")} /> Refresh
        </Button>
      </div>

      <div className="flex border border-border rounded-lg overflow-hidden bg-card w-fit">
        {(["approvals", "rates"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-5 py-2.5 text-xs font-mono uppercase tracking-widest transition-colors",
              tab === t ? "bg-primary/15 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "approvals" ? "💳 Top-up Approvals" : "🏷️ Metered Actions"}
          </button>
        ))}
      </div>

      {tab === "rates" ? (
        ratesLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="bg-card border border-card-border rounded-lg h-16 animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(
              actions.reduce<Record<string, AdminAction[]>>((acc, a) => { (acc[a.app] ??= []).push(a); return acc; }, {})
            ).map(([app, appActions]) => (
              <div key={app} className="bg-card border border-card-border rounded-lg overflow-hidden">
                <div className="bg-background/40 border-b border-card-border px-4 py-2.5 font-mono text-xs font-bold text-foreground flex items-center gap-2">
                  <span>{APP_ICONS[app] ?? "⚙️"}</span> {APP_LABELS[app] ?? app}
                </div>
                <div className="divide-y divide-card-border">
                  {appActions.map(a => {
                    const u = usage[a.key];
                    const enabled = a.override ? a.override.enabled : true;
                    return (
                      <div key={a.key} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-mono text-xs font-bold text-foreground">{a.label}</div>
                          <div className="font-mono text-[9px] text-muted-foreground mt-0.5 flex items-center gap-2">
                            <span>{a.key}</span>
                            <span>· default {a.defaultCost} CR</span>
                            {u && <span className="flex items-center gap-1 text-primary/70"><TrendingUp className="w-2.5 h-2.5" /> {u.chargeCount}× charged, {u.totalCredits.toLocaleString()} CR spent</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1.5">
                            <Tag className="w-3 h-3 text-muted-foreground" />
                            <Input
                              type="number"
                              min={0}
                              placeholder={String(a.override?.cost ?? a.defaultCost)}
                              value={draftCost[a.key] ?? ""}
                              onChange={e => setDraftCost(d => ({ ...d, [a.key]: e.target.value }))}
                              className="font-mono text-xs h-8 w-20 bg-input border-border"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={savingKey === a.key || draftCost[a.key] === undefined}
                              onClick={() => handleSaveCost(a.key)}
                              className="font-mono text-[10px] h-8 px-2.5"
                            >
                              {savingKey === a.key ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                            </Button>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Switch checked={enabled} disabled={savingKey === a.key} onCheckedChange={(v) => handleToggleEnabled(a.key, v)} />
                            <span className="font-mono text-[9px] text-muted-foreground uppercase w-14">{enabled ? "Billed" : "Waived"}</span>
                          </div>
                          <Badge className={cn("font-mono text-[10px] px-2 py-0.5 border",
                            a.effectiveCost === 0 ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" : "text-primary border-primary/30 bg-primary/10")}>
                            {a.effectiveCost === 0 ? "FREE" : `${a.effectiveCost} CR`}
                          </Badge>
                          {a.override && (
                            <Button size="sm" variant="ghost" disabled={savingKey === a.key} onClick={() => handleResetOverride(a.key)} className="font-mono text-[9px] h-8 px-2 text-muted-foreground hover:text-red-400">
                              Reset
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="bg-card border border-card-border rounded-lg h-28 animate-pulse" />)}
        </div>
      ) : pending.length === 0 ? (
        <div className="bg-card border border-card-border rounded-lg px-6 py-12 text-center">
          <Clock className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground">No pending approvals</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map(tx => (
            <div key={tx.id} className="bg-card border border-amber-400/20 rounded-lg overflow-hidden">
              <div className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl mt-0.5">{tx.method ? (METHOD_ICONS[tx.method] ?? "⚙️") : "⚙️"}</span>
                    <div>
                      <div className="font-mono font-bold text-sm text-foreground flex items-center gap-2">
                        User #{tx.userId}
                        <Badge className="font-mono text-[8px] px-1.5 py-0 bg-amber-400/10 text-amber-400 border-amber-400/30">
                          PENDING
                        </Badge>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground mt-0.5">
                        {tx.method ? METHOD_LABELS[tx.method] : "System"} · {tx.credits.toLocaleString()} credits
                      </div>
                      {tx.amountBDT && <div className="font-mono text-xs text-primary mt-0.5">৳ {tx.amountBDT} BDT</div>}
                      {tx.amountUSDT && <div className="font-mono text-xs text-primary mt-0.5">${tx.amountUSDT} USDT</div>}
                      {tx.referenceId && (
                        <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
                          TrxID: {tx.referenceId}
                        </div>
                      )}
                      {tx.notes && (
                        <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">{tx.notes}</div>
                      )}
                      <div className="font-mono text-[9px] text-muted-foreground/40 mt-1">
                        {new Date(tx.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <Button
                      size="sm"
                      onClick={() => handleApprove(tx.id)}
                      disabled={processing === tx.id}
                      className="font-mono text-[10px] gap-1.5 h-8 px-3 bg-emerald-500 hover:bg-emerald-500/90 text-white"
                    >
                      {processing === tx.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleReject(tx.id)}
                      disabled={processing === tx.id}
                      className="font-mono text-[10px] gap-1.5 h-8 px-3 border-red-500/20 text-red-400 hover:bg-red-500/10"
                    >
                      <X className="w-3 h-3" /> Reject
                    </Button>
                  </div>
                </div>

                <div className="mt-3">
                  <Input
                    placeholder="Admin note (optional)"
                    value={notes[tx.id] ?? ""}
                    onChange={e => setNotes(n => ({ ...n, [tx.id]: e.target.value }))}
                    className="font-mono text-xs h-8 bg-input border-border"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
