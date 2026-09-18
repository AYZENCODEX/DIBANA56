import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  Shield, Smartphone, ShieldCheck, Gamepad2, QrCode,
  ChevronRight, Loader2, Plus, Trash2, LayoutDashboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { TOTPCard } from "@/components/vault/totp-card";
import { VaultSectionPage, CategoryTabBar } from "@/components/layout/vault-sidebar";

type Category = "overview" | "kyc" | "local" | "entity" | "game" | "other";

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType; desc: string }> = {
  overview: { label: "Overview", icon: LayoutDashboard, desc: "All 2FA codes across Entity, Local, KYC & Game" },
  kyc:    { label: "KYC",    icon: ShieldCheck, desc: "2FA codes from KYC entities" },
  local:  { label: "Local",  icon: Smartphone,  desc: "2FA codes from local accounts" },
  entity: { label: "Entity", icon: Shield,      desc: "2FA codes from vault entities" },
  game:   { label: "Game",   icon: Gamepad2,    desc: "2FA codes from game accounts" },
  other:  { label: "Other",  icon: QrCode,      desc: "Manually added 2FA codes" },
};

interface Row { id: number | string; name: string; count: number; }
interface OverviewRow extends Row { category: Exclude<Category, "overview" | "other">; }

// Shared row-computation so both the single-category view and the Overview
// roll-up derive rows the same way from the same three raw sources.
function computeRows(category: Exclude<Category, "overview" | "other">, vaultData: any[], raw: any[]): Row[] {
  if (category === "entity") {
    return vaultData
      .filter(e => e.twitter2fa || e.discord2fa || e.telegram2fa)
      .map(e => ({ id: e.id, name: e.projectName, count: [e.twitter2fa, e.discord2fa, e.telegram2fa].filter(Boolean).length }));
  }
  if (category === "local") {
    return raw.filter(a => a.twofa || a.recovery_email_twofa)
      .map(a => ({ id: a.id, name: a.label ?? a.username ?? a.email ?? `Account #${a.id}`, count: [a.twofa, a.recovery_email_twofa].filter(Boolean).length }));
  }
  // kyc / game — single email_2fa field
  return raw.filter(e => e.email_2fa)
    .map(e => ({ id: e.id, name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, count: 1 }));
}

// ─── Other (flat, no entity drill-down) ────────────────────────────────────────
interface OtherEntry { id: number; label: string; secret: string; notes: string | null; created_at: string; }

function OtherTwoFaList() {
  const [entries, setEntries] = useState<OtherEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ label: "", secret: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const { toast } = useToast();

  const load = () => {
    setLoading(true);
    customFetch<OtherEntry[]>("/two-factor/other").then(d => setEntries(Array.isArray(d) ? d : []))
      .catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!form.label.trim() || !form.secret.trim()) {
      toast({ variant: "destructive", title: "Label and Secret are required" });
      return;
    }
    setSaving(true);
    try {
      await customFetch("/two-factor/other", { method: "POST", body: JSON.stringify(form) });
      toast({ title: "2FA entry added" });
      setOpen(false);
      setForm({ label: "", secret: "", notes: "" });
      load();
    } catch {
      toast({ variant: "destructive", title: "Failed to add entry" });
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    try {
      await customFetch(`/two-factor/other/${id}`, { method: "DELETE" });
      toast({ title: "Entry deleted" });
      setEntries(prev => prev.filter(e => e.id !== id));
    } catch {
      toast({ variant: "destructive", title: "Failed to delete" });
    }
    setDeleteId(null);
  };

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-muted-foreground/60">{entries.length} manual entries</p>
        <Button size="sm" onClick={() => setOpen(true)} className="font-mono text-xs gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add 2FA
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <QrCode className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">No manual 2FA entries</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {entries.map(e => (
            <TOTPCard key={e.id} label={e.label} issuer={e.notes ?? undefined} secret={e.secret} onDelete={() => setDeleteId(e.id)} />
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="font-mono text-sm">Add 2FA Entry</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Label *</Label>
              <Input value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))} className="font-mono text-xs h-8 bg-input" placeholder="e.g. GitHub, Binance..." />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">TOTP Secret *</Label>
              <Input value={form.secret} onChange={e => setForm(p => ({ ...p, secret: e.target.value.trim() }))} className="font-mono text-xs h-8 bg-input tracking-wider" placeholder="Base32 secret" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Notes (optional)</Label>
              <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="font-mono text-xs h-8 bg-input" placeholder="Platform, account info..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button size="sm" onClick={handleCreate} disabled={saving} className="font-mono text-xs">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader><DialogTitle className="font-mono text-sm text-red-400">Delete Entry?</DialogTitle></DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">This action cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteId(null)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteId && handleDelete(deleteId)} className="font-mono text-xs">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Category → entity list (kyc / local / entity / game) ─────────────────────
function EntityTwoFaList({ category }: { category: Exclude<Category, "overview" | "other"> }) {
  const [, navigate] = useLocation();
  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [raw, setRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(category !== "entity");

  useEffect(() => {
    if (category === "entity") return;
    const endpoint = category === "kyc" ? "/kyc-entries" : category === "game" ? "/game-entries" : "/local-accounts";
    setLoading(true);
    customFetch<any>(endpoint).then(d => setRaw(Array.isArray(d) ? d : (d?.accounts ?? [])))
      .catch(() => setRaw([])).finally(() => setLoading(false));
  }, [category]);

  const rows: Row[] = useMemo(
    () => computeRows(category, (vaultData as any[]) ?? [], raw),
    [category, vaultData, raw]
  );

  const isLoading = category === "entity" ? vaultLoading : loading;
  const Icon = CATEGORY_META[category].icon;

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 space-y-2">
        <Icon className="w-8 h-8 text-muted-foreground/30 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No {CATEGORY_META[category].label} entities with 2FA yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map(row => (
        <button
          key={row.id}
          onClick={() => navigate(`/vault/2fa/${category}/${row.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-xl hover:border-primary/30 transition-colors text-left"
        >
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-bold truncate">{row.name}</p>
            <p className="font-mono text-[9px] text-muted-foreground/45">{row.count} 2FA code{row.count !== 1 ? "s" : ""}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// ─── Overview (roll-up of entity / local / kyc / game) ────────────────────────
function OverviewTwoFaList() {
  const [, navigate] = useLocation();
  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [localRaw, setLocalRaw] = useState<any[]>([]);
  const [kycRaw, setKycRaw] = useState<any[]>([]);
  const [gameRaw, setGameRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      customFetch<any>("/local-accounts").then(d => setLocalRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setLocalRaw([])),
      customFetch<any>("/kyc-entries").then(d => setKycRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setKycRaw([])),
      customFetch<any>("/game-entries").then(d => setGameRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setGameRaw([])),
    ]).finally(() => setLoading(false));
  }, []);

  const rows: OverviewRow[] = useMemo(() => {
    const vd = (vaultData as any[]) ?? [];
    return [
      ...computeRows("entity", vd, []).map(r => ({ ...r, category: "entity" as const })),
      ...computeRows("local", [], localRaw).map(r => ({ ...r, category: "local" as const })),
      ...computeRows("kyc", [], kycRaw).map(r => ({ ...r, category: "kyc" as const })),
      ...computeRows("game", [], gameRaw).map(r => ({ ...r, category: "game" as const })),
    ];
  }, [vaultData, localRaw, kycRaw, gameRaw]);

  const isLoading = vaultLoading || loading;
  const totalCodes = rows.reduce((sum, r) => sum + r.count, 0);

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 space-y-2">
        <LayoutDashboard className="w-8 h-8 text-muted-foreground/30 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No 2FA codes stored yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 px-1">
        {rows.length} account{rows.length !== 1 ? "s" : ""} · {totalCodes} 2FA code{totalCodes !== 1 ? "s" : ""}
      </p>
      {rows.map(row => {
        const Icon = CATEGORY_META[row.category].icon;
        return (
          <button
            key={`${row.category}-${row.id}`}
            onClick={() => navigate(`/vault/2fa/${row.category}/${row.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-xl hover:border-primary/30 transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-bold truncate">{row.name}</p>
              <p className="font-mono text-[9px] text-muted-foreground/45">
                {CATEGORY_META[row.category].label} · {row.count} 2FA code{row.count !== 1 ? "s" : ""}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────
const TABS = (["overview", "entity", "local", "kyc", "game", "other"] as const)
  .map(id => ({ id, label: CATEGORY_META[id].label, icon: CATEGORY_META[id].icon }));

export default function VaultTwoFaCategory() {
  const params = useParams<{ category: string }>();
  // Guard against an unknown/stale category (e.g. a leftover "account" link)
  // silently falling through to the wrong endpoint/filter further down —
  // fall back to "entity" (the vault entity's own twitter/discord/telegram
  // 2FA) whenever the param isn't one of the real categories.
  const rawCategory = params.category as Category;
  const category: Category = CATEGORY_META[rawCategory] ? rawCategory : "entity";
  const meta = CATEGORY_META[category];

  return (
    <VaultSectionPage title="2FA" description={meta.desc} icon={ShieldCheck}>
      <div className="space-y-4">
        <CategoryTabBar basePath="/vault/2fa" active={category} tabs={TABS} />
        {category === "overview" ? <OverviewTwoFaList />
          : category === "other" ? <OtherTwoFaList />
          : <EntityTwoFaList category={category} />}
      </div>
    </VaultSectionPage>
  );
}
