import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChevronLeft, Shield, ShieldCheck, Loader2, KeyRound,
  Edit2, Trash2, Eye, EyeOff, Copy, Check, Ban, ShieldOff, AlertTriangle,
  User, Mail, Calendar, Building2, Phone, MapPin, Wifi, CreditCard,
  CheckCircle2, XCircle, TrendingUp, RefreshCw, Zap, DollarSign, HardDrive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import type { KycEntry } from "@/components/kyc-entries";
import { KycDialog } from "@/components/kyc-entries";
import { TOTPCard } from "@/components/vault/totp-card";

// Access dialog tabs — same 2FA/Mail/Backup split as vault-entity-access.tsx,
// scoped to this KYC entity's own fields only. Mail is deliberately just the
// entity's mail credentials (email/password/recovery) — not a live inbox or
// message list like the vault-entity Mail tab (VaultMailEntityBody); KYC
// entries don't carry a mailbox connection, only the mail fields themselves.
const ACCESS_TABS = [
  { id: "2fa",    label: "2FA",    icon: ShieldCheck },
  { id: "mail",   label: "Mail",   icon: Mail },
  { id: "backup", label: "Backup", icon: HardDrive },
] as const;
type AccessTab = typeof ACCESS_TABS[number]["id"];

const TABS = [
  { id: "overview",    label: "Overview" },
  { id: "credentials", label: "Credentials" },
  { id: "kyc",         label: "KYC Info" },
  { id: "purchase",    label: "Purchase" },
  { id: "profile",     label: "Profile" },
] as const;
type KycDetailTab = typeof TABS[number]["id"];

// ─── Health checks for KYC entities ─────────────────────────────────────────
const KYC_HEALTH_CHECKS = [
  { key: "username",         label: "Username",      icon: User,       color: "text-cyan-400",    getValue: (e: KycEntry) => !!e.username },
  { key: "email",            label: "Email",         icon: Mail,       color: "text-sky-400",     getValue: (e: KycEntry) => !!e.email },
  { key: "account_password", label: "Password",      icon: Shield,     color: "text-violet-400",  getValue: (e: KycEntry) => !!e.account_password },
  { key: "email_2fa",        label: "2FA",           icon: ShieldCheck,color: "text-emerald-400", getValue: (e: KycEntry) => !!e.email_2fa },
  { key: "email_backup_code",label: "Backup Code",   icon: KeyRound,   color: "text-amber-400",   getValue: (e: KycEntry) => !!e.email_backup_code },
  { key: "name",             label: "Full Name",     icon: User,       color: "text-primary",     getValue: (e: KycEntry) => !!e.name },
  { key: "nid_number",       label: "NID Number",    icon: CreditCard, color: "text-orange-400",  getValue: (e: KycEntry) => !!e.nid_number },
  { key: "birth_date",       label: "Birth Date",    icon: Calendar,   color: "text-rose-400",    getValue: (e: KycEntry) => !!e.birth_date },
  { key: "contact_number",   label: "Contact",       icon: Phone,      color: "text-teal-400",    getValue: (e: KycEntry) => !!e.contact_number },
  { key: "platform",         label: "Platform",      icon: Building2,  color: "text-blue-400",    getValue: (e: KycEntry) => !!e.platform },
  { key: "buy_price",        label: "Buy Price",     icon: CreditCard, color: "text-amber-400",   getValue: (e: KycEntry) => e.buy_price != null && Number(e.buy_price) > 0 },
  { key: "paid",             label: "Payment Done",  icon: CheckCircle2,color: "text-emerald-400",getValue: (e: KycEntry) => !!e.paid },
];

function kycHealthScore(e: KycEntry): number {
  const filled = KYC_HEALTH_CHECKS.filter(c => c.getValue(e)).length;
  return Math.round((filled / KYC_HEALTH_CHECKS.length) * 100);
}
function healthColor(score: number) {
  if (score >= 80) return "text-emerald-400";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}
function healthLabel(score: number): { label: string; color: string } {
  if (score >= 80) return { label: "Healthy", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" };
  if (score >= 50) return { label: "Partial",  color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
  return { label: "At Risk", color: "text-red-400 bg-red-400/10 border-red-400/20" };
}

// ─── Risk indicators ─────────────────────────────────────────────────────────
function getRisks(e: KycEntry): string[] {
  const risks: string[] = [];
  if (!e.email_2fa)         risks.push("No 2FA — account vulnerable");
  if (!e.email_backup_code) risks.push("No backup code — recovery blocked");
  if (!e.nid_number)        risks.push("NID missing — KYC incomplete");
  if (!e.account_password)  risks.push("Password not stored");
  if (e.status === "banned") risks.push("Entity is banned");
  if (!e.paid)              risks.push("Payment not confirmed");
  return risks;
}

function calcAge(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}yr`;
}

function SecretField({ label, value }: { label: string; value: string | null | undefined }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border/20 last:border-0 group">
      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-24 flex-shrink-0">{label}</span>
      <span className={cn("flex-1 font-mono text-xs truncate", shown ? "text-foreground/90" : "text-muted-foreground/40 select-none")}>
        {shown ? value : "•".repeat(Math.min(value.length, 16))}
      </span>
      <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
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

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/20 last:border-0">
      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">{label}</span>
      <span className="font-mono text-xs text-foreground/80 max-w-[200px] truncate text-right">{value}</span>
    </div>
  );
}

export default function VaultKycDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [entry, setEntry] = useState<KycEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<KycDetailTab>("overview");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessTab, setAccessTab] = useState<AccessTab>("2fa");
  const [editOpen, setEditOpen] = useState(false);
  const [banPending, setBanPending] = useState(false);

  // Exchange Profile tab state
  const [exApiKey, setExApiKey]       = useState("");
  const [exApiSecret, setExApiSecret] = useState("");
  const [savingKeys, setSavingKeys]   = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceData, setBalanceData] = useState<any>(null);
  const [showSecret, setShowSecret]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const single = await customFetch<KycEntry>(`/api/kyc-entries/${params.id}`);
      setEntry(single);
    } catch {
      try {
        const list = await customFetch<KycEntry[]>("/api/kyc-entries");
        const found = (Array.isArray(list) ? list : []).find(e => String(e.id) === params.id);
        setEntry(found ?? null);
      } catch {
        setEntry(null);
      }
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async () => {
    if (!entry) return;
    setDeleting(true);
    try {
      await customFetch<unknown>(`/api/kyc-entries/${entry.id}`, { method: "DELETE" });
      toast({ title: "KYC entity deleted" });
      navigate("/vault?tab=kyc");
    } catch {
      toast({ variant: "destructive", title: "Delete failed" });
    } finally { setDeleting(false); setConfirmDelete(false); }
  };

  const fetchBalance = useCallback(async (id: number) => {
    setBalanceLoading(true);
    setBalanceData(null);
    try {
      const data = await customFetch<any>(`/api/exchange-balance/${id}`);
      setBalanceData(data);
    } catch {
      setBalanceData({ error: "Failed to reach exchange" });
    } finally { setBalanceLoading(false); }
  }, []);

  const saveExchangeKeys = async () => {
    if (!entry) return;
    setSavingKeys(true);
    try {
      await customFetch<unknown>(`/api/kyc-entries/${entry.id}/exchange-keys`, {
        method: "PATCH",
        body: JSON.stringify({ apiKey: exApiKey || undefined, apiSecret: exApiSecret || undefined }),
      });
      toast({ title: "API keys saved (encrypted)" });
      fetchBalance(entry.id);
    } catch {
      toast({ variant: "destructive", title: "Failed to save keys" });
    } finally { setSavingKeys(false); }
  };

  const handleToggleBan = async () => {
    if (!entry) return;
    setBanPending(true);
    const nextStatus = entry.status === "banned" ? "active" : "banned";
    try {
      await customFetch<unknown>(`/api/kyc-entries/${entry.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      toast({ title: nextStatus === "banned" ? "KYC entity banned" : "KYC entity unbanned" });
      load();
    } catch {
      toast({ variant: "destructive", title: "Failed to update status" });
    } finally { setBanPending(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=kyc")} className="font-mono text-xs gap-1.5">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
        </Button>
        <div className="text-center py-20">
          <ShieldCheck className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground/60">KYC entity not found</p>
        </div>
      </div>
    );
  }

  const displayName = entry.name || entry.username || `KYC #${entry.id}`;
  const isBanned = entry.status === "banned";
  const score = kycHealthScore(entry);
  const { label: healthLbl, color: badgeColor } = healthLabel(score);
  const risks = getRisks(entry);
  const missing = KYC_HEALTH_CHECKS.filter(c => !c.getValue(entry));
  const present = KYC_HEALTH_CHECKS.filter(c => c.getValue(entry));

  return (
    <div className="space-y-5 page-enter max-w-2xl mx-auto">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=kyc")} className="font-mono text-xs gap-1.5 mb-3 -ml-2">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
        </Button>

        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold font-mono tracking-tighter truncate">{displayName}</h1>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Badge variant="outline" className="font-mono text-[9px] px-1.5">{entry.category}</Badge>
                {entry.platform && <span className="font-mono text-[10px] text-muted-foreground/50">{entry.platform}</span>}
                {isBanned && <Badge variant="outline" className="font-mono text-[9px] px-1.5 border-red-400/30 text-red-400 bg-red-400/5">Banned</Badge>}
                <Badge variant="outline" className={cn("font-mono text-[9px] px-1.5 border", badgeColor)}>{healthLbl} {score}%</Badge>
              </div>
            </div>
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setAccessOpen(true)} className="font-mono text-xs gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> Access
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} className="font-mono text-xs gap-1.5">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleBan}
              disabled={banPending}
              className={cn("font-mono text-xs gap-1.5", isBanned
                ? "text-emerald-400 border-emerald-400/30 hover:bg-emerald-400/10"
                : "text-red-400 border-red-400/30 hover:bg-red-400/10"
              )}
            >
              {banPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isBanned ? <ShieldOff className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
              {isBanned ? "Unban" : "Ban"}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} className="font-mono text-xs gap-1.5">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-muted/20 rounded-lg overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all flex-shrink-0 min-w-fit px-2",
              tab === t.id ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview Tab — Health + Risk */}
      {tab === "overview" && (
        <div className="space-y-4">
          {/* Health score card */}
          <div className="bg-card border border-card-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />
                <span className="font-mono text-sm font-bold text-primary">KYC Health</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("font-mono text-xl font-bold", healthColor(score))}>{score}%</span>
                <Badge variant="outline" className={cn("font-mono text-[9px] px-1.5 border", badgeColor)}>{healthLbl}</Badge>
              </div>
            </div>
            <Progress value={score} className="h-2 mb-4" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {KYC_HEALTH_CHECKS.map(check => {
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

          {/* Risk checker */}
          {risks.length > 0 && (
            <div className="bg-card border border-card-border rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span className="font-mono text-sm font-bold text-red-400">Risk Checker</span>
                <Badge variant="outline" className="font-mono text-[9px] px-1.5 border-red-400/30 text-red-400 bg-red-400/5 ml-auto">{risks.length} risk{risks.length !== 1 ? "s" : ""}</Badge>
              </div>
              <div className="space-y-2">
                {risks.map((r, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg bg-red-400/5 border border-red-400/15 px-3 py-2">
                    <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                    <span className="font-mono text-[11px] text-red-300/80">{r}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {risks.length === 0 && (
            <div className="flex items-center gap-2.5 rounded-xl bg-emerald-400/5 border border-emerald-400/20 px-4 py-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span className="font-mono text-xs text-emerald-400">No risks detected — KYC entity looks complete</span>
            </div>
          )}

          {/* Quick summary */}
          <div className="bg-card border border-card-border rounded-xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-3">Summary</p>
            <div className="flex flex-wrap gap-2">
              {entry.username && <span className="font-mono text-[9px] px-2 py-1 rounded-full bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">ACCOUNT</span>}
              {entry.email && <span className="font-mono text-[9px] px-2 py-1 rounded-full bg-sky-400/10 text-sky-400 border border-sky-400/20">EMAIL</span>}
              {entry.email_2fa && <span className="font-mono text-[9px] px-2 py-1 rounded-full bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">2FA</span>}
              {entry.nid_number && <span className="font-mono text-[9px] px-2 py-1 rounded-full bg-violet-400/10 text-violet-400 border border-violet-400/20">NID STORED</span>}
              {entry.photo1_url && <span className="font-mono text-[9px] px-2 py-1 rounded-full bg-orange-400/10 text-orange-400 border border-orange-400/20">PHOTOS</span>}
              <span className={cn(
                "font-mono text-[9px] px-2 py-1 rounded-full border flex items-center gap-1",
                entry.paid ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" : "bg-red-400/10 text-red-400 border-red-400/20"
              )}>
                {entry.paid ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
                {entry.paid ? "PAID" : "UNPAID"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Credentials Tab */}
      {tab === "credentials" && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-cyan-400">
            Credentials
          </div>
          <div className="px-4 py-2">
            <SecretField label="Username" value={entry.username} />
            <SecretField label="Email" value={entry.email} />
            <SecretField label="Password" value={entry.account_password} />
            <SecretField label="Email Pass" value={entry.email_password} />
            <SecretField label="2FA Secret" value={entry.email_2fa} />
            <SecretField label="Backup Code" value={entry.email_backup_code} />
            <SecretField label="Acct. 2FA" value={entry.account_2fa} />
            <SecretField label="Acct. Backup" value={entry.account_backup_code} />
            <SecretField label="Rec. Email" value={entry.email_recovery} />
            <SecretField label="Rec. Pass" value={entry.email_recovery_password} />
            <SecretField label="Rec. 2FA" value={entry.recovery_2fa} />
            <SecretField label="Rec. Backup" value={entry.recovery_backup_code} />
            {!entry.username && !entry.email && !entry.account_password && (
              <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No credentials stored</p>
            )}
          </div>
          {entry.notes && (
            <div className="px-4 pb-4 border-t border-border/20 mt-2">
              <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50 mb-2 mt-3">Notes</p>
              <p className="font-mono text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                {entry.notes}
              </p>
            </div>
          )}
        </div>
      )}

      {/* KYC Info Tab */}
      {tab === "kyc" && (
        <div className="space-y-4">
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-primary">
              Identity
            </div>
            <div className="px-4 py-2">
              <InfoRow label="Full Name" value={entry.name} />
              <InfoRow label="Father Name" value={entry.father_name} />
              <InfoRow label="NID Number" value={entry.nid_number} />
              <InfoRow label="Birth Date" value={entry.birth_date ? new Date(entry.birth_date).toLocaleDateString() : null} />
              <InfoRow label="Location" value={entry.location} />
              <InfoRow label="Contact" value={entry.contact_number} />
              <InfoRow label="Social" value={entry.social_account} />
              {!entry.name && !entry.nid_number && (
                <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No KYC info recorded</p>
              )}
            </div>
          </div>

          {/* Photos */}
          {(entry.photo1_url || entry.photo2_url) && (
            <div className="bg-card border border-card-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground/60">
                Photos
              </div>
              <div className="p-4 flex gap-3">
                {entry.photo1_url && (
                  <a href={entry.photo1_url} target="_blank" rel="noopener noreferrer" className="relative group">
                    <img src={entry.photo1_url} alt="ID Photo 1" className="w-24 h-24 object-cover rounded-lg border border-border/40 group-hover:border-primary/40 transition-colors" />
                    <p className="font-mono text-[9px] text-muted-foreground/50 mt-1 text-center">Photo 1</p>
                  </a>
                )}
                {entry.photo2_url && (
                  <a href={entry.photo2_url} target="_blank" rel="noopener noreferrer" className="relative group">
                    <img src={entry.photo2_url} alt="ID Photo 2" className="w-24 h-24 object-cover rounded-lg border border-border/40 group-hover:border-primary/40 transition-colors" />
                    <p className="font-mono text-[9px] text-muted-foreground/50 mt-1 text-center">Photo 2</p>
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Profile Tab — Exchange profile name + API sync + real-time balance */}
      {tab === "profile" && (
        <div className="space-y-4">
          {/* Profile identity card */}
          <div className="bg-card border border-card-border rounded-xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                <User className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-mono text-sm font-bold text-foreground">{entry.name || entry.username || `KYC #${entry.id}`}</p>
                {entry.platform && <p className="font-mono text-[10px] text-muted-foreground/50">{entry.platform}</p>}
              </div>
              {entry.username && (
                <div className="ml-auto font-mono text-[10px] text-muted-foreground/60 bg-muted/30 px-2 py-1 rounded border border-border/30">
                  @{entry.username}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {entry.name && (
                <div className="bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Full Name</div>
                  <div className="font-mono text-xs text-foreground/80 truncate">{entry.name}</div>
                </div>
              )}
              {entry.platform && (
                <div className="bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Exchange</div>
                  <div className="font-mono text-xs text-foreground/80 truncate">{entry.platform}</div>
                </div>
              )}
              {entry.email && (
                <div className="bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Email</div>
                  <div className="font-mono text-xs text-foreground/80 truncate">{entry.email}</div>
                </div>
              )}
              {entry.category && (
                <div className="bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                  <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Category</div>
                  <div className="font-mono text-xs text-foreground/80">{entry.category}</div>
                </div>
              )}
            </div>
          </div>

          {/* API Key Config */}
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-amber-400 flex items-center gap-2">
              <Zap className="w-3.5 h-3.5" /> Exchange API Keys
            </div>
            <div className="px-4 py-4 space-y-3">
              <p className="font-mono text-[10px] text-muted-foreground/50 leading-relaxed">
                Keys are encrypted at rest (AES-256). Only the server decrypts them when fetching live balances — they never leave unencrypted.
              </p>
              <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">API Key</Label>
                <Input
                  value={exApiKey}
                  onChange={e => setExApiKey(e.target.value)}
                  placeholder="Enter API key..."
                  className="font-mono text-xs h-8 bg-input"
                />
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">API Secret</Label>
                <div className="relative">
                  <Input
                    type={showSecret ? "text" : "password"}
                    value={exApiSecret}
                    onChange={e => setExApiSecret(e.target.value)}
                    placeholder="Enter API secret..."
                    className="font-mono text-xs h-8 bg-input pr-8"
                  />
                  <button
                    onClick={() => setShowSecret(s => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-primary transition-colors"
                  >
                    {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveExchangeKeys} disabled={savingKeys} className="font-mono text-xs gap-1.5">
                  {savingKeys ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Save Keys
                </Button>
                <Button
                  size="sm" variant="outline" onClick={() => entry && fetchBalance(entry.id)}
                  disabled={balanceLoading} className="font-mono text-xs gap-1.5"
                >
                  {balanceLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Fetch Balance
                </Button>
              </div>
            </div>
          </div>

          {/* Live Balance */}
          {(balanceData || balanceLoading) && (
            <div className="bg-card border border-card-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-emerald-400 flex items-center gap-2">
                <DollarSign className="w-3.5 h-3.5" /> Live Portfolio
                {balanceData?.exchange && <span className="font-normal text-muted-foreground/50 normal-case">· {balanceData.exchange}</span>}
              </div>
              <div className="px-4 py-3">
                {balanceLoading && <div className="flex items-center gap-2 py-4"><Loader2 className="w-4 h-4 animate-spin text-primary" /><span className="font-mono text-xs text-muted-foreground/50">Fetching live data...</span></div>}
                {!balanceLoading && balanceData?.error && (
                  <div className="flex items-start gap-2 p-3 bg-red-400/5 rounded-lg border border-red-400/20">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="font-mono text-[10px] text-red-400">{balanceData.error}</p>
                  </div>
                )}
                {!balanceLoading && !balanceData?.hasKeys && !balanceData?.error && (
                  <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No API keys configured — add keys above to see live balance.</p>
                )}
                {!balanceLoading && balanceData?.hasKeys && !balanceData?.error && (
                  balanceData.balances?.length > 0 ? (
                    <div className="space-y-1.5">
                      {balanceData.balances.slice(0, 15).map((b: any, i: number) => (
                        <div key={i} className="flex items-center justify-between py-1.5 border-b border-border/15 last:border-0">
                          <span className="font-mono text-xs font-bold text-foreground/80">{b.asset}</span>
                          <div className="text-right">
                            <div className="font-mono text-xs text-emerald-400">{parseFloat(b.free).toFixed(6)} free</div>
                            {parseFloat(b.locked) > 0 && <div className="font-mono text-[9px] text-amber-400">{parseFloat(b.locked).toFixed(6)} locked</div>}
                          </div>
                        </div>
                      ))}
                      {balanceData.balances.length > 15 && (
                        <p className="font-mono text-[9px] text-muted-foreground/40 text-center pt-1">+{balanceData.balances.length - 15} more assets</p>
                      )}
                    </div>
                  ) : (
                    <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No non-zero balances found.</p>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Purchase Tab */}
      {tab === "purchase" && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border/30 font-mono text-xs font-bold uppercase tracking-widest text-amber-400">
            Purchase Info
          </div>
          <div className="px-4 py-2">
            <InfoRow label="Platform" value={entry.platform} />
            <InfoRow label="Buy Price" value={entry.buy_price != null ? `$${Number(entry.buy_price).toFixed(2)}` : null} />
            <InfoRow label="Buy Date" value={entry.buy_date ? new Date(entry.buy_date).toLocaleDateString() : null} />
            <InfoRow label="Seller" value={entry.seller_name} />
            <InfoRow label="Connection" value={entry.connection} />
            <div className="flex items-center justify-between py-2 border-b border-border/20">
              <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">Payment</span>
              <div className={cn("flex items-center gap-1 font-mono text-xs font-bold", entry.paid ? "text-emerald-400" : "text-red-400")}>
                {entry.paid ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {entry.paid ? "Paid" : "Unpaid"}
              </div>
            </div>
            <InfoRow label="Created" value={new Date(entry.created_at).toLocaleDateString()} />
            {!entry.buy_price && !entry.seller_name && !entry.buy_date && (
              <p className="font-mono text-xs text-muted-foreground/40 py-4 text-center">No purchase info recorded</p>
            )}
          </div>
        </div>
      )}

      {/* Edit Dialog */}
      <KycDialog
        open={editOpen}
        editEntry={entry}
        onClose={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); load(); }}
      />

      {/* Access Dialog — 2FA / Mail / Backup, scoped to this entity only */}
      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" /> Access — {entry.name || entry.username || `#${entry.id}`}
            </DialogTitle>
          </DialogHeader>

          <div className="flex gap-1 p-1 bg-muted/20 rounded-lg">
            {ACCESS_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setAccessTab(t.id)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all",
                  accessTab === t.id ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
                )}
              >
                <t.icon className="w-3 h-3" />
                {t.label}
              </button>
            ))}
          </div>

          {/* 2FA — only this entity's own 2FA secrets, live TOTP codes */}
          {accessTab === "2fa" && (() => {
            const totpItems = [
              { id: "email",    label: "Email 2FA",    secret: entry.email_2fa },
              { id: "account",  label: "Account 2FA",  secret: entry.account_2fa },
              { id: "recovery", label: "Recovery 2FA", secret: entry.recovery_2fa },
            ].filter(i => i.secret) as { id: string; label: string; secret: string }[];
            return totpItems.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground/40 text-center py-8">No 2FA codes for this entity</p>
            ) : (
              <div className="space-y-2">
                {totpItems.map(i => <TOTPCard key={i.id} label={i.label} issuer={entry.name ?? undefined} secret={i.secret} />)}
              </div>
            );
          })()}

          {/* Mail — just this entity's mail fields, not a live inbox/list */}
          {accessTab === "mail" && (
            <div className="space-y-1">
              <SecretField label="Email" value={entry.email} />
              <SecretField label="Email Password" value={entry.email_password} />
              <SecretField label="Recovery Email" value={entry.email_recovery} />
              <SecretField label="Recovery Email Password" value={entry.email_recovery_password} />
              {!entry.email && !entry.email_password && !entry.email_recovery && !entry.email_recovery_password && (
                <p className="font-mono text-xs text-muted-foreground/40 text-center py-8">No mail credentials for this entity</p>
              )}
            </div>
          )}

          {/* Backup — this entity's platform backup codes */}
          {accessTab === "backup" && (
            <div className="space-y-1">
              <SecretField label="Email Backup Code" value={entry.email_backup_code} />
              <SecretField label="Account Backup Code" value={entry.account_backup_code} />
              <SecretField label="Recovery Backup Code" value={entry.recovery_backup_code} />
              {!entry.email_backup_code && !entry.account_backup_code && !entry.recovery_backup_code && (
                <p className="font-mono text-xs text-muted-foreground/40 text-center py-8">No backup codes for this entity</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Delete KYC Entity?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">All data for this KYC entity will be permanently deleted. This cannot be undone.</p>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting} className="font-mono text-xs gap-1.5">
              {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
