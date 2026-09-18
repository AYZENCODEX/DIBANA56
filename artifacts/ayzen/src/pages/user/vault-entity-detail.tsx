import { useState, useEffect, Suspense, lazy } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useListVaultEntries } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Shield, KeyRound, Mail, AtSign, Hash, Phone, Wallet,
  Lock, Eye, EyeOff, Copy, Check, QrCode, Loader2,
  AlertTriangle, ChevronLeft, Edit2, Trash2, Smartphone, Star,
  CheckCircle2, XCircle, TrendingUp, Users, HardDrive, Settings2,
  Ban, ShieldOff, RefreshCw, History, X, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QRCodeSVG } from "qrcode.react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { computeEntityWorth } from "@/lib/entity-worth";
import { ENTITY_HEALTH_CHECKS as CHECKS } from "@/config/columns/entity-view";
import { Progress } from "@/components/ui/progress";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useDeleteVaultEntry } from "@workspace/api-client-react";
import EntityDashboardTabs from "@/components/entity-dashboard-tabs";
import { ValueEntryDialog, ValueEntryButton, FollowerEntryDialog, FollowerEntryButton } from "@/components/value-entry-dialog";
import { ValuePnlPanel } from "@/components/value-pnl-panel";
import { EntityPinGate } from "@/components/vault/entity-pin-gate";
import { ImapSmtpForm, type EmailAccount } from "@/components/mail/imap-smtp-form";
import { setBanned, setEntityPlatformBanned, setOtherAccountBanned, type EntityPlatform } from "@/lib/vault-ban-api";
import { refreshWalletWorth } from "@/lib/wallet-worth-api";
import { LinkedEntitiesSection } from "@/components/vault/linked-entities-section";
import { AttachmentsSection } from "@/components/vault/attachments-section";
import { EntityGasTab } from "@/components/vault/entity-gas-tab";
import { Fuel } from "lucide-react";
import { updateVaultField, getVaultFieldHistory, type VaultFieldHistoryEntry } from "@/lib/vault-field-api";
import { ReceiptLinkDialog } from "@/components/receipt-link-dialog";
import { vaultEntityReceiptApi } from "@/lib/receipt-api";

type EntryAny = any;

const MAIL_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type DetailTab = "dashboard" | "overview" | "credentials" | "twitter" | "discord" | "telegram" | "wallet" | "gas" | "other";

const TAB_META: Record<DetailTab, { label: string; icon: React.ElementType }> = {
  dashboard:   { label: "Dashboard",   icon: TrendingUp },
  overview:    { label: "Overview",    icon: Shield },
  credentials: { label: "Credentials", icon: Mail },
  twitter:     { label: "Twitter",     icon: AtSign },
  discord:     { label: "Discord",     icon: Hash },
  telegram:    { label: "Telegram",    icon: Phone },
  wallet:      { label: "Wallet",      icon: Wallet },
  gas:         { label: "Gas",         icon: Fuel },
  other:       { label: "Other",       icon: Smartphone },
};

const TABS: DetailTab[] = ["dashboard", "overview", "credentials", "twitter", "discord", "telegram", "wallet", "gas", "other"];

function FieldHistoryDialog({ label, entries, loading, onClose }: {
  label: string; entries: VaultFieldHistoryEntry[]; loading: boolean; onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <History className="w-4 h-4 text-primary" /> {label} — Commit History
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-2">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && entries.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground/50 text-center py-8">No changes recorded yet</p>
          )}
          {!loading && entries.map((e) => (
            <div key={e.id} className="rounded-lg border border-border/30 px-3 py-2 space-y-1">
              <p className="font-mono text-[10px] text-muted-foreground/50">{new Date(e.changedAt).toLocaleString()}</p>
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="text-red-400/80 line-through truncate max-w-[45%]">{e.oldValue || "(empty)"}</span>
                <span className="text-muted-foreground/40">→</span>
                <span className="text-emerald-400/90 truncate max-w-[45%]">{e.newValue || "(empty)"}</span>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CredRow({ label, value, field, entryId }: {
  label: string; value: string | null | undefined; field?: string; entryId?: number;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<VaultFieldHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const editable = !!field && entryId != null;
  if (!value && !editable) return null;

  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startEdit = () => { setDraft(value ?? ""); setEditing(true); };

  const save = async () => {
    if (!field || entryId == null) return;
    setSaving(true);
    try {
      await updateVaultField(entryId, field, draft);
      toast({ title: `${label} updated ✓` });
      setEditing(false);
      await queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: `Failed to update ${label}` });
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    if (!field || entryId == null) return;
    setHistoryLoading(true);
    try {
      setHistory(await getVaultFieldHistory(entryId, field));
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-2 border-b border-border/20 last:border-0">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-20 flex-shrink-0">{label}</span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          placeholder={`New ${label.toLowerCase()}…`}
          className="flex-1 min-w-0 bg-transparent border border-primary/40 rounded px-2 py-1 font-mono text-xs text-foreground/90 focus:outline-none focus:border-primary"
        />
        <button onClick={save} disabled={saving} className="p-1 rounded text-emerald-400 hover:text-emerald-300 disabled:opacity-40 flex-shrink-0">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} className="p-1 rounded text-muted-foreground/40 hover:text-red-400 flex-shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2 border-b border-border/20 last:border-0 group">
      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-20 flex-shrink-0">{label}</span>
      <span className={cn(
        "flex-1 font-mono text-xs truncate",
        value ? (shown ? "text-foreground/90" : "text-muted-foreground/50") : "text-muted-foreground/30 italic"
      )}>
        {value ? (shown ? value : "•".repeat(Math.min(value.length, 16))) : "Not set"}
      </span>
      <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {value && (
          <button onClick={() => setShown((s) => !s)} className="p-1 rounded text-muted-foreground/40 hover:text-primary transition-colors">
            {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
        {value && (
          <button onClick={copy} className={cn("p-1 rounded transition-colors", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary")}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
        {editable && (
          <>
            <button onClick={openHistory} title="Change history" className="p-1 rounded text-muted-foreground/40 hover:text-primary transition-colors">
              <History className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={startEdit}
              className="px-1.5 py-0.5 rounded font-mono text-[9px] uppercase tracking-wider border border-border/40 text-muted-foreground/70 hover:border-primary hover:text-primary transition-colors"
            >
              Change
            </button>
          </>
        )}
      </div>
      {historyOpen && (
        <FieldHistoryDialog label={label} entries={history} loading={historyLoading} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} className={cn("p-1.5 rounded transition-all", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary hover:bg-primary/10")}>
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function Section({ title, color, children, right }: { title: string; color: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className={cn("px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest flex items-center justify-between gap-2", color)}>
        <span>{title}</span>
        {right}
      </div>
      <div className="px-4 py-2">
        {children}
      </div>
    </div>
  );
}

// Small pill button used to ban/unban a single linked platform account
// (Twitter/Discord/Telegram) independently of the entity's own status.
function PlatformBanToggle({ banned, pending, onClick }: { banned: boolean; pending: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded-md font-mono text-[9px] uppercase tracking-wider border normal-case transition-colors flex-shrink-0",
        banned ? "text-emerald-400 border-emerald-400/30 hover:bg-emerald-400/10" : "text-red-400 border-red-400/30 hover:bg-red-400/10"
      )}
    >
      {pending ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : banned ? <ShieldOff className="w-2.5 h-2.5" /> : <Ban className="w-2.5 h-2.5" />}
      {banned ? "Unban" : "Ban"}
    </button>
  );
}

type PlatformSubTab = "main" | "recovery" | "info";

function PlatformSubTabs({ subTab, onChange }: { subTab: PlatformSubTab; onChange: (t: PlatformSubTab) => void }) {
  const items: { id: PlatformSubTab; label: string }[] = [
    { id: "main", label: "Main" },
    { id: "recovery", label: "Recovery" },
    { id: "info", label: "Info" },
  ];
  return (
    <div className="flex gap-1 mb-1">
      {items.map(it => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider border transition-all",
            subTab === it.id ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function healthScore(e: EntryAny): number {
  const filled = CHECKS.filter(c => c.getValue(e)).length;
  return Math.round((filled / CHECKS.length) * 100);
}
function healthColor(score: number) {
  if (score >= 80) return "text-emerald-400";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}
function healthBarColor(score: number) {
  if (score >= 80) return "bg-emerald-400";
  if (score >= 50) return "bg-amber-400";
  return "bg-red-400";
}
function healthLabel(score: number) {
  if (score >= 80) return { label: "Healthy", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" };
  if (score >= 50) return { label: "Partial",  color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
  return { label: "At Risk", color: "text-red-400 bg-red-400/10 border-red-400/20" };
}

function metricLabelFor(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes("twitter") || p.includes("x.com")) return "Followers";
  if (p.includes("youtube")) return "Subscribers";
  if (p.includes("discord")) return "Members";
  if (p.includes("tiktok")) return "Followers";
  if (p.includes("instagram")) return "Followers";
  if (p.includes("github")) return "Stars";
  return "Metric";
}

// Phase 5 — Vault Security: viewing any entity's details requires the
// shared entity-view PIN (see components/vault/entity-pin-gate.tsx). The
// gate wraps the page below so nothing in it mounts — and no vault data for
// this entity is fetched or rendered — until the correct PIN is entered.
export default function VaultEntityDetail() {
  return (
    <EntityPinGate>
      <VaultEntityDetailContent />
    </EntityPinGate>
  );
}

function VaultEntityDetailContent() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { data, isLoading } = useListVaultEntries();
  const deleteMutation = useDeleteVaultEntry();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { token } = useAuth() as any;

  // Deep-link support: /vault/entity/:id?tab=gas opens straight onto a tab
  // (e.g. from the Gas overview's "at risk" list, so clicking an entity
  // there lands directly on that entity's own Gas tab, not the default).
  const initialTab = (new URLSearchParams(search).get("tab") as DetailTab | null);
  const [tab, setTab] = useState<DetailTab>(initialTab && TABS.includes(initialTab) ? initialTab : "dashboard");
  const [platformSubTab, setPlatformSubTab] = useState<PlatformSubTab>("main");
  const [qrAddress, setQrAddress] = useState<string | null>(null);
  const [worthRefreshing, setWorthRefreshing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [valueDialogOpen, setValueDialogOpen] = useState(false);
  const [followerDialogOpen, setFollowerDialogOpen] = useState(false);
  const [valueDefaultTarget, setValueDefaultTarget] = useState<string | undefined>(undefined);
  const [followerDefaultTarget, setFollowerDefaultTarget] = useState<string | undefined>(undefined);
  // Email Settings — configure IMAP/SMTP for this entity's email address
  // directly from the detail view (same /api/email-accounts data source the
  // Mail Hub Overview and Settings page read from, so it shows up everywhere
  // immediately — no separate config store).
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailAccountsLoading, setEmailAccountsLoading] = useState(false);
  const [banPending, setBanPending] = useState(false);
  const [platformBanPending, setPlatformBanPending] = useState<EntityPlatform | null>(null);
  const [otherBanPendingIdx, setOtherBanPendingIdx] = useState<number | null>(null);

  const fetchEmailAccounts = async () => {
    setEmailAccountsLoading(true);
    try {
      const res = await fetch(`${MAIL_BASE}/api/email-accounts`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setEmailAccounts(await res.json());
    } catch {} finally { setEmailAccountsLoading(false); }
  };

  useEffect(() => {
    if (emailSettingsOpen && emailAccounts.length === 0 && !emailAccountsLoading) fetchEmailAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailSettingsOpen]);

  const entries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];
  const entry = entries.find(e => String(e.id) === String(params.id));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=entity")} className="font-mono text-xs gap-1.5">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
        </Button>
        <div className="text-center py-20">
          <Shield className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground/60">Entity not found</p>
        </div>
      </div>
    );
  }

  const score = healthScore(entry);
  const { label: healthLbl, color: badgeColor } = healthLabel(score);
  const totalWorth = computeEntityWorth(entry);
  const missing = CHECKS.filter(c => !c.getValue(entry));
  const present = CHECKS.filter(c => c.getValue(entry));

  let others: any[] = [];
  try { others = entry.otherAccounts ? JSON.parse(entry.otherAccounts) : []; } catch { /**/ }

  const handleDelete = () => {
    deleteMutation.mutate({ id: entry.id } as any, {
      onSuccess: () => {
        toast({ title: "Moved to Trash", description: "Restorable from Vault → Trash for 30 days." });
        queryClient.invalidateQueries();
        navigate("/vault?tab=entity");
      },
      onError: () => toast({ variant: "destructive", title: "Failed to delete" }),
    });
  };

  const isEntityBanned = entry.status === "banned";

  const handleToggleEntityBan = async () => {
    setBanPending(true);
    try {
      await setBanned("entity", entry.id, !isEntityBanned);
      toast({ title: isEntityBanned ? "Entity unbanned" : "Entity banned", description: !isEntityBanned ? "It now shows under Vault → Banned." : undefined });
      queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: "Failed to update ban status" });
    } finally {
      setBanPending(false);
    }
  };

  const handleTogglePlatformBan = async (platform: EntityPlatform, currentlyBanned: boolean) => {
    setPlatformBanPending(platform);
    try {
      await setEntityPlatformBanned(entry.id, platform, !currentlyBanned);
      toast({ title: !currentlyBanned ? `${platform[0].toUpperCase()}${platform.slice(1)} banned` : `${platform[0].toUpperCase()}${platform.slice(1)} unbanned` });
      queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: "Failed to update ban status" });
    } finally {
      setPlatformBanPending(null);
    }
  };

  const handleToggleOtherBan = async (index: number, currentlyBanned: boolean) => {
    setOtherBanPendingIdx(index);
    try {
      await setOtherAccountBanned(entry.id, others, index, !currentlyBanned);
      toast({ title: !currentlyBanned ? "Account banned" : "Account unbanned" });
      queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: "Failed to update ban status" });
    } finally {
      setOtherBanPendingIdx(null);
    }
  };

  const valueTargets = [
    { value: "entity", label: "Entity total", currentValue: Number(entry.currentValue ?? 0), currentBuyValue: Number(entry.currentBuyValue ?? 0) },
    ...(entry.twitterUsername ? [{ value: "twitter", label: "Twitter / X", currentValue: Number(entry.twitterWorth ?? 0), currentBuyValue: Number(entry.twitterBuyValue ?? 0) }] : []),
    ...(entry.discordUsername ? [{ value: "discord", label: "Discord", currentValue: Number(entry.discordWorth ?? 0), currentBuyValue: Number(entry.discordBuyValue ?? 0) }] : []),
    ...(entry.telegramUsername || entry.telegramPhone ? [{ value: "telegram", label: "Telegram", currentValue: Number(entry.telegramWorth ?? 0), currentBuyValue: Number(entry.telegramBuyValue ?? 0) }] : []),
    ...others.map((acc: any) => ({ value: `other:${String(acc.platform ?? "")}`, label: String(acc.platform ?? "Other"), currentValue: Number(acc.worth ?? 0), currentBuyValue: Number(acc.buyValue ?? 0) })),
  ];

  // Other-platform accounts don't carry a follower column in the schema
  // (only twitter_followers / discord_followers / telegram_followers exist
  // alongside the entity-level total), so they're intentionally left out here.
  const followerTargets = [
    { value: "entity", label: "Entity total" },
    ...(entry.twitterUsername ? [{ value: "twitter", label: "Twitter / X" }] : []),
    ...(entry.discordUsername ? [{ value: "discord", label: "Discord" }] : []),
    ...(entry.telegramUsername || entry.telegramPhone ? [{ value: "telegram", label: "Telegram" }] : []),
  ];

  const openValueDialog = (target?: string) => { setValueDefaultTarget(target); setValueDialogOpen(true); };
  const openFollowerDialog = (target?: string) => { setFollowerDefaultTarget(target); setFollowerDialogOpen(true); };

  return (
    <div className="space-y-5 page-enter max-w-3xl mx-auto">
      {/* Back + header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=entity")} className="font-mono text-xs gap-1.5 mb-3 -ml-2">
            <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
          </Button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold font-mono tracking-tighter">{entry.projectName}</h1>
              <div className="flex items-center gap-2 mt-1">
                {isEntityBanned && (
                  <Badge variant="outline" className="font-mono text-[9px] uppercase tracking-wider px-1.5 text-red-400 border-red-400/30 bg-red-400/5 flex items-center gap-1">
                    <Ban className="w-2.5 h-2.5" /> Banned
                  </Badge>
                )}
                <span className="font-mono text-[10px] text-muted-foreground/50">{entry.entitySerial}</span>
                {totalWorth > 0 && (
                  <span className="font-mono text-[10px] font-bold text-amber-400">${totalWorth.toFixed(0)} total worth</span>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-2 sm:mt-8">
          <ValueEntryButton onClick={() => openValueDialog(undefined)} />
          <FollowerEntryButton onClick={() => openFollowerDialog(undefined)} />
          <Button variant="outline" size="sm" onClick={() => navigate(`/vault/entity/${entry.id}/access`)} className="font-mono text-xs gap-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Access
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEmailSettingsOpen(true)} className="font-mono text-xs gap-1.5">
            <Settings2 className="w-3.5 h-3.5" /> Email
          </Button>
          <Button variant="outline" size="sm" onClick={() => setReceiptDialogOpen(true)} className="font-mono text-xs gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> Receipt
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate(`/vault?tab=entity&editId=${entry.id}`)} className="font-mono text-xs gap-1.5">
            <Edit2 className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleEntityBan}
            disabled={banPending}
            className={cn("font-mono text-xs gap-1.5", isEntityBanned ? "text-emerald-400 border-emerald-400/30 hover:bg-emerald-400/10" : "text-red-400 border-red-400/30 hover:bg-red-400/10")}
          >
            {banPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isEntityBanned ? <ShieldOff className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
            {isEntityBanned ? "Unban" : "Ban"}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} className="font-mono text-xs gap-1.5">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-muted/20 rounded-lg overflow-x-auto">
        {TABS.map(t => {
          const { label, icon: Icon } = TAB_META[t];
          return (
            <button
              key={t}
              onClick={() => { setTab(t); setPlatformSubTab("main"); }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider flex-shrink-0 transition-all",
                tab === t ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
              )}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Dashboard Tab — Overview / Project / PnL, scoped to this one entity */}
      {tab === "dashboard" && (
        <div className="space-y-4">
          <div className="flex justify-end gap-1.5">
            <ValueEntryButton onClick={() => openValueDialog(undefined)} />
            <FollowerEntryButton onClick={() => openFollowerDialog(undefined)} />
          </div>
          <EntityDashboardTabs vaultEntryId={entry.id} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ValuePnlPanel compact metric="value" title="Value P&L" sourceType="vault" sourceId={entry.id} />
            <ValuePnlPanel compact metric="follower" title="Follower P&L" sourceType="vault" sourceId={entry.id} />
          </div>
        </div>
      )}

      {/* Overview Tab */}
      {tab === "overview" && (
        <div className="space-y-4">
          {/* Health card */}
          <div className="bg-card border border-card-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />
                <span className="font-mono text-sm font-bold text-primary">Entity Health</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("font-mono text-xl font-bold", healthColor(score))}>{score}%</span>
                <Badge variant="outline" className={cn("font-mono text-[9px] px-1.5 border", badgeColor)}>{healthLbl}</Badge>
              </div>
            </div>
            <Progress value={score} className="h-2 mb-4" />

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CHECKS.map(check => {
                const has = check.getValue(entry);
                const Icon = check.icon;
                return (
                  <div
                    key={check.key}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 border",
                      has ? "bg-emerald-400/5 border-emerald-400/15" : "bg-red-400/5 border-red-400/15"
                    )}
                  >
                    <Icon className={cn("w-3.5 h-3.5 flex-shrink-0", has ? check.color : "text-red-400/60")} />
                    <span className={cn("font-mono text-[10px] truncate", has ? "text-foreground/80" : "text-muted-foreground/50")}>{check.label}</span>
                    <div className="ml-auto flex-shrink-0">
                      {has ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <XCircle className="w-3 h-3 text-red-400/60" />}
                    </div>
                  </div>
                );
              })}
            </div>

            {missing.length > 0 && (
              <div className="mt-4 p-3 rounded-lg bg-amber-400/5 border border-amber-400/20">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400 font-bold">Missing ({missing.length})</span>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground/60 leading-relaxed">
                  {missing.map(m => m.label).join(" · ")}
                </p>
              </div>
            )}
          </div>

          {/* Worth summary */}
          {totalWorth > 0 && (
            <div className="bg-card border border-card-border rounded-xl p-5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-3">Account Worth Breakdown</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Twitter", value: entry.twitterWorth },
                  { label: "Discord", value: entry.discordWorth },
                  { label: "Telegram", value: entry.telegramWorth },
                ].filter(i => Number(i.value) > 0).map(i => (
                  <div key={i.label} className="bg-muted/20 rounded-lg p-3 border border-border/30">
                    <p className="font-mono text-[9px] text-muted-foreground/50 uppercase">{i.label}</p>
                    <p className="font-mono text-base font-bold text-amber-400">${Number(i.value).toFixed(0)}</p>
                  </div>
                ))}
                <div className="bg-amber-400/5 rounded-lg p-3 border border-amber-400/20">
                  <p className="font-mono text-[9px] text-amber-400/70 uppercase">Total</p>
                  <p className="font-mono text-base font-bold text-amber-400">${totalWorth.toFixed(0)}</p>
                </div>
              </div>
            </div>
          )}

          {/* Chips */}
          <div className="bg-card border border-card-border rounded-xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-3">Connected Accounts</p>
            <div className="flex flex-wrap gap-2">
              {entry.email && <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">EMAIL</span>}
              {entry.twitterUsername && (
                <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-sky-400/10 text-sky-400 border border-sky-400/20 flex items-center gap-1">
                  @{entry.twitterUsername}
                  {entry.twitterBanned && <Ban className="w-2.5 h-2.5 text-red-400" />}
                </span>
              )}
              {entry.discordUsername && (
                <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-indigo-400/10 text-indigo-400 border border-indigo-400/20 flex items-center gap-1">
                  {entry.discordUsername}
                  {entry.discordBanned && <Ban className="w-2.5 h-2.5 text-red-400" />}
                </span>
              )}
              {entry.telegramUsername && (
                <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-blue-400/10 text-blue-400 border border-blue-400/20 flex items-center gap-1">
                  @{entry.telegramUsername}
                  {entry.telegramBanned && <Ban className="w-2.5 h-2.5 text-red-400" />}
                </span>
              )}
              {(entry.twitter2fa || entry.discord2fa || entry.telegram2fa) && <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">2FA ENABLED</span>}
              {entry.hasSeedPhrase && <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-violet-400/10 text-violet-400 border border-violet-400/20">SEED PHRASE</span>}
              {Array.isArray(entry.walletAddresses) && entry.walletAddresses.length > 0 && (
                <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-amber-400/10 text-amber-400 border border-amber-400/20">{entry.walletAddresses.length} WALLET{entry.walletAddresses.length > 1 ? "S" : ""}</span>
              )}
              {others.length > 0 && <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-orange-400/10 text-orange-400 border border-orange-400/20">{others.length} OTHER</span>}
              {Number(entry.followers) > 0 && (
                <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-fuchsia-400/10 text-fuchsia-400 border border-fuchsia-400/20 flex items-center gap-1">
                  <Users className="w-2.5 h-2.5" /> {Number(entry.followers).toLocaleString()} FOLLOWERS
                </span>
              )}
              {entry.driveWalletAddress && <span className="font-mono text-[10px] px-2.5 py-1 rounded-full bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 flex items-center gap-1"><HardDrive className="w-2.5 h-2.5" /> DRIVE WALLET</span>}
              {!entry.email && !entry.twitterUsername && !entry.discordUsername && !entry.telegramUsername && (
                <span className="font-mono text-[10px] text-muted-foreground/40">No accounts linked yet</span>
              )}
            </div>
          </div>

          {/* Linked Entities — mark this entity as an alt of / sharing a wallet
              with another entity in the vault. See components/vault/linked-entities-section.tsx */}
          <LinkedEntitiesSection entityId={entry.id} />

          {/* Attachments — encrypted file storage (ID scan, contract, etc) for
              this entity. See components/vault/attachments-section.tsx */}
          <AttachmentsSection entityId={entry.id} />
        </div>
      )}

      <ValueEntryDialog
        open={valueDialogOpen}
        onOpenChange={setValueDialogOpen}
        sourceType="vault"
        sourceId={entry.id}
        title={entry.projectName}
        targets={valueTargets}
        defaultTarget={valueDefaultTarget}
        onSaved={() => queryClient.invalidateQueries()}
      />
      <FollowerEntryDialog
        open={followerDialogOpen}
        onOpenChange={setFollowerDialogOpen}
        sourceId={entry.id}
        title={entry.projectName}
        targets={followerTargets}
        defaultTarget={followerDefaultTarget}
        onSaved={() => queryClient.invalidateQueries()}
      />

      {/* Credentials Tab */}
      {tab === "credentials" && (
        <div className="space-y-3">
          <PlatformSubTabs subTab={platformSubTab} onChange={setPlatformSubTab} />

          {platformSubTab === "main" && (
            <Section title="Account Credentials" color="text-cyan-400">
              <CredRow label="Username" value={entry.username} field="username" entryId={entry.id} />
              <CredRow label="Acct. Pass" value={entry.accountPassword} field="accountPassword" entryId={entry.id} />
              <CredRow label="Email" value={entry.email} field="email" entryId={entry.id} />
              <CredRow label="Email Pass" value={entry.emailPassword} field="emailPassword" entryId={entry.id} />
              <CredRow label="Acct. 2FA" value={entry.account2fa} field="account2fa" entryId={entry.id} />
              <CredRow label="Acct. Backup" value={entry.accountBackupCode} field="accountBackupCode" entryId={entry.id} />
              <CredRow label="Email 2FA" value={entry.email2fa} field="email2fa" entryId={entry.id} />
              <CredRow label="Email Backup" value={entry.emailBackupCode} field="emailBackupCode" entryId={entry.id} />
              {!entry.username && !entry.email && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No credentials added</p>
              )}
            </Section>
          )}

          {platformSubTab === "recovery" && (
            <Section title="Account Recovery" color="text-cyan-400">
              <CredRow label="Rec. Email" value={entry.emailRecovery} field="emailRecovery" entryId={entry.id} />
              <CredRow label="Rec. Pass" value={entry.emailRecoveryPassword} field="emailRecoveryPassword" entryId={entry.id} />
              <CredRow label="Rec. 2FA" value={entry.recovery2fa} field="recovery2fa" entryId={entry.id} />
              <CredRow label="Rec. Backup" value={entry.recoveryBackupCode} field="recoveryBackupCode" entryId={entry.id} />
              {!entry.emailRecovery && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No recovery info added</p>
              )}
            </Section>
          )}

          {platformSubTab === "info" && (
            <Section title="Account Info" color="text-cyan-400">
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Last Login</span>
                <span className="font-mono text-xs text-foreground/80">{entry.lastLoginAt ? new Date(entry.lastLoginAt).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Create Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.createDate ? new Date(entry.createDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.buyDate ? new Date(entry.buyDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Value</span>
                <span className="font-mono text-xs font-bold text-cyan-400">${entry.currentBuyValue || 0}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Worth</span>
                <span className="font-mono text-xs font-bold text-amber-400">${entry.currentValue || 0}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Followers</span>
                <span className="font-mono text-xs text-foreground/80">{entry.followers || "—"}</span>
              </div>
              <div className="pt-3 flex gap-2 flex-wrap">
                <ValueEntryButton onClick={() => openValueDialog(undefined)} />
                <FollowerEntryButton onClick={() => openFollowerDialog(undefined)} />
              </div>
              <div className="pt-3 space-y-2">
                <ValuePnlPanel metric="value" sourceType="vault" sourceId={entry.id} target="entity" />
                <ValuePnlPanel metric="follower" sourceType="vault" sourceId={entry.id} target="entity" />
              </div>
            </Section>
          )}
        </div>
      )}

      {/* Twitter Tab */}
      {tab === "twitter" && (
        <div className="space-y-3">
          <PlatformSubTabs subTab={platformSubTab} onChange={setPlatformSubTab} />

          {platformSubTab === "main" && (
            <Section
              title="Twitter / X"
              color="text-sky-400"
              right={entry.twitterUsername ? (
                <PlatformBanToggle banned={!!entry.twitterBanned} pending={platformBanPending === "twitter"} onClick={() => handleTogglePlatformBan("twitter", !!entry.twitterBanned)} />
              ) : undefined}
            >
              <CredRow label="Username" value={entry.twitterUsername} field="twitterUsername" entryId={entry.id} />
              <CredRow label="Password" value={entry.twitterPassword} field="twitterPassword" entryId={entry.id} />
              <CredRow label="Email" value={entry.twitterEmail} field="twitterEmail" entryId={entry.id} />
              <CredRow label="Email Pass" value={entry.twitterEmailPassword} field="twitterEmailPassword" entryId={entry.id} />
              <CredRow label="Acct. 2FA" value={entry.twitter2fa} field="twitter2fa" entryId={entry.id} />
              <CredRow label="Acct. Backup" value={entry.twitterAccountBackupCode} field="twitterAccountBackupCode" entryId={entry.id} />
              <CredRow label="Email 2FA" value={entry.twitterEmail2fa} field="twitterEmail2fa" entryId={entry.id} />
              <CredRow label="Email Backup" value={entry.twitterEmailBackupCode} field="twitterEmailBackupCode" entryId={entry.id} />
              {!entry.twitterUsername && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No Twitter account linked</p>
              )}
              {entry.twitterNotes && (
                <p className="font-mono text-xs text-muted-foreground leading-relaxed py-3 border-t border-border/20 mt-2">{entry.twitterNotes}</p>
              )}
            </Section>
          )}

          {platformSubTab === "recovery" && (
            <Section title="Twitter / X · Recovery" color="text-sky-400">
              <CredRow label="Rec. Email" value={entry.twitterEmailRecovery} field="twitterEmailRecovery" entryId={entry.id} />
              <CredRow label="Rec. Pass" value={entry.twitterEmailRecoveryPassword} field="twitterEmailRecoveryPassword" entryId={entry.id} />
              <CredRow label="Rec. 2FA" value={entry.twitterRecovery2fa} field="twitterRecovery2fa" entryId={entry.id} />
              <CredRow label="Rec. Backup" value={entry.twitterRecoveryBackupCode} field="twitterRecoveryBackupCode" entryId={entry.id} />
              {!entry.twitterEmailRecovery && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No recovery info added</p>
              )}
            </Section>
          )}

          {platformSubTab === "info" && (
            <Section title="Twitter / X · Info" color="text-sky-400">
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Last Login</span>
                <span className="font-mono text-xs text-foreground/80">{entry.twitterLastLoginAt ? new Date(entry.twitterLastLoginAt).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.twitterBuyDate ? new Date(entry.twitterBuyDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Create Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.twitterCreateDate ? new Date(entry.twitterCreateDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Account Age</span>
                <span className="font-mono text-xs text-foreground/80">{entry.twitterAge || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Followers</span>
                <span className="font-mono text-xs text-foreground/80">{entry.twitterFollowers || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Value</span>
                <span className="font-mono text-xs font-bold text-cyan-400">${entry.twitterBuyValue || 0}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Worth</span>
                <span className="font-mono text-xs font-bold text-amber-400">${entry.twitterWorth || 0}</span>
              </div>
              <div className="pt-3 flex gap-2 flex-wrap">
                <ValueEntryButton onClick={() => openValueDialog("twitter")} />
                <FollowerEntryButton onClick={() => openFollowerDialog("twitter")} />
              </div>
              <div className="pt-3 space-y-2">
                <ValuePnlPanel metric="value" title="Twitter Value P&L" sourceType="vault" sourceId={entry.id} target="twitter" />
                <ValuePnlPanel metric="follower" title="Twitter Followers History" sourceType="vault" sourceId={entry.id} target="twitter" />
              </div>
            </Section>
          )}
        </div>
      )}

      {/* Discord Tab */}
      {tab === "discord" && (
        <div className="space-y-3">
          <PlatformSubTabs subTab={platformSubTab} onChange={setPlatformSubTab} />

          {platformSubTab === "main" && (
            <Section
              title="Discord"
              color="text-indigo-400"
              right={entry.discordUsername ? (
                <PlatformBanToggle banned={!!entry.discordBanned} pending={platformBanPending === "discord"} onClick={() => handleTogglePlatformBan("discord", !!entry.discordBanned)} />
              ) : undefined}
            >
              <CredRow label="Username" value={entry.discordUsername} field="discordUsername" entryId={entry.id} />
              <CredRow label="Password" value={entry.discordPassword} field="discordPassword" entryId={entry.id} />
              <CredRow label="Email" value={entry.discordEmail} field="discordEmail" entryId={entry.id} />
              <CredRow label="Email Pass" value={entry.discordEmailPassword} field="discordEmailPassword" entryId={entry.id} />
              <CredRow label="Acct. 2FA" value={entry.discord2fa} field="discord2fa" entryId={entry.id} />
              <CredRow label="Acct. Backup" value={entry.discordAccountBackupCode} field="discordAccountBackupCode" entryId={entry.id} />
              <CredRow label="Email 2FA" value={entry.discordEmail2fa} field="discordEmail2fa" entryId={entry.id} />
              <CredRow label="Email Backup" value={entry.discordEmailBackupCode} field="discordEmailBackupCode" entryId={entry.id} />
              {!entry.discordUsername && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No Discord account linked</p>
              )}
              {entry.discordNotes && (
                <p className="font-mono text-xs text-muted-foreground leading-relaxed py-3 border-t border-border/20 mt-2">{entry.discordNotes}</p>
              )}
            </Section>
          )}

          {platformSubTab === "recovery" && (
            <Section title="Discord · Recovery" color="text-indigo-400">
              <CredRow label="Rec. Email" value={entry.discordEmailRecovery} field="discordEmailRecovery" entryId={entry.id} />
              <CredRow label="Rec. Pass" value={entry.discordEmailRecoveryPassword} field="discordEmailRecoveryPassword" entryId={entry.id} />
              <CredRow label="Rec. 2FA" value={entry.discordRecovery2fa} field="discordRecovery2fa" entryId={entry.id} />
              <CredRow label="Rec. Backup" value={entry.discordRecoveryBackupCode} field="discordRecoveryBackupCode" entryId={entry.id} />
              {!entry.discordEmailRecovery && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No recovery info added</p>
              )}
            </Section>
          )}

          {platformSubTab === "info" && (
            <Section title="Discord · Info" color="text-indigo-400">
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Last Login</span>
                <span className="font-mono text-xs text-foreground/80">{entry.discordLastLoginAt ? new Date(entry.discordLastLoginAt).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.discordBuyDate ? new Date(entry.discordBuyDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Create Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.discordCreateDate ? new Date(entry.discordCreateDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Account Age</span>
                <span className="font-mono text-xs text-foreground/80">{entry.discordAge || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Members</span>
                <span className="font-mono text-xs text-foreground/80">{entry.discordFollowers || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Value</span>
                <span className="font-mono text-xs font-bold text-cyan-400">${entry.discordBuyValue || 0}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Worth</span>
                <span className="font-mono text-xs font-bold text-amber-400">${entry.discordWorth || 0}</span>
              </div>
              <div className="pt-3 flex gap-2 flex-wrap">
                <ValueEntryButton onClick={() => openValueDialog("discord")} />
                <FollowerEntryButton onClick={() => openFollowerDialog("discord")} />
              </div>
              <div className="pt-3 space-y-2">
                <ValuePnlPanel metric="value" title="Discord Value P&L" sourceType="vault" sourceId={entry.id} target="discord" />
                <ValuePnlPanel metric="follower" title="Discord Members History" sourceType="vault" sourceId={entry.id} target="discord" />
              </div>
            </Section>
          )}
        </div>
      )}

      {/* Telegram Tab */}
      {tab === "telegram" && (
        <div className="space-y-3">
          <PlatformSubTabs subTab={platformSubTab} onChange={setPlatformSubTab} />

          {platformSubTab === "main" && (
            <Section
              title="Telegram"
              color="text-blue-400"
              right={(entry.telegramUsername || entry.telegramPhone) ? (
                <PlatformBanToggle banned={!!entry.telegramBanned} pending={platformBanPending === "telegram"} onClick={() => handleTogglePlatformBan("telegram", !!entry.telegramBanned)} />
              ) : undefined}
            >
              <CredRow label="Username" value={entry.telegramUsername} field="telegramUsername" entryId={entry.id} />
              <CredRow label="Phone" value={entry.telegramPhone} field="telegramPhone" entryId={entry.id} />
              <CredRow label="Password" value={entry.telegramPassword} field="telegramPassword" entryId={entry.id} />
              <CredRow label="Email" value={entry.telegramLinkedEmail} field="telegramLinkedEmail" entryId={entry.id} />
              <CredRow label="Email Pass" value={entry.telegramLinkedEmailPassword} field="telegramLinkedEmailPassword" entryId={entry.id} />
              <CredRow label="Acct. 2FA" value={entry.telegram2fa} field="telegram2fa" entryId={entry.id} />
              <CredRow label="Acct. Backup" value={entry.telegramAccountBackupCode} field="telegramAccountBackupCode" entryId={entry.id} />
              <CredRow label="Email 2FA" value={entry.telegramEmail2fa} field="telegramEmail2fa" entryId={entry.id} />
              <CredRow label="Email Backup" value={entry.telegramEmailBackupCode} field="telegramEmailBackupCode" entryId={entry.id} />
              {!entry.telegramUsername && !entry.telegramPhone && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No Telegram account linked</p>
              )}
              {entry.telegramNotes && (
                <p className="font-mono text-xs text-muted-foreground leading-relaxed py-3 border-t border-border/20 mt-2">{entry.telegramNotes}</p>
              )}
            </Section>
          )}

          {platformSubTab === "recovery" && (
            <Section title="Telegram · Recovery" color="text-blue-400">
              <CredRow label="Rec. 2FA" value={entry.telegramRecovery2fa} field="telegramRecovery2fa" entryId={entry.id} />
              <CredRow label="Rec. Backup" value={entry.telegramRecoveryBackupCode} field="telegramRecoveryBackupCode" entryId={entry.id} />
              {!entry.telegramRecovery2fa && !entry.telegramRecoveryBackupCode && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No recovery info added</p>
              )}
            </Section>
          )}

          {platformSubTab === "info" && (
            <Section title="Telegram · Info" color="text-blue-400">
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Last Login</span>
                <span className="font-mono text-xs text-foreground/80">{entry.telegramLastLoginAt ? new Date(entry.telegramLastLoginAt).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.telegramBuyDate ? new Date(entry.telegramBuyDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Create Date</span>
                <span className="font-mono text-xs text-foreground/80">{entry.telegramCreateDate ? new Date(entry.telegramCreateDate).toLocaleDateString() : "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Account Age</span>
                <span className="font-mono text-xs text-foreground/80">{entry.telegramAge || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Followers</span>
                <span className="font-mono text-xs text-foreground/80">{entry.telegramFollowers || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border/20">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Buy Value</span>
                <span className="font-mono text-xs font-bold text-cyan-400">${entry.telegramBuyValue || 0}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Worth</span>
                <span className="font-mono text-xs font-bold text-amber-400">${entry.telegramWorth || 0}</span>
              </div>
              <div className="pt-3 flex gap-2 flex-wrap">
                <ValueEntryButton onClick={() => openValueDialog("telegram")} />
                <FollowerEntryButton onClick={() => openFollowerDialog("telegram")} />
              </div>
              <div className="pt-3 space-y-2">
                <ValuePnlPanel metric="value" title="Telegram Value P&L" sourceType="vault" sourceId={entry.id} target="telegram" />
                <ValuePnlPanel metric="follower" title="Telegram Followers History" sourceType="vault" sourceId={entry.id} target="telegram" />
              </div>
            </Section>
          )}
        </div>
      )}

      {/* Wallet Tab */}
      {tab === "wallet" && (
        <div className="space-y-4">
          {/* Drive wallet — fixed, set-once record */}
          {entry.driveWalletAddress ? (
            <div className="bg-card border border-card-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-emerald-400 flex items-center gap-2">
                <HardDrive className="w-3.5 h-3.5" /> Drive Wallet
                <Badge variant="outline" className="ml-auto font-mono text-[9px] px-1.5 border-emerald-400/20 text-emerald-400 bg-emerald-400/5">Fixed</Badge>
              </div>
              <div className="px-4 py-3 space-y-2">
                {entry.driveWalletLabel && (
                  <p className="font-mono text-xs text-foreground/90">{entry.driveWalletLabel}</p>
                )}
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-foreground/80 flex-1 break-all">{entry.driveWalletAddress}</span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <CopyBtn value={entry.driveWalletAddress} />
                    <button onClick={() => setQrAddress(entry.driveWalletAddress)} className="p-1.5 rounded text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors">
                      <QrCode className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                {entry.driveWalletNote && (
                  <p className="font-mono text-[10px] text-muted-foreground/50">{entry.driveWalletNote}</p>
                )}
                {entry.driveWalletSetAt && (
                  <p className="font-mono text-[9px] text-muted-foreground/30">Set {new Date(entry.driveWalletSetAt).toLocaleDateString()} — cannot be edited</p>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-card border border-card-border rounded-xl p-6 text-center">
              <HardDrive className="w-7 h-7 text-muted-foreground/20 mx-auto mb-2" />
              <p className="font-mono text-xs text-muted-foreground/40">No Drive wallet set yet</p>
              <p className="font-mono text-[10px] text-muted-foreground/30 mt-1">Set it once from Edit → Account → Wallet → Drive</p>
            </div>
          )}

          {/* Live wallet worth — read-only RPC balance pull across ETH/BASE/MATIC/BSC/ARB/OP,
              replaces manual worth entry for the on-chain portion (see lib/wallet-worth-api.ts). */}
          {(entry.driveWalletAddress || (Array.isArray(entry.walletAddresses) && entry.walletAddresses.length > 0)) && (
            <div className="bg-card border border-card-border rounded-xl px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">Live Wallet Worth</p>
                <p className="font-mono text-lg font-bold text-emerald-400">${(entry.walletWorthUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                <p className="font-mono text-[9px] text-muted-foreground/30">
                  {entry.walletWorthSyncedAt ? `Synced ${new Date(entry.walletWorthSyncedAt).toLocaleString()}` : "Not synced yet"}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={worthRefreshing}
                onClick={async () => {
                  setWorthRefreshing(true);
                  try {
                    await refreshWalletWorth(entry.id);
                    await queryClient.invalidateQueries();
                    toast({ title: "Wallet worth updated", description: "Live balances pulled across ETH/BASE/MATIC/BSC/ARB/OP." });
                  } catch (err: any) {
                    toast({ title: "Refresh failed", description: err?.message ?? "Could not read chain balances", variant: "destructive" });
                  } finally {
                    setWorthRefreshing(false);
                  }
                }}
                className="font-mono text-[10px] gap-1.5 flex-shrink-0"
              >
                <RefreshCw className={cn("w-3 h-3", worthRefreshing && "animate-spin")} />
                {worthRefreshing ? "Checking chains…" : "Refresh"}
              </Button>
            </div>
          )}

          {/* Wallet addresses */}
          {Array.isArray(entry.walletAddresses) && entry.walletAddresses.length > 0 ? (
            <Section title="Wallet Addresses" color="text-amber-400">
              {entry.walletAddresses.map((addr: string, i: number) => (
                <div key={i} className="flex items-center gap-2 py-2 border-b border-border/20 last:border-0">
                  <span className="font-mono text-[11px] text-foreground/80 flex-1 break-all">{addr}</span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <CopyBtn value={addr} />
                    <button onClick={() => setQrAddress(addr)} className="p-1.5 rounded text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors">
                      <QrCode className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </Section>
          ) : (
            <div className="bg-card border border-card-border rounded-xl p-8 text-center">
              <Wallet className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="font-mono text-xs text-muted-foreground/40">No wallet addresses added</p>
            </div>
          )}

          {/* Seed phrase note */}
          {entry.hasSeedPhrase && (
            <div className="p-4 rounded-xl bg-violet-400/5 border border-violet-400/20">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-violet-400" />
                <span className="font-mono text-xs text-violet-400 font-bold">Seed Phrase Stored</span>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground/60 mt-1">
                Seed phrase is encrypted and stored — view in the Vault Wallet tab.
              </p>
            </div>
          )}

          {/* Backup codes */}
          {Array.isArray(entry.backupCodes) && entry.backupCodes.length > 0 && (
            <Section title="Backup Codes" color="text-orange-400">
              <div className="grid grid-cols-2 gap-1.5 py-2">
                {entry.backupCodes.map((code: string, i: number) => (
                  <div key={i} className="flex items-center justify-between bg-muted/20 rounded px-2 py-1.5 border border-border/30">
                    <span className="font-mono text-[10px] text-foreground/70">{code}</span>
                    <CopyBtn value={code} />
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {/* Gas Tab — live per-chain native-coin balance + real-time simulation
          (gas price, how many more sends/token txs this entity can afford) */}
      {tab === "gas" && <EntityGasTab entryId={entry.id} />}

      {/* Other Tab */}
      {tab === "other" && (
        <div className="space-y-4">
          {/* Notes */}
          {entry.notes && (
            <Section title="Notes" color="text-muted-foreground">
              <p className="font-mono text-xs text-muted-foreground leading-relaxed py-3">{entry.notes}</p>
            </Section>
          )}

          {/* Other accounts */}
          {others.length > 0 ? (
            <div className="space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 px-1">Other Accounts ({others.length})</p>
              {others.map((acc: any, i: number) => (
                <div key={i} className={cn("bg-card border rounded-xl overflow-hidden", acc.banned ? "border-red-400/30" : "border-card-border")}>
                  <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-xs font-bold text-orange-400 uppercase tracking-wider truncate">{acc.platform}</span>
                      {acc.banned && (
                        <Badge variant="outline" className="font-mono text-[8px] uppercase tracking-wider px-1.5 text-red-400 border-red-400/30 bg-red-400/5 flex items-center gap-1 flex-shrink-0">
                          <Ban className="w-2 h-2" /> Banned
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {acc.worth && <span className="font-mono text-xs font-bold text-amber-400">${acc.worth}</span>}
                      <PlatformBanToggle banned={!!acc.banned} pending={otherBanPendingIdx === i} onClick={() => handleToggleOtherBan(i, !!acc.banned)} />
                    </div>
                  </div>
                  <div className="px-4 py-2">
                    <CredRow label="Username" value={acc.username} />
                    <CredRow label="Password" value={acc.password} />
                    <CredRow label="Email" value={acc.email} />
                    {acc.metric && (
                      <div className="flex items-center gap-3 py-2 border-b border-border/20">
                        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-20 flex-shrink-0">{metricLabelFor(acc.platform)}</span>
                        <span className="font-mono text-xs text-foreground/80">{acc.metric}</span>
                      </div>
                    )}
                    {acc.age && (
                      <div className="flex items-center gap-3 py-2">
                        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-20 flex-shrink-0">Age</span>
                        <span className="font-mono text-xs text-foreground/80">{acc.age}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : !entry.notes ? (
            <div className="bg-card border border-card-border rounded-xl p-8 text-center">
              <Smartphone className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="font-mono text-xs text-muted-foreground/40">No other accounts or notes</p>
            </div>
          ) : null}
        </div>
      )}

      {/* QR Dialog */}
      <Dialog open={!!qrAddress} onOpenChange={() => setQrAddress(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">Wallet QR Code</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-3">
            {qrAddress && <QRCodeSVG value={qrAddress} size={180} bgColor="transparent" fgColor="#22d3ee" />}
            <p className="font-mono text-[10px] text-muted-foreground/60 break-all text-center">{qrAddress}</p>
          </div>
        </DialogContent>
      </Dialog>

      <ReceiptLinkDialog
        open={receiptDialogOpen}
        onOpenChange={setReceiptDialogOpen}
        itemId={entry.id}
        itemLabel={entry.projectName || entry.entitySerial}
        api={vaultEntityReceiptApi}
        title="Share Vault Entity Receipt"
      />

      {/* Delete Confirm Dialog */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Move to Trash?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">
            <strong>{entry.projectName}</strong> will move to Vault → Trash. You can restore it from there within 30 days, after which it's permanently deleted.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteMutation.isPending} className="font-mono text-xs">
              {deleteMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Settings Dialog — configure IMAP/SMTP for this entity's email
          directly, without going into the full edit flow. Saves through the
          same /api/email-accounts endpoint as everywhere else. */}
      <Dialog open={emailSettingsOpen} onOpenChange={setEmailSettingsOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary" /> Email Settings
            </DialogTitle>
          </DialogHeader>
          {!entry.email ? (
            <p className="font-mono text-xs text-muted-foreground py-4 text-center">
              Add an email address on the Credentials tab first, then come back here to configure IMAP/SMTP.
            </p>
          ) : emailAccountsLoading && emailAccounts.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : (
            <ImapSmtpForm
              emailAddress={entry.email}
              existingAccount={emailAccounts.find(a => a.emailAddress === entry.email) ?? null}
              token={token}
              onSaved={() => { fetchEmailAccounts(); setEmailSettingsOpen(false); }}
              onDeleted={() => { fetchEmailAccounts(); setEmailSettingsOpen(false); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
