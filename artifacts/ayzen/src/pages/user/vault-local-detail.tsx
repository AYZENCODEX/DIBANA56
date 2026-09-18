import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Shield, Eye, EyeOff, Copy, Check, Loader2, ChevronLeft, Edit3, Trash2,
  Calendar, BarChart2, Clock, UserCheck, Star, KeyRound,
  AlertTriangle, Zap, Plus, X, Smartphone, TrendingUp, Mail, Settings2, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ValueEntryDialog, ValueEntryButton } from "@/components/value-entry-dialog";
import { ValuePnlPanel } from "@/components/value-pnl-panel";
import { ReceiptLinkDialog } from "@/components/receipt-link-dialog";
import { localEntityReceiptApi } from "@/lib/receipt-api";
import {
  LOCAL_ACCOUNT_DEFAULT_CATEGORIES,
  getLocalAccountPlatformMeta,
} from "@/config/vault-local";
import { EntityPinGate } from "@/components/vault/entity-pin-gate";
import { HealthChecklistCard, HealthScoreBadge } from "@/components/vault/health-checklist";
import { LOCAL_ACCOUNT_HEALTH_CHECKS } from "@/config/columns/entity-view";
import { ImapSmtpForm, type EmailAccount } from "@/components/mail/imap-smtp-form";

const MAIL_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────
interface LocalAccount {
  id: number;
  user_id: number;
  category: string;
  label: string | null;
  username: string | null;
  email: string | null;
  password: string | null;
  recovery_email: string | null;
  recovery_email_password: string | null;
  backup_codes: string | null;
  twofa: string | null;
  recovery_email_twofa: string | null;
  followers: string | null;
  account_worth: number;
  buy_price: number;
  account_create_date: string | null;
  account_buy_date: string | null;
  account_last_login_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountPoints {
  id: number;
  amount: number;
  notes: string | null;
  created_at: string;
}

function calcAge(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days < 1) return "Today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function calcROI(worth: number, buyPrice: number): number | null {
  if (!buyPrice || buyPrice === 0) return null;
  return ((worth - buyPrice) / buyPrice) * 100;
}

// ─── SecretField ──────────────────────────────────────────────────────────────
function SecretField({ label, value }: { label: string; value: string | null | undefined }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/20 last:border-0 group">
      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-24 flex-shrink-0">{label}</span>
      <span className={cn("flex-1 font-mono text-xs truncate", shown ? "text-foreground/90" : "text-muted-foreground/50")}>
        {shown ? value : "•".repeat(Math.min(value.length, 16))}
      </span>
      <div className="flex items-center gap-1 transition-opacity">
        <button onClick={() => setShown(s => !s)} className="p-1 rounded text-muted-foreground/40 hover:text-primary transition-colors">
          {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
        <button onClick={copy} className={cn("p-1 rounded transition-colors", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary")}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-muted/20 border border-border/30 rounded-xl px-4 py-3">
      <div className="font-mono text-[9px] text-muted-foreground/50 uppercase tracking-wider">{label}</div>
      <div className={cn("font-mono font-bold text-base mt-0.5", color ?? "text-foreground")}>{value}</div>
    </div>
  );
}

type DetailTab = "credentials" | "health" | "stats" | "dates" | "points";
type CredSubTab = "main" | "recovery";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "credentials", label: "Credentials" },
  { id: "health",      label: "Health" },
  { id: "stats",       label: "Stats & Value" },
  { id: "dates",       label: "Dates" },
  { id: "points",      label: "Points" },
];

// Phase 5 — Vault Security: "Local" accounts are entities in the same shared
// vault as the main Entity type, so viewing their details is gated by the
// same entity-view PIN (see components/vault/entity-pin-gate.tsx).
export default function VaultLocalDetail() {
  return (
    <EntityPinGate>
      <VaultLocalDetailContent />
    </EntityPinGate>
  );
}

function VaultLocalDetailContent() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { token } = useAuth() as any;

  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>("credentials");
  const [credSubTab, setCredSubTab] = useState<CredSubTab>("main");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [valueDialogOpen, setValueDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  // Email Settings — configure IMAP/SMTP for this account's email directly
  // from the detail view, same /api/email-accounts data source as the Mail
  // Hub Overview and Settings page.
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailAccountsLoading, setEmailAccountsLoading] = useState(false);

  const fetchEmailAccounts = useCallback(async () => {
    setEmailAccountsLoading(true);
    try {
      const res = await fetch(`${MAIL_BASE}/api/email-accounts`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setEmailAccounts(await res.json());
    } catch {} finally { setEmailAccountsLoading(false); }
  }, [token]);

  useEffect(() => {
    if (emailSettingsOpen && emailAccounts.length === 0 && !emailAccountsLoading) fetchEmailAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailSettingsOpen]);

  // ── Edit dialog state ───────────────────────────────────────────────────────
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [editSection, setEditSection] = useState<"creds" | "dates" | "value">("creds");
  const [saving, setSaving] = useState(false);

  // Points state
  const [points, setPoints] = useState<AccountPoints[]>([]);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointAmount, setPointAmount] = useState("");
  const [pointNotes, setPointNotes] = useState("");
  const [addingPoint, setAddingPoint] = useState(false);

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const loadAccount = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<LocalAccount>(`/api/local-accounts/${params.id}`);
      setAccount(data);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  const loadPoints = useCallback(async () => {
    if (!params.id) return;
    setPointsLoading(true);
    try {
      const data = await customFetch<{ entries: AccountPoints[]; total: number }>(`/api/local-accounts/${params.id}/points`);
      setPoints(Array.isArray(data) ? data : (data?.entries ?? []));
    } catch { setPoints([]); }
    finally { setPointsLoading(false); }
  }, [params.id]);

  useEffect(() => { loadAccount(); }, [loadAccount]);

  useEffect(() => {
    if (tab === "points") loadPoints();
  }, [tab, loadPoints]);

  const handleAddPoint = async () => {
    if (!params.id || !pointAmount || isNaN(Number(pointAmount))) return;
    setAddingPoint(true);
    try {
      await customFetch<unknown>(`/api/local-accounts/${params.id}/points`, {
        method: "POST",
        body: JSON.stringify({ amount: Number(pointAmount), notes: pointNotes || null }),
      });
      toast({ title: `+${pointAmount} points added` });
      setPointAmount("");
      setPointNotes("");
      await loadPoints();
    } catch {
      toast({ variant: "destructive", title: "Failed to add points" });
    } finally { setAddingPoint(false); }
  };

  const handleDeletePoint = async (pointId: number) => {
    try {
      await customFetch<unknown>(`/api/local-accounts/points/${pointId}`, { method: "DELETE" });
      await loadPoints();
    } catch {
      toast({ variant: "destructive", title: "Failed to delete" });
    }
  };

  const handleDelete = async () => {
    if (!account) return;
    setDeleting(true);
    try {
      await customFetch<unknown>(`/api/local-accounts/${account.id}`, { method: "DELETE" });
      toast({ title: "Account deleted" });
      navigate("/vault?tab=local");
    } catch {
      toast({ variant: "destructive", title: "Delete failed" });
    } finally { setDeleting(false); setConfirmDelete(false); }
  };

  const openEdit = () => {
    if (!account) return;
    setEditForm({
      category: account.category || "",
      label: account.label || "",
      username: account.username || "",
      email: account.email || "",
      password: account.password || "",
      recovery_email: account.recovery_email || "",
      recovery_email_password: account.recovery_email_password || "",
      backup_codes: account.backup_codes || "",
      twofa: account.twofa || "",
      recovery_email_twofa: account.recovery_email_twofa || "",
      followers: account.followers || "",
      account_worth: account.account_worth || 0,
      buy_price: account.buy_price || 0,
      account_create_date: account.account_create_date ? account.account_create_date.slice(0, 10) : "",
      account_buy_date: account.account_buy_date ? account.account_buy_date.slice(0, 10) : "",
      account_last_login_date: account.account_last_login_date ? account.account_last_login_date.slice(0, 10) : "",
      notes: account.notes || "",
    });
    setEditSection("creds");
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    if (!account) return;
    setSaving(true);
    try {
      const payload = {
        category: editForm.category,
        label: editForm.label || null,
        username: editForm.username || null,
        email: editForm.email || null,
        password: editForm.password || null,
        recoveryEmail: editForm.recovery_email || null,
        recoveryEmailPassword: editForm.recovery_email_password || null,
        backupCodes: editForm.backup_codes || null,
        twofa: editForm.twofa || null,
        recoveryEmailTwofa: editForm.recovery_email_twofa || null,
        followers: editForm.followers || null,
        accountWorth: Number(editForm.account_worth) || 0,
        buyPrice: Number(editForm.buy_price) || 0,
        accountCreateDate: editForm.account_create_date || null,
        accountBuyDate: editForm.account_buy_date || null,
        accountLastLoginDate: editForm.account_last_login_date || null,
        notes: editForm.notes || null,
      };
      await customFetch<unknown>(`/api/local-accounts/${account.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      toast({ title: "Account updated" });
      setEditOpen(false);
      await loadAccount();
    } catch {
      toast({ variant: "destructive", title: "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  const ef = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setEditForm(p => ({ ...p, [key]: e.target.value }));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=local")} className="font-mono text-xs gap-1.5">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
        </Button>
        <div className="text-center py-20">
          <Shield className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground/60">Account not found</p>
        </div>
      </div>
    );
  }

  const roi = calcROI(account.account_worth, account.buy_price);
  const age = calcAge(account.account_create_date);
  const displayName = account.label || account.username || account.email || `Account #${account.id}`;
  const totalPoints = points.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="space-y-5 page-enter max-w-2xl mx-auto">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=local")} className="font-mono text-xs gap-1.5 mb-3 -ml-2">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold font-mono tracking-tighter">{displayName}</h1>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className="font-mono text-[9px] px-1.5">{account.category}</Badge>
                <HealthScoreBadge checks={LOCAL_ACCOUNT_HEALTH_CHECKS} entry={account} />
                {age !== "—" && <span className="font-mono text-[10px] text-muted-foreground/50">{age} old</span>}
                {account.account_worth > 0 && (
                  <span className="font-mono text-[10px] font-bold text-emerald-400">${account.account_worth.toFixed(2)} worth</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <ValueEntryButton onClick={() => setValueDialogOpen(true)} />
            <Button variant="outline" size="sm" onClick={() => setReceiptDialogOpen(true)} className="font-mono text-xs gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Receipt
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate(`/vault/local/${account.id}/access`)} className="font-mono text-xs gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> Access
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEmailSettingsOpen(true)} className="font-mono text-xs gap-1.5">
              <Settings2 className="w-3.5 h-3.5" /> Email Settings
            </Button>
            <Button variant="outline" size="sm" onClick={openEdit} className="font-mono text-xs gap-1.5">
              <Edit3 className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} className="font-mono text-xs gap-1.5">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-muted/20 rounded-lg">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all",
              tab === t.id ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Credentials Tab */}
      {tab === "credentials" && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-cyan-400 flex items-center justify-between">
            <span>Credentials</span>
          </div>

          {/* Main / Recovery sub-tabs */}
          <div className="flex gap-1 px-4 pt-3 pb-1">
            {(["main", "recovery"] as CredSubTab[]).map(st => (
              <button
                key={st}
                onClick={() => setCredSubTab(st)}
                className={cn(
                  "px-3 py-1 rounded font-mono text-[9px] uppercase tracking-wider border transition-all",
                  credSubTab === st
                    ? "border-primary/40 bg-primary/10 text-primary font-bold"
                    : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
                )}
              >
                {st}
              </button>
            ))}
          </div>

          {credSubTab === "main" && (
            <div className="px-4 py-2">
              <SecretField label="Username" value={account.username} />
              <SecretField label="Email" value={account.email} />
              <SecretField label="Password" value={account.password} />
              {!account.username && !account.email && !account.password && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No main credentials stored</p>
              )}
            </div>
          )}

          {credSubTab === "recovery" && (
            <div className="px-4 py-2">
              <SecretField label="Rec. Email"  value={account.recovery_email} />
              <SecretField label="Rec. Pass"   value={account.recovery_email_password} />
              <SecretField label="2FA"         value={account.twofa} />
              <SecretField label="Rec. 2FA"    value={account.recovery_email_twofa} />
              <SecretField label="Backup Codes" value={account.backup_codes} />
              {!account.recovery_email && !account.twofa && !account.backup_codes && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No recovery credentials stored</p>
              )}
            </div>
          )}

          {account.notes && (
            <div className="px-4 pb-4 border-t border-border/20 mt-2">
              <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50 mb-2 mt-3">Notes</p>
              <p className="font-mono text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                {account.notes}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Health Tab — same checklist pattern as Entity/KYC Health */}
      {tab === "health" && (
        <HealthChecklistCard title="Local Account Health" checks={LOCAL_ACCOUNT_HEALTH_CHECKS} entry={account} />
      )}

      {/* Stats & Value Tab */}
      {tab === "stats" && (
        <div className="space-y-4">
          <div className="flex justify-end"><ValueEntryButton onClick={() => setValueDialogOpen(true)} /></div>
          <ValuePnlPanel compact sourceType="local" sourceId={account.id} />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {account.account_worth > 0 && (
              <StatCard label="Account Worth" value={`$${account.account_worth.toFixed(2)}`} color="text-emerald-400" />
            )}
            {account.buy_price > 0 && (
              <StatCard label="Buy Price" value={`$${account.buy_price.toFixed(2)}`} />
            )}
            {roi !== null && (
              <StatCard
                label="ROI"
                value={`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`}
                color={roi >= 0 ? "text-green-400" : "text-red-400"}
              />
            )}
            {account.followers && (
              <StatCard label="Followers / Metric" value={account.followers} color="text-primary" />
            )}
          </div>
          {account.account_worth === 0 && account.buy_price === 0 && !account.followers && (
            <div className="bg-card border border-card-border rounded-xl p-8 text-center">
              <BarChart2 className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="font-mono text-xs text-muted-foreground/40">No stats tracked yet — add a value snapshot to begin</p>
            </div>
          )}
        </div>
      )}

      <ValueEntryDialog
        open={valueDialogOpen}
        onOpenChange={setValueDialogOpen}
        sourceType="local"
        sourceId={account.id}
        title={displayName}
        targets={[{ value: "account", label: "Local account", currentValue: account.account_worth, currentBuyValue: account.buy_price }]}
        onSaved={loadAccount}
      />

      <ReceiptLinkDialog
        open={receiptDialogOpen}
        onOpenChange={setReceiptDialogOpen}
        itemId={account.id}
        itemLabel={displayName}
        api={localEntityReceiptApi}
        title="Share Local Entity Receipt"
      />

      {/* Dates Tab */}
      {tab === "dates" && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground/60">
            Important Dates
          </div>
          <div className="px-4 py-3 space-y-3">
            {account.account_create_date && (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Calendar className="w-3.5 h-3.5 text-primary" />
                </div>
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">Account Created</p>
                  <p className="font-mono text-xs text-foreground/90">{new Date(account.account_create_date).toLocaleDateString()}</p>
                  <p className="font-mono text-[9px] text-muted-foreground/50">{age !== "—" ? `${age} ago` : ""}</p>
                </div>
              </div>
            )}
            {account.account_buy_date && (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-400/10 flex items-center justify-center flex-shrink-0">
                  <Star className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">Date Purchased</p>
                  <p className="font-mono text-xs text-foreground/90">{new Date(account.account_buy_date).toLocaleDateString()}</p>
                </div>
              </div>
            )}
            {account.account_last_login_date && (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-400/10 flex items-center justify-center flex-shrink-0">
                  <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">Last Login</p>
                  <p className="font-mono text-xs text-foreground/90">{new Date(account.account_last_login_date).toLocaleDateString()}</p>
                </div>
              </div>
            )}
            {!account.account_create_date && !account.account_buy_date && !account.account_last_login_date && (
              <div className="py-8 text-center">
                <Clock className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="font-mono text-xs text-muted-foreground/40">No dates recorded</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Points Tab */}
      {tab === "points" && (
        <div className="space-y-4">
          {/* Balance card */}
          <div className="p-5 rounded-xl bg-gradient-to-br from-primary/10 to-violet-500/5 border border-primary/20 flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-primary/60 mb-1">Points Balance</div>
              <div className="font-mono text-3xl font-bold text-primary">{totalPoints.toLocaleString()}</div>
              <div className="font-mono text-[9px] text-muted-foreground/40 mt-0.5">{points.length} entries</div>
            </div>
            <div className="w-14 h-14 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Zap className="w-6 h-6 text-primary" />
            </div>
          </div>

          {/* Add points */}
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">Add Points</p>
            <div className="flex gap-2">
              <Input
                type="number"
                value={pointAmount}
                onChange={e => setPointAmount(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleAddPoint()}
                className="h-8 font-mono text-xs bg-input flex-1"
                placeholder="Amount (e.g. 500)"
              />
              <Button
                size="sm"
                onClick={handleAddPoint}
                disabled={addingPoint || !pointAmount}
                className="h-8 font-mono text-[10px] gap-1.5 px-3"
              >
                {addingPoint ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                Add
              </Button>
            </div>
            <Input
              value={pointNotes}
              onChange={e => setPointNotes(e.target.value)}
              className="h-8 font-mono text-xs bg-input"
              placeholder="Note (optional)"
            />
          </div>

          {/* History */}
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/30 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
              History
            </div>
            {pointsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-4 h-4 text-primary/40 animate-spin" />
              </div>
            ) : points.length === 0 ? (
              <div className="py-10 text-center">
                <Zap className="w-7 h-7 text-muted-foreground/20 mx-auto mb-2" />
                <p className="font-mono text-xs text-muted-foreground/40">No points recorded yet</p>
              </div>
            ) : (
              <div className="divide-y divide-border/30 max-h-80 overflow-y-auto">
                {points.map((p) => (
                  <div key={p.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/10 transition-colors group">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono font-bold text-primary">+{Number(p.amount).toLocaleString()}</span>
                      {p.notes && <span className="font-mono text-[10px] text-muted-foreground/50 truncate">{p.notes}</span>}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="font-mono text-[9px] text-muted-foreground/40">
                        {new Date(p.created_at).toLocaleDateString()}
                      </span>
                      <button
                        onClick={() => handleDeletePoint(p.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground/30 hover:text-red-400 transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Edit Dialog ─────────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={o => !o && setEditOpen(false)}>
        <DialogContent className="bg-card border-card-border max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase tracking-wider text-primary flex items-center gap-2">
              <Smartphone className="w-4 h-4" /> Edit Account
            </DialogTitle>
            <p className="text-[11px] font-mono text-muted-foreground">{account?.category} · {displayName}</p>
          </DialogHeader>

          {/* Section tabs */}
          <div className="flex gap-1 p-1 bg-muted/30 rounded-lg">
            {(["creds", "dates", "value"] as const).map(s => (
              <button
                key={s}
                onClick={() => setEditSection(s)}
                className={cn(
                  "flex-1 py-1 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all",
                  editSection === s ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
                )}
              >
                {s === "creds" ? "Credentials" : s === "dates" ? "Dates" : "Value"}
              </button>
            ))}
          </div>

          {/* Credentials section */}
          {editSection === "creds" && (
            <div className="space-y-2">
              {[
                { key: "username", label: "Username", placeholder: "@handle" },
                { key: "password", label: "Password", placeholder: "••••••••" },
                { key: "email", label: "Email", placeholder: "account@gmail.com" },
                { key: "recovery_email", label: "Recovery Email", placeholder: "recovery@gmail.com" },
                { key: "recovery_email_password", label: "Recovery Pass", placeholder: "••••••••" },
                { key: "twofa", label: "2FA Secret", placeholder: "TOTP secret" },
                { key: "recovery_email_twofa", label: "Recovery 2FA", placeholder: "recovery email TOTP" },
              ].map(f => (
                <div key={f.key} className="space-y-1">
                  <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">{f.label}</Label>
                  <Input
                    value={editForm[f.key] ?? ""}
                    onChange={ef(f.key)}
                    className="font-mono text-xs h-8 bg-input"
                    placeholder={f.placeholder}
                  />
                </div>
              ))}
              <div className="space-y-1">
                <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Backup Codes</Label>
                <Textarea
                  value={editForm.backup_codes ?? ""}
                  onChange={ef("backup_codes")}
                  className="font-mono text-xs bg-input min-h-[60px] resize-none"
                  placeholder="Paste backup codes..."
                />
              </div>
            </div>
          )}

          {/* Dates section */}
          {editSection === "dates" && (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Label / Nickname</Label>
                <Input value={editForm.label ?? ""} onChange={ef("label")} className="font-mono text-xs h-8 bg-input" placeholder="e.g. Main acc, farming1..." />
              </div>
              {[
                { key: "account_create_date", label: "Account Create Date" },
                { key: "account_buy_date", label: "Account Buy Date" },
                { key: "account_last_login_date", label: "Last Login Date" },
              ].map(f => (
                <div key={f.key} className="space-y-1">
                  <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">{f.label}</Label>
                  <Input type="date" value={editForm[f.key] ?? ""} onChange={ef(f.key)} className="font-mono text-xs h-8 bg-input" />
                </div>
              ))}
            </div>
          )}

          {/* Value section */}
          {editSection === "value" && (
            <div className="space-y-2">
              <div className="p-3 rounded-lg bg-emerald-400/5 border border-emerald-400/10 space-y-2">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="w-3 h-3 text-emerald-400" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-400 font-bold">Value & ROI</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Account Worth ($)</Label>
                    <Input type="number" value={editForm.account_worth ?? 0} onChange={ef("account_worth")} className="font-mono text-xs h-8 bg-input" placeholder="0.00" />
                  </div>
                  <div className="space-y-1">
                    <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Buy Price ($)</Label>
                    <Input type="number" value={editForm.buy_price ?? 0} onChange={ef("buy_price")} className="font-mono text-xs h-8 bg-input" placeholder="0.00" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Followers / Metric</Label>
                  <Input value={editForm.followers ?? ""} onChange={ef("followers")} className="font-mono text-xs h-8 bg-input" placeholder="e.g. 1200" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Notes</Label>
                <Textarea value={editForm.notes ?? ""} onChange={ef("notes")} className="font-mono text-xs bg-input min-h-[70px] resize-none" placeholder="Notes about this account..." />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button onClick={handleEditSave} disabled={saving} className="font-mono text-xs gap-2">
              {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</> : <><Shield className="w-3.5 h-3.5" /> Save Changes</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Delete Account?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">
            <strong>{displayName}</strong> and all its credentials will be permanently deleted.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting} className="font-mono text-xs">
              {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Settings Dialog — configure IMAP/SMTP for this account's
          email directly, saving through the same /api/email-accounts
          endpoint used everywhere else. */}
      <Dialog open={emailSettingsOpen} onOpenChange={setEmailSettingsOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary" /> Email Settings
            </DialogTitle>
          </DialogHeader>
          {!account.email ? (
            <p className="font-mono text-xs text-muted-foreground py-4 text-center">
              Add an email address in Credentials first, then come back here to configure IMAP/SMTP.
            </p>
          ) : emailAccountsLoading && emailAccounts.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : (
            <ImapSmtpForm
              emailAddress={account.email}
              existingAccount={emailAccounts.find(a => a.emailAddress === account.email) ?? null}
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
