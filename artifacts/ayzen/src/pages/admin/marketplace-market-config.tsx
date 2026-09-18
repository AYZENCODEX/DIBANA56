import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Vault, Gamepad2, Settings, Loader2, RefreshCw, Percent } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface MarketConfig {
  marketType: "vault" | "game";
  feePct: number;
  enabled: boolean;
}

const MARKET_META: Record<string, { label: string; icon: typeof Vault; color: string; border: string; bg: string; desc: string }> = {
  vault: {
    label: "Vault Market", icon: Vault, color: "text-amber-400", border: "border-amber-400/30", bg: "bg-amber-400/10",
    desc: "Buy/sell entity & local account listings (pages/user/marketplace-vault.tsx).",
  },
  game: {
    label: "Game Market", icon: Gamepad2, color: "text-indigo-400", border: "border-indigo-400/30", bg: "bg-indigo-400/10",
    desc: "Buy/sell game account listings (pages/user/marketplace-game.tsx).",
  },
};

function MarketConfigCard({ config, onSaved }: { config: MarketConfig; onSaved: (c: MarketConfig) => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const meta = MARKET_META[config.marketType];
  const Icon = meta.icon;

  const [feeDraft, setFeeDraft] = useState(String(config.feePct));
  const [enabledDraft, setEnabledDraft] = useState(config.enabled);
  const [saving, setSaving] = useState(false);
  const dirty = feeDraft !== String(config.feePct) || enabledDraft !== config.enabled;

  useEffect(() => { setFeeDraft(String(config.feePct)); setEnabledDraft(config.enabled); }, [config.feePct, config.enabled]);

  const save = async () => {
    const feeNum = Number(feeDraft);
    if (Number.isNaN(feeNum) || feeNum < 0 || feeNum > 100) {
      toast({ title: "Fee % must be between 0 and 100", variant: "destructive" });
      return;
    }
    if (!token) return;
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/admin/marketplace/market-config/${config.marketType}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fee_pct: feeNum, enabled: enabledDraft }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to save");
      const updated = await r.json();
      onSaved({ marketType: config.marketType, feePct: updated.feePct, enabled: updated.enabled });
      toast({ title: `${meta.label} settings saved` });
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e?.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <div className={cn("bg-card/60 border rounded-xl p-4 space-y-4", enabledDraft ? "border-border/40" : "border-red-500/30")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", meta.bg, meta.border, "border")}>
            <Icon className={cn("w-4 h-4", meta.color)} />
          </div>
          <div>
            <div className="font-mono text-sm font-bold text-foreground">{meta.label}</div>
            <div className="text-[11px] text-muted-foreground/70">{meta.desc}</div>
          </div>
        </div>
        {!enabledDraft && <Badge variant="outline" className="text-[10px] text-red-400 border-red-400/30 flex-shrink-0">Disabled</Badge>}
      </div>

      <div className="flex items-center gap-6">
        <div className="flex-1 space-y-1.5">
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest">Platform fee</label>
          <div className="relative">
            <Input
              type="number" min={0} max={100} step={0.5}
              value={feeDraft} onChange={e => setFeeDraft(e.target.value)}
              className="h-9 text-sm bg-background/50 pr-7 font-mono"
            />
            <Percent className="w-3.5 h-3.5 text-muted-foreground absolute right-2.5 top-1/2 -translate-y-1/2" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest block">Market open</label>
          <Switch checked={enabledDraft} onCheckedChange={setEnabledDraft} />
        </div>
      </div>

      <Button size="sm" onClick={save} disabled={saving || !dirty} className="w-full h-8 text-xs gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Save {meta.label}
      </Button>
    </div>
  );
}

/**
 * Vault Market / Game Market fee % + enable-disable switch — the config
 * lib/market-config.ts + routes/marketplace-market-config.ts read on every
 * listing/buy/stats call, replacing what used to be a hardcoded
 * `const FEE_PCT = 5` in each market's route file. Disabling a market blocks
 * new listing creation there (existing active listings still resolve).
 */
export default function AdminMarketplaceMarketConfig() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [configs, setConfigs] = useState<MarketConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/marketplace/market-config`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setConfigs(await r.json());
      else toast({ title: "Couldn't load market settings", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Couldn't load market settings", description: e?.message, variant: "destructive" });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [token]);

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" /> Market Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Per-market platform fee and an open/closed switch — takes effect immediately, no redeploy.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} className="h-8 gap-1.5 text-xs flex-shrink-0">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-3">
          {configs.map(c => (
            <MarketConfigCard
              key={c.marketType}
              config={c}
              onSaved={updated => setConfigs(prev => prev.map(p => p.marketType === updated.marketType ? updated : p))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
