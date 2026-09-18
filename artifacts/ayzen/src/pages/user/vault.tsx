import { useState, useRef, useEffect, lazy, Suspense } from "react";
import { useLocation, useSearch } from "wouter";
import { useListVaultEntries, useCreateVaultEntry, useDeleteVaultEntry, customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus, KeyRound, Trash2, Eye, EyeOff,
  Copy, Check, Mail, Hash, Lock, Shield,
  Phone, AtSign, X, Smartphone,
  QrCode, Search, Download, Upload, Wallet, AlertTriangle, Star,
  Loader2, Edit2, MoreVertical, LayoutDashboard, List, Users, HardDrive,
  ShieldCheck, Tag, CheckSquare, Share2,
  TrendingUp, TrendingDown, Minus, FolderGit2, ShieldAlert, Ban, XCircle, CheckCircle2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { RankBadge, getEntityRank } from "@/lib/entity-rank";
import { computeEntityPerformanceScore, type EntityLeaderboardRow } from "@/lib/performance-score";
import LocalAccounts from "@/components/local-accounts";
import { LocalEntityPicker } from "@/components/vault/local-entity-picker";
import { VaultSidebar } from "@/components/layout/vault-sidebar";
import { DataEntityPicker } from "@/components/vault/data-entity-picker";
import KycEntries from "@/components/kyc-entries";
import GameEntries from "@/components/game-entries";
import { QRCodeSVG } from "qrcode.react";
import { computeEntityWorth, computeEntityBuyValue, computeEntityProfit, computeEntityProfitPct, metricLabelFor } from "@/lib/entity-worth";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { ENTITY_FIELDS, ACCOUNT_SUBTABS } from "@/config/fields/entity-create";
import { ValueEntryDialog, ValueEntryButton, FollowerEntryDialog, FollowerEntryButton } from "@/components/value-entry-dialog";
import { ValuePnlPanel } from "@/components/value-pnl-panel";
import { ImapSmtpForm, type EmailAccount } from "@/components/mail/imap-smtp-form";
import { ShareEntityDialog, type ShareTarget } from "@/components/vault/share-entity-dialog";
import { validateWalletKey, type WalletKeyValidationResult } from "@/lib/vault-key-validation-api";
import { ManageSharesDialog } from "@/components/vault/manage-shares-dialog";
import { VaultLoadingIntro } from "@/components/vault/vault-loading-intro";

const MAIL_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const VaultLocalDashboard = lazy(() => import("@/pages/user/vault-local-dashboard"));
const VaultKycDashboard = lazy(() => import("@/pages/user/vault-kyc-dashboard"));
const VaultEntityDashboard = lazy(() => import("@/pages/user/vault-entity-dashboard"));
const VaultMail = lazy(() => import("@/pages/user/vault-mail"));
const VaultWalletSeed = lazy(() => import("@/pages/user/vault-wallet-seed"));



function LoadingTab() {
  return <VaultLoadingIntro title="Loading dashboard" />;
}

// ─── Phase 18 — buy-value vs worth badge ────────────────────────────────────
// Reuses the existing computeEntityBuyValue/computeEntityProfit(Pct) helpers
// (already powering the vault PnL dashboard) rather than a second comparison
// rule. Renders nothing when no buy value has been recorded at all, since
// there's nothing to compare worth against yet.
function WorthDeltaBadge({ entry, size = "sm" }: { entry: EntryAny; size?: "sm" | "xs" }) {
  const buyValue = computeEntityBuyValue(entry);
  if (buyValue <= 0) return null;
  const profit = computeEntityProfit(entry);
  const profitPct = computeEntityProfitPct(entry);
  const Icon = profit > 0 ? TrendingUp : profit < 0 ? TrendingDown : Minus;
  const tone = profit > 0 ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
    : profit < 0 ? "text-red-400 bg-red-400/10 border-red-400/20"
    : "text-muted-foreground bg-muted/10 border-border/30";
  const text = profitPct !== null ? `${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(0)}%` : `${profit >= 0 ? "+" : ""}$${profit.toFixed(0)}`;
  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 font-mono rounded border",
      size === "xs" ? "text-[8px] px-1 py-0.5" : "text-[9px] px-1.5 py-0.5",
      tone
    )} title={`Worth $${computeEntityWorth(entry).toFixed(0)} vs buy value $${buyValue.toFixed(0)}`}>
      <Icon className={size === "xs" ? "w-2 h-2" : "w-2.5 h-2.5"} /> {text}
    </span>
  );
}

// ─── Phase 18 — status flags ────────────────────────────────────────────────
// Two independent sources, both surfaced only in the quick-view (never the
// card, to keep it uncluttered): the entity's own health/quality status
// (vault_entries.status — active/warning/banned/suspended) and, from the
// leaderboard row, whether any of the entity's project enrollments carry a
// Phase 5 disqualified/banned/cancelled status. An entity can be flagged by
// either, both, or neither independently.
const ENTITY_STATUS_META: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  warning: { label: "Warning", icon: AlertTriangle, className: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
  banned: { label: "Banned", icon: Ban, className: "text-red-400 bg-red-400/10 border-red-400/20" },
  suspended: { label: "Suspended", icon: ShieldAlert, className: "text-red-400 bg-red-400/10 border-red-400/20" },
};

function EntityStatusFlags({ entry, leaderboardRow }: { entry: EntryAny; leaderboardRow: EntityLeaderboardRow | undefined }) {
  const entityStatus = (entry.status && entry.status !== "active") ? ENTITY_STATUS_META[entry.status] : null;
  const enrollmentFlags: { label: string; icon: React.ElementType; className: string }[] = [];
  if (leaderboardRow?.disqualifiedProjects) {
    enrollmentFlags.push({ label: `Disqualified (${leaderboardRow.disqualifiedProjects})`, icon: ShieldAlert, className: "text-amber-400 bg-amber-400/10 border-amber-400/20" });
  }
  if (leaderboardRow?.bannedProjects) {
    enrollmentFlags.push({ label: `Banned (${leaderboardRow.bannedProjects})`, icon: Ban, className: "text-red-400 bg-red-400/10 border-red-400/20" });
  }
  if (leaderboardRow?.cancelledProjects) {
    enrollmentFlags.push({ label: `Cancelled (${leaderboardRow.cancelledProjects})`, icon: XCircle, className: "text-muted-foreground bg-muted/10 border-border/30" });
  }
  if (!entityStatus && enrollmentFlags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entityStatus && (
        <span className={cn("inline-flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 rounded border", entityStatus.className)}>
          <entityStatus.icon className="w-2.5 h-2.5" /> {entityStatus.label}
        </span>
      )}
      {enrollmentFlags.map(f => (
        <span key={f.label} className={cn("inline-flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 rounded border", f.className)}>
          <f.icon className="w-2.5 h-2.5" /> {f.label}
        </span>
      ))}
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

function CredField({ label, value }: { label: string; value: string | null | undefined }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center gap-2 group/row py-0.5">
      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider w-14 flex-shrink-0">{label}</span>
      <span className={cn("flex-1 font-mono text-[11px] truncate", shown ? "text-foreground/90" : "text-muted-foreground/60")}>
        {shown ? value : "•".repeat(Math.min(value.length, 12))}
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={() => setShown(s => !s)} className="text-muted-foreground/40 hover:text-primary transition-colors">
          {shown ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
        <button onClick={copy} className={cn("transition-colors", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary")}>
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
    </div>
  );
}

function PlatformSection({ title, color, icon: Icon, fields }: {
  title: string; color: string; icon: React.ElementType;
  fields: { label: string; value: string | null | undefined }[];
}) {
  const hasAny = fields.some(f => f.value);
  if (!hasAny) return null;
  return (
    <div className="space-y-0.5 py-2 border-t border-border/30 first:border-0 first:pt-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className={cn("w-3 h-3", color)} />
        <span className={cn("text-[9px] font-mono uppercase tracking-widest font-bold", color)}>{title}</span>
      </div>
      {fields.map(f => <CredField key={f.label} label={f.label} value={f.value} />)}
    </div>
  );
}

interface OtherAccount { id: string; platform: string; label: string; tags: string; username: string; password: string; email: string; emailPassword: string; twofa: string; notes: string; age: string; worth: string; buyValue: string; metric: string; lastLoginAt: string; buyDate: string; createDate: string; }

// Same 3-tab split as the Account tab's ACCOUNT_SUBTABS minus Wallet —
// platforms don't carry a wallet sub-tab. Reused for twitter/discord/telegram
// (via formSubTab, generalized to apply to whichever formTab is active) and
// for each entry in the Other tab's dynamic account list (per-entry, its own
// local sub-tab state inside OtherAccountForm below).
const PLATFORM_SUBTABS = [
  { id: "main", label: "Main" },
  { id: "info", label: "Info" },
  { id: "recovery", label: "Recovery" },
];

function OtherAccountForm({ account, onChange, onRemove }: { account: OtherAccount; onChange: (u: OtherAccount) => void; onRemove: () => void }) {
  const [subTab, setSubTab] = useState("main");
  const f = (key: keyof OtherAccount) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...account, [key]: e.target.value });
  return (
    <div className="p-3 rounded-lg border border-border/40 bg-muted/10 space-y-2 relative group">
      <button onClick={onRemove} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all">
        <X className="w-3.5 h-3.5" />
      </button>

      {/* Platform Name stays visible above the sub-tabs — it drives the Info
          tab's metric label and every other tab's context, not worth hiding
          behind a click. */}
      <div className="space-y-1">
        <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Platform Name</Label>
        <Input value={account.platform} onChange={f("platform")} className="font-mono text-xs h-8 bg-input" placeholder="e.g. GitHub, LinkedIn, Reddit, TikTok..." />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="font-mono text-[10px] text-muted-foreground/60">Platform Label</Label>
          <Input value={account.label} onChange={f("label")} className="font-mono text-xs h-8 bg-input" placeholder="e.g. Main, Farming 1..." />
        </div>
        <div className="space-y-1">
          <Label className="font-mono text-[10px] text-muted-foreground/60 flex items-center gap-1"><Tag className="w-2.5 h-2.5" /> Tags</Label>
          <Input value={account.tags} onChange={f("tags")} className="font-mono text-xs h-8 bg-input" placeholder="comma, separated, tags" />
        </div>
      </div>

      <div className="flex gap-1 pt-1">
        {PLATFORM_SUBTABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={cn(
              "px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider flex-shrink-0 transition-all border",
              subTab === t.id ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "main" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="font-mono text-[10px] text-muted-foreground/60">Username</Label>
              <Input value={account.username} onChange={f("username")} className="font-mono text-xs h-8 bg-input" placeholder="username / handle" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] text-muted-foreground/60 flex items-center gap-1"><Lock className="w-2.5 h-2.5" /> Password</Label>
              <Input type="password" value={account.password} onChange={f("password")} className="font-mono text-xs h-8 bg-input" placeholder="••••••••" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">Notes</Label>
            <Textarea value={account.notes} onChange={f("notes")} rows={3} className="font-mono text-xs bg-input" placeholder="Airdrop notes, important info..." />
          </div>
        </div>
      )}

      {subTab === "info" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">Last Login</Label>
            <Input type="date" value={account.lastLoginAt} onChange={f("lastLoginAt")} className="font-mono text-xs h-8 bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">Buy Date</Label>
            <Input type="date" value={account.buyDate} onChange={f("buyDate")} className="font-mono text-xs h-8 bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">Create Date</Label>
            <Input type="date" value={account.createDate} onChange={f("createDate")} className="font-mono text-xs h-8 bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">{metricLabelFor(account.platform || "")}</Label>
            <Input value={account.metric} onChange={f("metric")} className="font-mono text-xs h-8 bg-input" placeholder="e.g. 1200" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">Account Age</Label>
            <Input value={account.age} onChange={f("age")} className="font-mono text-xs h-8 bg-input" placeholder="e.g. 2 years" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-cyan-400/80">Buy Value ($)</Label>
            <Input value={account.buyValue} onChange={f("buyValue")} type="number" className="font-mono text-xs h-8 bg-input border-cyan-400/20" placeholder="e.g. 15" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-amber-400/80">Worth ($)</Label>
            <Input value={account.worth} onChange={f("worth")} type="number" className="font-mono text-xs h-8 bg-input border-amber-400/20" placeholder="e.g. 50" />
          </div>
        </div>
      )}

      {subTab === "recovery" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60">Linked Email</Label>
            <Input value={account.email} onChange={f("email")} className="font-mono text-xs h-8 bg-input" placeholder="linked@email.com" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] text-muted-foreground/60 flex items-center gap-1"><Lock className="w-2.5 h-2.5" /> Email Password</Label>
            <Input type="password" value={account.emailPassword} onChange={f("emailPassword")} className="font-mono text-xs h-8 bg-input" placeholder="••••••••" />
          </div>
          <div className="space-y-1 col-span-2">
            <Label className="font-mono text-[10px] text-muted-foreground/60">2FA Secret</Label>
            <Input value={account.twofa} onChange={f("twofa")} className="font-mono text-xs h-8 bg-input" placeholder="TOTP secret..." />
          </div>
        </div>
      )}
    </div>
  );
}

type EntryAny = any;

// One row inside the entity dialog's Email tab: shows the email already
// typed on that platform's own tab (read-only — this tab never re-collects
// it) plus the shared ImapSmtpForm to set up IMAP/SMTP for it. Saving here
// goes through the same /api/email-accounts path as Mail Hub, so it's
// immediately visible there too.
function EmailPlatformPanel({
  email, label, account, token, onSaved, onJump, jumpLabel,
}: {
  email: string;
  label: string;
  account: EmailAccount | null;
  token: string | null;
  onSaved: () => void;
  onJump?: () => void;
  jumpLabel?: string;
}) {
  if (!email) {
    return (
      <div className="text-center py-8 space-y-2 border border-dashed border-border/40 rounded-lg">
        <Mail className="w-6 h-6 text-muted-foreground/20 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No {label} email set yet</p>
        {onJump && (
          <Button variant="outline" size="sm" onClick={onJump} className="font-mono text-[10px] gap-1.5">
            Go to {jumpLabel ?? label} tab
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Mail className="w-3.5 h-3.5 text-primary flex-shrink-0" />
        <span className="font-mono text-xs font-bold truncate">{email}</span>
        <span className="font-mono text-[9px] text-muted-foreground/40 flex-shrink-0">synced from {label}</span>
      </div>
      <div className="rounded-lg border border-border/30 bg-muted/5">
        <ImapSmtpForm emailAddress={email} existingAccount={account} token={token} onSaved={onSaved} compact />
      </div>
    </div>
  );
}

const EMPTY_FORM = {
  projectName: "",
  username: "", accountPassword: "",
  email: "", emailPassword: "", account2fa: "", accountBackupCode: "", email2fa: "", emailBackupCode: "",
  emailRecovery: "", emailRecoveryPassword: "", recovery2fa: "", recoveryBackupCode: "",
  lastLoginAt: "", buyDate: "", createDate: "",
  currentValue: "", currentBuyValue: "", followers: "",
  seedPhrase: "",
  twitterUsername: "", twitterPassword: "", twitterEmail: "", twitterEmailPassword: "",
  twitterFollowers: "", twitter2fa: "", twitterAccountBackupCode: "", twitterEmail2fa: "", twitterEmailBackupCode: "",
  twitterEmailRecovery: "", twitterEmailRecoveryPassword: "", twitterRecovery2fa: "", twitterRecoveryBackupCode: "",
  twitterAge: "", twitterWorth: "", twitterBuyValue: "",
  twitterNotes: "", twitterLastLoginAt: "", twitterBuyDate: "", twitterCreateDate: "",
  discordUsername: "", discordPassword: "", discordEmail: "", discordEmailPassword: "",
  discord2fa: "", discordAccountBackupCode: "", discordEmail2fa: "", discordEmailBackupCode: "",
  discordEmailRecovery: "", discordEmailRecoveryPassword: "", discordRecovery2fa: "", discordRecoveryBackupCode: "",
  discordFollowers: "", discordAge: "", discordWorth: "", discordBuyValue: "",
  discordNotes: "", discordLastLoginAt: "", discordBuyDate: "", discordCreateDate: "",
  telegramUsername: "", telegramPassword: "", telegramPhone: "", telegram2fa: "",
  telegramAccountBackupCode: "", telegramEmail2fa: "", telegramEmailBackupCode: "",
  telegramLinkedEmail: "", telegramLinkedEmailPassword: "", telegramRecovery2fa: "", telegramRecoveryBackupCode: "",
  telegramAge: "", telegramWorth: "", telegramBuyValue: "", telegramFollowers: "",
  telegramNotes: "", telegramLastLoginAt: "", telegramBuyDate: "", telegramCreateDate: "",
  walletAddresses: "", backupCodes: "", notes: "", score: "5", tags: "",
  // Data Entity bridge — same kyc_data_entities link a KYC entity can use.
  dataEntityId: null as number | null,
};

function newOther(): OtherAccount {
  return { id: Math.random().toString(36).slice(2), platform: "", label: "", tags: "", username: "", password: "", email: "", emailPassword: "", twofa: "", notes: "", age: "", worth: "", buyValue: "", metric: "", lastLoginAt: "", buyDate: "", createDate: "" };
}

// ── Entity Manager (full CRUD) ─────────────────────────────────────────────────
function EntityManager() {
  const { data, isLoading } = useListVaultEntries();
  const createMutation = useCreateVaultEntry();
  const deleteMutation = useDeleteVaultEntry();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { token } = useAuth();
  const [, navigate] = useLocation();
  // Lets the checkpoint intro below finish its own progress-to-100%
  // animation instead of being yanked off screen the instant isLoading
  // flips false.
  const [entriesIntroFinished, setEntriesIntroFinished] = useState(false);

  const [open, setOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [qrAddress, setQrAddress] = useState<string | null>(null);
  const [quickView, setQuickView] = useState<EntryAny | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [otherAccounts, setOtherAccounts] = useState<OtherAccount[]>([]);
  const [formTab, setFormTab] = useState("wallet");
  const [formSubTab, setFormSubTab] = useState("main");
  // Local entity picker state — tracks which local account (if any) the user
  // imported credentials from for the active platform tab. Cleared on close.
  const [localPlatformLink, setLocalPlatformLink] = useState<{ id: number; label: string } | null>(null);
  const [localAccsForPicker, setLocalAccsForPicker] = useState<any[]>([]);
  const [localAccPickerLoading, setLocalAccPickerLoading] = useState(false);
  const [formEmailSubTab, setFormEmailSubTab] = useState("account");
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailAccountsLoading, setEmailAccountsLoading] = useState(false);
  const [walletSubTab, setWalletSubTab] = useState<"manual" | "drive">("manual");
  const [driveForm, setDriveForm] = useState({ label: "", address: "", note: "" });
  // Seed phrase / private key pre-save check — see "Add Private Key" field
  // below. Cleared whenever seedPhrase text changes so a stale ✓ can never
  // be shown next to a value that hasn't actually been re-tested.
  const [keyCheck, setKeyCheck] = useState<WalletKeyValidationResult | null>(null);
  const [keyCheckLoading, setKeyCheckLoading] = useState(false);
  const [keyCheckedValue, setKeyCheckedValue] = useState<string | null>(null);
  const [savingDrive, setSavingDrive] = useState(false);
  const [valueDialogOpen, setValueDialogOpen] = useState(false);
  const [followerDialogOpen, setFollowerDialogOpen] = useState(false);
  const [driveLocked, setDriveLocked] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "name">("date");

  const [filterTag, setFilterTag] = useState("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagAction, setBulkTagAction] = useState<"add" | "remove">("add");
  const [bulkTagValue, setBulkTagValue] = useState("");
  const [bulkTagSaving, setBulkTagSaving] = useState(false);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState<string>("active");
  const [bulkStatusSaving, setBulkStatusSaving] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteSaving, setBulkDeleteSaving] = useState(false);
  const [pinned, setPinned] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [shareItems, setShareItems] = useState<ShareTarget[] | null>(null);
  const [shareLabel, setShareLabel] = useState<string | undefined>(undefined);
  const [managingShares, setManagingShares] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  // 3-dot card menu — tracks which card's dropdown is currently open
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  // 3-dot bulk-action menu — same square-grid dropdown as the per-card menu
  // above, but for the selection toolbar. Only one of these two is ever open
  // at a time in practice (select mode hides the per-card 3-dot), but they're
  // independent state so neither accidentally closes the other.
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  // Form dialog key — incremented each time dialog opens so React freshly mounts it
  const [dialogKey, setDialogKey] = useState(0);

  const shareOne = (entry: EntryAny) => { setShareItems([{ entityType: "entity", entityId: entry.id }]); setShareLabel(entry.projectName || `Entity #${entry.id}`); };
  const shareSelected = () => { setShareItems(selectedIds.map(id => ({ entityType: "entity" as const, entityId: id }))); setShareLabel(undefined); };

  // Lazy-load on first visit to the Email tab (per dialog session), not on
  // every keystroke — refreshed manually after each per-platform save via
  // ImapSmtpForm's onSaved callback below.
  useEffect(() => {
    if (open && formTab === "email" && emailAccounts.length === 0 && !emailAccountsLoading) {
      fetchEmailAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, formTab]);

  // Fetch local accounts for the current platform tab so the picker can
  // suggest credentials to import. Clear state when dialog closes.
  useEffect(() => {
    if (!open) { setLocalPlatformLink(null); setLocalAccsForPicker([]); return; }
    if (!["twitter", "discord", "telegram"].includes(formTab)) return;
    setLocalAccPickerLoading(true);
    customFetch<any[]>(`/api/local-accounts?category=${formTab}`)
      .then(d => setLocalAccsForPicker(Array.isArray(d) ? d : []))
      .catch(() => setLocalAccsForPicker([]))
      .finally(() => setLocalAccPickerLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, formTab]);

  const allEntries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];

  // Auto-open edit dialog when ?editId=<n> is in the URL (navigated from the
  // Edit button on the entity detail page). Only fires once per load.
  const urlSearch = useSearch();
  const urlEditIdParam = new URLSearchParams(urlSearch).get("editId");
  const [urlEditHandled, setUrlEditHandled] = useState(false);
  useEffect(() => {
    if (urlEditHandled || !urlEditIdParam || isLoading || allEntries.length === 0) return;
    const entry = allEntries.find(e => String(e.id) === String(urlEditIdParam));
    if (entry) {
      openEdit(entry);
      setUrlEditHandled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlEditIdParam, isLoading, allEntries]);

  // Per-entity project progress, for the badge/performance-score formula
  // (see src/lib/performance-score.ts). Fetched once for the whole list
  // rather than per-card, then looked up by vaultEntryId below.
  const [leaderboard, setLeaderboard] = useState<EntityLeaderboardRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    customFetch<EntityLeaderboardRow[]>("/projects/entity-leaderboard")
      .then(rows => { if (!cancelled) setLeaderboard(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setLeaderboard([]); });
    return () => { cancelled = true; };
  }, []);
  const leaderboardById = new Map(leaderboard.map(r => [r.vaultEntryId, r]));
  const performanceScoreFor = (entry: EntryAny) =>
    computeEntityPerformanceScore(entry, leaderboardById.get(entry.id));

  const allTags = (() => {
    const set = new Set<string>();
    for (const e of allEntries) if (Array.isArray(e.tags)) for (const t of e.tags) if (t) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  })();

  const filteredEntities = (() => {
    let entries = [...allEntries];
    if (filterTag !== "all") entries = entries.filter(e => Array.isArray(e.tags) && e.tags.includes(filterTag));
    if (search.trim()) {
      const q = search.toLowerCase();
      entries = entries.filter(e =>
        (e.projectName?.toLowerCase().includes(q)) ||
        (e.email?.toLowerCase().includes(q)) ||
        (e.entitySerial?.toLowerCase().includes(q)) ||
        (e.twitterUsername?.toLowerCase().includes(q)) ||
        (e.notes?.toLowerCase().includes(q))
      );
    }
    if (sortBy === "name") entries = entries.sort((a, b) => (a.projectName ?? "").localeCompare(b.projectName ?? ""));
    else entries = entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return [...entries.filter(e => pinned.includes(e.id)), ...entries.filter(e => !pinned.includes(e.id))];
  })();

  const f = (key: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }));

  const resetForm = () => {
    setForm({ ...EMPTY_FORM }); setOtherAccounts([]); setFormTab("wallet"); setFormSubTab("main");
    setFormEmailSubTab("account");
    setWalletSubTab("manual"); setDriveForm({ label: "", address: "", note: "" }); setDriveLocked(false);
    setKeyCheck(null); setKeyCheckedValue(null);
  };

  // Seed phrase / private key field changes invalidate any previous ✓/✗ —
  // the user must hit Test again after editing, so a stale "valid" badge can
  // never sit next to text that's since been changed.
  const onSeedPhraseChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setForm(prev => ({ ...prev, seedPhrase: e.target.value }));
    setKeyCheck(null);
  };

  const runKeyCheck = async () => {
    if (!form.seedPhrase.trim()) return;
    setKeyCheckLoading(true);
    try {
      const result = await validateWalletKey(form.seedPhrase);
      setKeyCheck(result);
      setKeyCheckedValue(form.seedPhrase);
    } catch {
      setKeyCheck({ valid: false, type: null, error: "Couldn't reach the server to check this — try again" });
      setKeyCheckedValue(form.seedPhrase);
    } finally {
      setKeyCheckLoading(false);
    }
  };

  // Email tab: fetch configured Mail Hub accounts so each platform's synced
  // email can show/edit its existing IMAP/SMTP config instead of a blank one.
  // Fetched lazily — only once the dialog is open and the Email tab is used —
  // since most Add/Edit sessions never touch it.
  const fetchEmailAccounts = async () => {
    setEmailAccountsLoading(true);
    try {
      const res = await fetch(`${MAIL_BASE}/api/email-accounts`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setEmailAccounts(await res.json());
    } catch {} finally { setEmailAccountsLoading(false); }
  };

  const openEdit = (entry: EntryAny) => {
    setEditId(entry.id);
    setForm({
      projectName: entry.projectName ?? "",
      username: entry.username ?? "",
      accountPassword: entry.accountPassword ?? "",
      account2fa: entry.account2fa ?? "",
      accountBackupCode: entry.accountBackupCode ?? "",
      email: entry.email ?? "",
      emailPassword: entry.emailPassword ?? "",
      email2fa: entry.email2fa ?? "",
      emailBackupCode: entry.emailBackupCode ?? "",
      emailRecovery: entry.emailRecovery ?? "",
      emailRecoveryPassword: entry.emailRecoveryPassword ?? "",
      recovery2fa: entry.recovery2fa ?? "",
      recoveryBackupCode: entry.recoveryBackupCode ?? "",
      lastLoginAt: entry.lastLoginAt ? String(entry.lastLoginAt).slice(0, 10) : "",
      buyDate: entry.buyDate ? String(entry.buyDate).slice(0, 10) : "",
      createDate: entry.createDate ? String(entry.createDate).slice(0, 10) : "",
      currentValue: entry.currentValue != null ? String(entry.currentValue) : "",
      currentBuyValue: entry.currentBuyValue != null ? String(entry.currentBuyValue) : "",
      followers: entry.followers != null ? String(entry.followers) : "",
      seedPhrase: "",
      twitterUsername: entry.twitterUsername ?? "",
      twitterPassword: entry.twitterPassword ?? "",
      twitterEmail: entry.twitterEmail ?? "",
      twitterEmailPassword: entry.twitterEmailPassword ?? "",
      twitterFollowers: entry.twitterFollowers ?? "",
      twitter2fa: entry.twitter2fa ?? "",
      twitterAccountBackupCode: entry.twitterAccountBackupCode ?? "",
      twitterEmail2fa: entry.twitterEmail2fa ?? "",
      twitterEmailBackupCode: entry.twitterEmailBackupCode ?? "",
      twitterEmailRecovery: entry.twitterEmailRecovery ?? "",
      twitterEmailRecoveryPassword: entry.twitterEmailRecoveryPassword ?? "",
      twitterRecovery2fa: entry.twitterRecovery2fa ?? "",
      twitterRecoveryBackupCode: entry.twitterRecoveryBackupCode ?? "",
      twitterAge: entry.twitterAge ?? "",
      twitterWorth: entry.twitterWorth ?? "",
      twitterBuyValue: entry.twitterBuyValue ?? "",
      twitterNotes: entry.twitterNotes ?? "",
      twitterLastLoginAt: entry.twitterLastLoginAt ? String(entry.twitterLastLoginAt).slice(0, 10) : "",
      twitterBuyDate: entry.twitterBuyDate ? String(entry.twitterBuyDate).slice(0, 10) : "",
      twitterCreateDate: entry.twitterCreateDate ? String(entry.twitterCreateDate).slice(0, 10) : "",
      discordUsername: entry.discordUsername ?? "",
      discordPassword: entry.discordPassword ?? "",
      discordEmail: entry.discordEmail ?? "",
      discordEmailPassword: entry.discordEmailPassword ?? "",
      discord2fa: entry.discord2fa ?? "",
      discordAccountBackupCode: entry.discordAccountBackupCode ?? "",
      discordEmail2fa: entry.discordEmail2fa ?? "",
      discordEmailBackupCode: entry.discordEmailBackupCode ?? "",
      discordEmailRecovery: entry.discordEmailRecovery ?? "",
      discordEmailRecoveryPassword: entry.discordEmailRecoveryPassword ?? "",
      discordRecovery2fa: entry.discordRecovery2fa ?? "",
      discordRecoveryBackupCode: entry.discordRecoveryBackupCode ?? "",
      discordFollowers: entry.discordFollowers ?? "",
      discordAge: entry.discordAge ?? "",
      discordWorth: entry.discordWorth ?? "",
      discordBuyValue: entry.discordBuyValue ?? "",
      discordNotes: entry.discordNotes ?? "",
      discordLastLoginAt: entry.discordLastLoginAt ? String(entry.discordLastLoginAt).slice(0, 10) : "",
      discordBuyDate: entry.discordBuyDate ? String(entry.discordBuyDate).slice(0, 10) : "",
      discordCreateDate: entry.discordCreateDate ? String(entry.discordCreateDate).slice(0, 10) : "",
      telegramUsername: entry.telegramUsername ?? "",
      telegramPassword: entry.telegramPassword ?? "",
      telegramPhone: entry.telegramPhone ?? "",
      telegram2fa: entry.telegram2fa ?? "",
      telegramAccountBackupCode: entry.telegramAccountBackupCode ?? "",
      telegramEmail2fa: entry.telegramEmail2fa ?? "",
      telegramEmailBackupCode: entry.telegramEmailBackupCode ?? "",
      telegramLinkedEmail: entry.telegramLinkedEmail ?? "",
      telegramLinkedEmailPassword: entry.telegramLinkedEmailPassword ?? "",
      telegramRecovery2fa: entry.telegramRecovery2fa ?? "",
      telegramRecoveryBackupCode: entry.telegramRecoveryBackupCode ?? "",
      telegramAge: entry.telegramAge ?? "",
      telegramWorth: entry.telegramWorth ?? "",
      telegramBuyValue: entry.telegramBuyValue ?? "",
      telegramFollowers: entry.telegramFollowers ?? "",
      telegramNotes: entry.telegramNotes ?? "",
      telegramLastLoginAt: entry.telegramLastLoginAt ? String(entry.telegramLastLoginAt).slice(0, 10) : "",
      telegramBuyDate: entry.telegramBuyDate ? String(entry.telegramBuyDate).slice(0, 10) : "",
      telegramCreateDate: entry.telegramCreateDate ? String(entry.telegramCreateDate).slice(0, 10) : "",
      walletAddresses: Array.isArray(entry.walletAddresses) ? entry.walletAddresses.join("\n") : (entry.walletAddresses ?? ""),
      backupCodes: Array.isArray(entry.backupCodes) ? entry.backupCodes.join("\n") : (entry.backupCodes ?? ""),
      notes: entry.notes ?? "",
      score: entry.score != null ? String(entry.score) : "5",
      tags: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
      dataEntityId: entry.dataEntityId ?? null,
    });
    try {
      const others = entry.otherAccounts ? JSON.parse(entry.otherAccounts) : [];
      setOtherAccounts(others.map((o: any) => ({ age: "", worth: "", buyValue: "", metric: "", emailPassword: "", twofa: "", notes: "", lastLoginAt: "", buyDate: "", createDate: "", ...o, id: Math.random().toString(36).slice(2) })));
    } catch { setOtherAccounts([]); }
    setFormTab("wallet");
    setFormSubTab("main");
    setWalletSubTab("manual");
    setDriveForm({ label: entry.driveWalletLabel ?? "", address: entry.driveWalletAddress ?? "", note: entry.driveWalletNote ?? "" });
    setDriveLocked(!!entry.driveWalletSetAt);
    setKeyCheck(null); setKeyCheckedValue(null);
    setDialogKey(k => k + 1);
    setOpen(true);
  };

  const addOther = () => setOtherAccounts(p => [...p, newOther()]);
  const updateOther = (id: string, u: OtherAccount) => setOtherAccounts(p => p.map(a => a.id === id ? u : a));
  const removeOther = (id: string) => setOtherAccounts(p => p.filter(a => a.id !== id));
  const togglePin = (id: number) => setPinned(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const toggleSelected = (id: number) => setSelectedIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds([]); };

  const submitBulkTag = async () => {
    const tag = bulkTagValue.trim();
    if (!tag || selectedIds.length === 0) return;
    setBulkTagSaving(true);
    try {
      const res = await fetch(`${MAIL_BASE}/api/vault/bulk-tag`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, tag, action: bulkTagAction }),
      });
      if (!res.ok) throw new Error("Bulk tag failed");
      toast({ title: `✅ "${tag}" ${bulkTagAction === "add" ? "added to" : "removed from"} ${selectedIds.length} ${selectedIds.length === 1 ? "entity" : "entities"}` });
      queryClient.invalidateQueries();
      setBulkTagOpen(false);
      setBulkTagValue("");
      exitSelectMode();
    } catch {
      toast({ variant: "destructive", title: "Bulk tag failed", description: "Please try again" });
    } finally {
      setBulkTagSaving(false);
    }
  };

  const submitBulkStatus = async () => {
    if (!bulkStatusValue || selectedIds.length === 0) return;
    setBulkStatusSaving(true);
    try {
      const res = await fetch(`${MAIL_BASE}/api/vault/bulk-action`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, action: "status", status: bulkStatusValue }),
      });
      if (!res.ok) throw new Error("Bulk status change failed");
      const data = await res.json();
      const okCount = (data.results ?? []).filter((r: any) => r.ok).length;
      toast({ title: `✅ Status set to "${bulkStatusValue}" for ${okCount} of ${selectedIds.length} ${selectedIds.length === 1 ? "entity" : "entities"}` });
      queryClient.invalidateQueries();
      setBulkStatusOpen(false);
      exitSelectMode();
    } catch {
      toast({ variant: "destructive", title: "Bulk status change failed", description: "Please try again" });
    } finally {
      setBulkStatusSaving(false);
    }
  };

  const submitBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBulkDeleteSaving(true);
    try {
      const res = await fetch(`${MAIL_BASE}/api/vault/bulk-action`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, action: "delete" }),
      });
      if (!res.ok) throw new Error("Bulk delete failed");
      const data = await res.json();
      const okCount = (data.results ?? []).filter((r: any) => r.ok).length;
      toast({ title: `🗑️ Moved ${okCount} of ${selectedIds.length} ${selectedIds.length === 1 ? "entity" : "entities"} to Trash` });
      queryClient.invalidateQueries();
      setBulkDeleteOpen(false);
      exitSelectMode();
    } catch {
      toast({ variant: "destructive", title: "Bulk delete failed", description: "Please try again" });
    } finally {
      setBulkDeleteSaving(false);
    }
  };

  // Bulk export — selected entities only, client-side (data's already loaded).
  // JSON keeps the full shape (round-trips through Import); CSV flattens the
  // common identifying columns for spreadsheet use — credentials/2FA/seed are
  // deliberately left out of the CSV so a quick "export for a teammate" doesn't
  // casually hand over plaintext-adjacent secrets in a format anyone can open.
  const exportSelected = (format: "json" | "csv") => {
    const rows = allEntries.filter(e => selectedIds.includes(e.id));
    if (rows.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "json") {
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `vault-selected-${stamp}.json`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const cols = ["id", "projectName", "username", "email", "twitterUsername", "discordUsername", "telegramUsername", "status", "score", "tags", "createdAt"];
    const escape = (v: unknown) => {
      const s = Array.isArray(v) ? v.join("|") : (v ?? "").toString();
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => escape((r as any)[c])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `vault-selected-${stamp}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportVault = () => {
    const blob = new Blob([JSON.stringify(allEntries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importVault = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const entries = JSON.parse(text);
      if (!Array.isArray(entries)) { toast({ variant: "destructive", title: "Invalid file — expected a JSON array" }); return; }
      let count = 0;
      for (const entry of entries) {
        const { id: _id, createdAt: _c, updatedAt: _u, userId: _uid, entitySerial: _s, ...rest } = entry;
        await createMutation.mutateAsync({ data: rest as any });
        count++;
      }
      toast({ title: `✅ Imported ${count} ${count === 1 ? "entity" : "entities"}` });
      queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: "Import failed", description: "File must be a valid vault JSON export" });
    }
    e.target.value = "";
  };

  const buildPayload = () => {
    const payload: Record<string, any> = { projectName: form.projectName };
    const strFields: (keyof typeof EMPTY_FORM)[] = [
      "username", "accountPassword", "account2fa", "accountBackupCode", "email2fa", "emailBackupCode",
      "recovery2fa", "recoveryBackupCode", "lastLoginAt", "buyDate", "createDate",
      "seedPhrase",
      "email", "emailPassword", "emailRecovery", "emailRecoveryPassword",
      "twitterUsername", "twitterPassword", "twitterEmail", "twitterEmailPassword",
      "twitterFollowers", "twitter2fa", "twitterAccountBackupCode", "twitterEmail2fa", "twitterEmailBackupCode",
      "twitterEmailRecovery", "twitterEmailRecoveryPassword", "twitterRecovery2fa", "twitterRecoveryBackupCode",
      "twitterAge", "twitterWorth", "twitterBuyValue",
      "twitterNotes", "twitterLastLoginAt", "twitterBuyDate", "twitterCreateDate",
      "discordUsername", "discordPassword", "discordEmail", "discordEmailPassword",
      "discord2fa", "discordAccountBackupCode", "discordEmail2fa", "discordEmailBackupCode",
      "discordEmailRecovery", "discordEmailRecoveryPassword", "discordRecovery2fa", "discordRecoveryBackupCode",
      "discordFollowers", "discordAge", "discordWorth", "discordBuyValue",
      "discordNotes", "discordLastLoginAt", "discordBuyDate", "discordCreateDate",
      "telegramUsername", "telegramPassword", "telegramPhone", "telegram2fa",
      "telegramAccountBackupCode", "telegramEmail2fa", "telegramEmailBackupCode",
      "telegramLinkedEmail", "telegramLinkedEmailPassword", "telegramRecovery2fa", "telegramRecoveryBackupCode",
      "telegramAge", "telegramWorth", "telegramBuyValue",
      "telegramFollowers", "telegramNotes", "telegramLastLoginAt", "telegramBuyDate", "telegramCreateDate", "notes",
    ];
    for (const k of strFields) if (form[k]) payload[k] = form[k];
    if (form.walletAddresses) payload.walletAddresses = form.walletAddresses.split("\n").map(s => s.trim()).filter(Boolean);
    if (form.backupCodes) payload.backupCodes = form.backupCodes.split("\n").map(s => s.trim()).filter(Boolean);
    payload.tags = form.tags.split(",").map(s => s.trim()).filter(Boolean);
    const validOther = otherAccounts.filter(a => a.platform.trim());
    if (validOther.length > 0) payload.otherAccounts = JSON.stringify(validOther.map(({ id: _id, ...rest }) => rest));
    const scoreNum = Number(form.score);
    payload.score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(10, Math.round(scoreNum))) : 5;
    if (form.currentValue !== "" && Number.isFinite(Number(form.currentValue))) payload.currentValue = Number(form.currentValue);
    if (form.currentBuyValue !== "" && Number.isFinite(Number(form.currentBuyValue))) payload.currentBuyValue = Number(form.currentBuyValue);
    if (form.followers !== "" && Number.isFinite(Number(form.followers))) payload.followers = Math.max(0, Math.round(Number(form.followers)));
    payload.dataEntityId = form.dataEntityId ?? null;
    if (!payload.seedPhrase) delete payload.seedPhrase;
    return payload;
  };

  // Blocks save when a private key/seed phrase was typed but never
  // successfully Tested (or was tested and came back invalid) — this is the
  // "correct hoile save hobe, naile wrong bolbe" gate. An empty field is
  // always fine (nothing to validate, keeps the existing stored key on edit).
  const keyBlocksSave = (): boolean => {
    if (!form.seedPhrase.trim()) return false;
    if (!keyCheck || keyCheckedValue !== form.seedPhrase) {
      toast({ variant: "destructive", title: "Test the private key first", description: "Hit Test next to the seed phrase / private key field before saving." });
      return true;
    }
    if (!keyCheck.valid) {
      toast({ variant: "destructive", title: keyCheck.type === "mnemonic" ? "Wrong seed phrase" : "Wrong private key", description: keyCheck.error ?? "Fix the value before saving." });
      return true;
    }
    return false;
  };

  const handleCreate = () => {
    if (!form.projectName) {
      toast({ variant: "destructive", title: "Entity Name is required." });
      return;
    }
    if (keyBlocksSave()) return;
    createMutation.mutate({ data: buildPayload() as any }, {
      onSuccess: () => {
        toast({ title: "Entity secured" });
        queryClient.invalidateQueries();
        setOpen(false);
        resetForm();
        setEditId(null);
      },
      onError: () => toast({ variant: "destructive", title: "Failed to create entity" }),
    });
  };

  const handleUpdate = async () => {
    if (!form.projectName) {
      toast({ variant: "destructive", title: "Entity Name is required." });
      return;
    }
    if (keyBlocksSave()) return;
    setSaving(true);
    try {
      await customFetch(`/vault/${editId}`, { method: "PATCH", body: JSON.stringify(buildPayload()) });
      toast({ title: "Entity updated" });
      queryClient.invalidateQueries();
      setOpen(false);
      resetForm();
      setEditId(null);
    } catch { toast({ variant: "destructive", title: "Failed to update entity" }); }
    finally { setSaving(false); }
  };

  const saveDriveWallet = async () => {
    if (!editId) return;
    if (!driveForm.address.trim()) { toast({ variant: "destructive", title: "Wallet address is required" }); return; }
    setSavingDrive(true);
    try {
      const updated = await customFetch(`/vault/${editId}/drive-wallet`, { method: "PATCH", body: JSON.stringify(driveForm) });
      toast({ title: "Drive wallet set", description: "This record is now fixed and can't be edited." });
      setDriveForm({
        label: (updated as any)?.driveWalletLabel ?? driveForm.label,
        address: (updated as any)?.driveWalletAddress ?? driveForm.address,
        note: (updated as any)?.driveWalletNote ?? driveForm.note,
      });
      setDriveLocked(true);
      queryClient.invalidateQueries();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to set drive wallet", description: err?.message ?? "It may already be set." });
    } finally { setSavingDrive(false); }
  };

  // Phase 3 — Account tab dropped from entity-create; its Wallet sub-tab
  // (manual addresses/seed/backup-codes + Drive wallet) is entity-level data
  // that never moved to the enroll flow, so it's promoted to a top-level tab
  // here. Main/Info/Recovery moved to the enroll-time Account form instead
  // (see EnrollDialog on pages/user/project-entities.tsx) and are no longer
  // rendered in this dialog at all.
  const FORM_TABS = [
    { id: "email", label: "Email" },
    { id: "twitter", label: "Twitter" },
    { id: "discord", label: "Discord" },
    { id: "telegram", label: "Telegram" },
    { id: "wallet", label: "Wallet" },
    { id: "other", label: "Other" },
  ];

  // ACCOUNT_SUBTABS (Main/Info/Recovery) moved to config/fields/entity-create.ts
  // — reused by the project-enrollment dialog's sub-tab strip, no longer
  // rendered in this dialog.

  // Sub-tabs inside the Email tab — one per platform tab that can carry a
  // linked email. Whatever email was typed under that platform's own tab
  // shows up here automatically (synced, not re-entered), so this is purely
  // a place to set up IMAP/SMTP one platform at a time. "Other" covers every
  // dynamically-added other-platform account in one place, same as the
  // top-level Other tab does.
  const EMAIL_SUBTABS = [
    { id: "account", label: "Account" },
    { id: "twitter", label: "Twitter" },
    { id: "telegram", label: "Telegram" },
    { id: "discord", label: "Discord" },
    { id: "wallet", label: "Wallet" },
    { id: "other", label: "Other" },
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-0 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" />
          <Input value={search} onChange={e => setSearch(e.target.value)} className="pl-8 font-mono text-xs h-8 bg-input" placeholder="Search entities..." />
        </div>
        {allTags.length > 0 && (
          <Select value={filterTag} onValueChange={setFilterTag}>
            <SelectTrigger className="w-32 font-mono text-xs h-8 bg-input">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-mono text-xs">All tags</SelectItem>
              {allTags.map(t => <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <input type="file" ref={importRef} className="hidden" accept=".json" onChange={importVault} />
          <Button
            size="sm"
            variant={selectMode ? "default" : "outline"}
            onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
            className="font-mono text-xs gap-1.5 h-8"
          >
            <CheckSquare className="w-3 h-3" /> {selectMode ? "Cancel" : "Select"}
          </Button>
          <Button size="sm" variant="outline" onClick={exportVault} className="font-mono text-xs gap-1.5 h-8">
            <Download className="w-3 h-3" /> Export
          </Button>
          <Button size="sm" variant="outline" onClick={() => importRef.current?.click()} className="font-mono text-xs gap-1.5 h-8">
            <Upload className="w-3 h-3" /> Import
          </Button>
          <Button size="sm" variant="outline" onClick={() => setManagingShares(true)} className="font-mono text-xs gap-1.5 h-8">
            <Users className="w-3 h-3" /> Shares
          </Button>
          <Button size="sm" onClick={() => { resetForm(); setEditId(null); setDialogKey(k => k + 1); setOpen(true); }} className="font-mono text-xs gap-1.5 h-8">
            <Plus className="w-3.5 h-3.5" /> New Entity
          </Button>
        </div>
      </div>

      {/* Bulk action bar — shown once at least one entity is selected.
          Only the count + a 3-dot button live here; clicking the 3-dot opens
          a square-icon-grid dropdown (same visual pattern as each card's own
          3-dot menu) instead of a row of separate action buttons. */}
      {selectMode && selectedIds.length > 0 && (
        <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
          <span className="font-mono text-xs font-bold text-primary">{selectedIds.length} selected</span>
          <div className="flex items-center gap-1 ml-auto">
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])} className="font-mono text-xs h-7">Clear</Button>
            <div className="relative">
              <button
                onClick={() => setBulkMenuOpen(o => !o)}
                className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
                title="Bulk actions"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {bulkMenuOpen && (
                <>
                  {/* Transparent backdrop — click anywhere outside the panel to close it */}
                  <div className="fixed inset-0 z-40" onClick={() => setBulkMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-card-border rounded-xl shadow-2xl p-2">
                    <div className="grid grid-cols-4 gap-1">
                      {([
                        { icon: Tag, label: "Add Tag", action: () => { setBulkTagAction("add"); setBulkTagValue(""); setBulkTagOpen(true); }, cls: "" },
                        { icon: X, label: "Rm Tag", action: () => { setBulkTagAction("remove"); setBulkTagValue(""); setBulkTagOpen(true); }, cls: "" },
                        { icon: ShieldAlert, label: "Status", action: () => { setBulkStatusValue("active"); setBulkStatusOpen(true); }, cls: "" },
                        { icon: Download, label: "JSON", action: () => exportSelected("json"), cls: "" },
                        { icon: Download, label: "CSV", action: () => exportSelected("csv"), cls: "" },
                        { icon: Share2, label: "Share", action: shareSelected, cls: "" },
                        { icon: Trash2, label: "Delete", action: () => setBulkDeleteOpen(true), cls: "text-red-400 hover:bg-red-400/10 hover:border-red-400/30 hover:text-red-400" },
                      ] as const).map(({ icon: Icon, label, action, cls }) => (
                        <button
                          key={label}
                          onClick={() => { action(); setBulkMenuOpen(false); }}
                          title={label}
                          className={cn(
                            "flex flex-col items-center justify-center gap-0.5 w-9 h-9 rounded-lg border transition-all",
                            "border-border/30 text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground hover:border-border/60",
                            cls
                          )}
                        >
                          <Icon className="w-3 h-3" />
                          <span className="font-mono text-[7px] uppercase leading-none">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      {allEntries.length > 0 && (
        <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground/50">
          <span>{allEntries.length} entities</span>
          <span>·</span>
          <span>{allEntries.filter(e => e.twitter2fa || e.discord2fa || e.telegram2fa).length} with 2FA</span>
          <span>·</span>
          <span>{allEntries.filter(e => e.hasSeedPhrase).length} with seed</span>
        </div>
      )}

      {/* Entity grid */}
      {isLoading || !entriesIntroFinished ? (
        <VaultLoadingIntro
          title="Loading your vault entities"
          done={!isLoading}
          onFinished={() => setEntriesIntroFinished(true)}
        />
      ) : filteredEntities.length === 0 ? (
        <div className="text-center py-20 space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-primary/5 border border-primary/10 flex items-center justify-center mx-auto">
            <Shield className="w-6 h-6 text-primary/40" />
          </div>
          <p className="font-mono text-sm text-muted-foreground/60">
            {search || filterTag !== "all" ? "No entities match your search" : "No entities yet — add your first"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredEntities.map(entry => (
            <div
              key={entry.id}
              className={cn(
                "bg-card border rounded-xl p-4 hover:border-primary/30 transition-all cursor-pointer group relative",
                selectedIds.includes(entry.id) ? "border-primary/60 ring-1 ring-primary/30" : pinned.includes(entry.id) ? "border-primary/30" : "border-card-border"
              )}
              onClick={() => selectMode ? toggleSelected(entry.id) : setQuickView(entry)}
            >
              {selectMode && (
                <div className="absolute top-3 right-3 z-10" onClick={e => { e.stopPropagation(); toggleSelected(entry.id); }}>
                  <Checkbox checked={selectedIds.includes(entry.id)} />
                </div>
              )}
              {/* Pin */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <RankBadge score={performanceScoreFor(entry)} showLabel={false} size={16} />
                </div>
                <div className={cn("flex items-center gap-0.5 transition-opacity", selectMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100")}>
                  <button
                    onClick={e => { e.stopPropagation(); togglePin(entry.id); }}
                    className={cn("p-1 rounded transition-all", pinned.includes(entry.id) ? "text-amber-400" : "text-muted-foreground/40 hover:text-amber-400")}
                  >
                    <Star className="w-3 h-3" fill={pinned.includes(entry.id) ? "currentColor" : "none"} />
                  </button>
                  {/* 3-dot action menu */}
                  <div className="relative">
                    <button
                      onClick={e => { e.stopPropagation(); setOpenMenuId(openMenuId === entry.id ? null : entry.id); }}
                      className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                    {openMenuId === entry.id && (
                      <div
                        className="absolute right-0 top-full mt-1 z-50 bg-card border border-card-border rounded-xl shadow-2xl p-2"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="grid grid-cols-4 gap-1">
                          {([
                            { icon: Edit2, label: "Edit", action: () => openEdit(entry), cls: "" },
                            { icon: Share2, label: "Share", action: () => shareOne(entry), cls: "" },
                            { icon: Tag, label: "Tag", action: () => { setSelectedIds([entry.id]); setBulkTagAction("add"); setBulkTagValue(""); setBulkTagOpen(true); }, cls: "" },
                            { icon: Download, label: "Exprt", action: () => { setSelectedIds([entry.id]); setTimeout(() => exportSelected("json"), 0); }, cls: "" },
                            { icon: Upload, label: "Imprt", action: () => importRef.current?.click(), cls: "" },
                            { icon: Ban, label: "Ban", action: () => { setSelectedIds([entry.id]); setBulkStatusValue("banned"); setBulkStatusOpen(true); }, cls: "" },
                            { icon: ShieldAlert, label: "Stat", action: () => { setSelectedIds([entry.id]); setBulkStatusValue("active"); setBulkStatusOpen(true); }, cls: "" },
                            { icon: Trash2, label: "Del", action: () => setDeleteId(entry.id), cls: "text-red-400 hover:bg-red-400/10 hover:border-red-400/30 hover:text-red-400" },
                          ] as const).map(({ icon: Icon, label, action, cls }) => (
                            <button
                              key={label}
                              onClick={() => { action(); setOpenMenuId(null); }}
                              title={label}
                              className={cn(
                                "flex flex-col items-center justify-center gap-0.5 w-9 h-9 rounded-lg border transition-all",
                                "border-border/30 text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground hover:border-border/60",
                                cls
                              )}
                            >
                              <Icon className="w-3 h-3" />
                              <span className="font-mono text-[7px] uppercase leading-none">{label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <p className="font-mono text-sm font-bold text-foreground truncate mb-1">{entry.projectName}</p>
              <div className="flex items-center justify-between mb-1.5">
                <p className="font-mono text-[10px] text-muted-foreground/50">{entry.entitySerial}</p>
                <div className="flex items-center gap-1">
                  <WorthDeltaBadge entry={entry} size="xs" />
                  {computeEntityWorth(entry) > 0 && (
                    <span className="font-mono text-[10px] font-bold text-amber-400">${computeEntityWorth(entry).toFixed(0)}</span>
                  )}
                </div>
              </div>
              {(leaderboardById.get(entry.id)?.totalProjects ?? 0) > 0 && (
                <div className="flex items-center gap-1 mb-1.5 font-mono text-[9px] text-muted-foreground/50">
                  <FolderGit2 className="w-2.5 h-2.5" />
                  {leaderboardById.get(entry.id)!.totalProjects} enrolled project{leaderboardById.get(entry.id)!.totalProjects === 1 ? "" : "s"}
                </div>
              )}

              {/* Feature chips */}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {entry.email && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">EMAIL</span>}
                {entry.twitterUsername && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-sky-400/10 text-sky-400 border border-sky-400/20">TW</span>}
                {entry.discordUsername && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-indigo-400/10 text-indigo-400 border border-indigo-400/20">DC</span>}
                {entry.telegramUsername && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-400 border border-blue-400/20">TG</span>}
                {(entry.twitter2fa || entry.discord2fa || entry.telegram2fa) && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">2FA</span>}
                {entry.hasSeedPhrase && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-violet-400/10 text-violet-400 border border-violet-400/20">SEED</span>}
                {Array.isArray(entry.walletAddresses) && entry.walletAddresses.length > 0 && (
                  <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20">WALLET</span>
                )}
              </div>

              {Array.isArray(entry.tags) && entry.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {entry.tags.map((t: string) => (
                    <span
                      key={t}
                      onClick={e => { e.stopPropagation(); setFilterTag(t); }}
                      className="font-mono text-[8px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors cursor-pointer"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Quick View Dialog — credential names only, never passwords */}
      <Dialog open={!!quickView} onOpenChange={open => !open && setQuickView(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" /> {quickView?.projectName}
            </DialogTitle>
          </DialogHeader>
          {quickView && (
            <div className="space-y-3">
              <div className="flex items-center justify-end">
                <RankBadge score={performanceScoreFor(quickView)} />
              </div>
              <div className="flex items-center justify-between -mt-1">
                <span className="font-mono text-[10px] text-muted-foreground/50">{quickView.entitySerial}</span>
                <div className="flex items-center gap-1.5">
                  <WorthDeltaBadge entry={quickView} />
                  {computeEntityWorth(quickView) > 0 && (
                    <span className="font-mono text-[10px] font-bold text-amber-400">${computeEntityWorth(quickView).toFixed(0)}</span>
                  )}
                </div>
              </div>

              <EntityStatusFlags entry={quickView} leaderboardRow={leaderboardById.get(quickView.id)} />

              {(() => {
                const lb = leaderboardById.get(quickView.id);
                if (!lb || !lb.totalProjects) return null;
                return (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/10 border border-border/30 font-mono text-[10px] text-muted-foreground/70">
                    <FolderGit2 className="w-3 h-3 text-primary/60 flex-shrink-0" />
                    Enrolled in {lb.totalProjects} project{lb.totalProjects === 1 ? "" : "s"}
                    {typeof lb.activeProjects === "number" && lb.activeProjects > 0 && `, ${lb.activeProjects} active`}
                  </div>
                );
              })()}

              {Array.isArray((quickView as any).tags) && (quickView as any).tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(quickView as any).tags.map((t: string) => (
                    <span key={t} className="font-mono text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">#{t}</span>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                {[
                  { label: "Email", value: quickView.email },
                  { label: "Twitter", value: quickView.twitterUsername },
                  { label: "Discord", value: quickView.discordUsername },
                  { label: "Telegram", value: quickView.telegramUsername },
                ].filter(f => f.value).map(f => (
                  <div key={f.label} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-muted/10 border border-border/30">
                    <span className="font-mono text-[10px] text-muted-foreground/60">{f.label}</span>
                    <span className="font-mono text-xs text-foreground truncate max-w-[180px]">{f.value}</span>
                  </div>
                ))}
                {!quickView.email && !quickView.twitterUsername && !quickView.discordUsername && !quickView.telegramUsername && (
                  <p className="font-mono text-[10px] text-muted-foreground/40 text-center py-2">No credentials added yet</p>
                )}
              </div>

              <p className="font-mono text-[9px] text-muted-foreground/40 flex items-center gap-1">
                <Lock className="w-2.5 h-2.5" /> Passwords hidden — open full details to reveal
              </p>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 font-mono text-xs gap-1.5"
                  onClick={() => { const id = quickView.id; setQuickView(null); navigate(`/vault/entity/${id}/access`); }}
                >
                  <KeyRound className="w-3.5 h-3.5" /> Access
                </Button>
                <Button
                  className="flex-1 font-mono text-xs"
                  onClick={() => { const id = quickView.id; setQuickView(null); navigate(`/vault/entity/${id}`); }}
                >
                  View Full Details
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk Tag Dialog — add/remove one tag across all selected entities */}
      <Dialog open={bulkTagOpen} onOpenChange={o => !o && setBulkTagOpen(false)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <Tag className="w-4 h-4 text-primary" />
              {bulkTagAction === "add" ? "Add Tag" : "Remove Tag"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="font-mono text-[10px] text-muted-foreground/60">
              {bulkTagAction === "add" ? "Adding to" : "Removing from"} {selectedIds.length} {selectedIds.length === 1 ? "entity" : "entities"}
            </p>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Tag name</Label>
              <Input
                value={bulkTagValue}
                onChange={e => setBulkTagValue(e.target.value)}
                onKeyDown={e => e.key === "Enter" && submitBulkTag()}
                className="font-mono text-xs h-8 bg-input"
                placeholder="e.g. priority"
                autoFocus
              />
              {bulkTagAction === "remove" && allTags.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {allTags.map(t => (
                    <span
                      key={t}
                      onClick={() => setBulkTagValue(t)}
                      className="font-mono text-[9px] px-1.5 py-0.5 rounded-full bg-muted/20 text-muted-foreground/70 border border-border hover:bg-primary/10 hover:text-primary hover:border-primary/20 cursor-pointer transition-colors"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkTagOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button size="sm" onClick={submitBulkTag} disabled={!bulkTagValue.trim() || bulkTagSaving} className="font-mono text-xs gap-1.5">
              {bulkTagSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {bulkTagAction === "add" ? "Add Tag" : "Remove Tag"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk status change */}
      <Dialog open={bulkStatusOpen} onOpenChange={o => !o && setBulkStatusOpen(false)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-primary" /> Change Status
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="font-mono text-[10px] text-muted-foreground/60">
              Setting status for {selectedIds.length} {selectedIds.length === 1 ? "entity" : "entities"}
            </p>
            <Select value={bulkStatusValue} onValueChange={setBulkStatusValue}>
              <SelectTrigger className="font-mono text-xs h-8 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active" className="font-mono text-xs">Active</SelectItem>
                <SelectItem value="warning" className="font-mono text-xs">Warning</SelectItem>
                <SelectItem value="banned" className="font-mono text-xs">Banned</SelectItem>
                <SelectItem value="suspended" className="font-mono text-xs">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkStatusOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button size="sm" onClick={submitBulkStatus} disabled={bulkStatusSaving} className="font-mono text-xs gap-1.5">
              {bulkStatusSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Set Status
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm */}
      <Dialog open={bulkDeleteOpen} onOpenChange={o => !o && setBulkDeleteOpen(false)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Move {selectedIds.length} {selectedIds.length === 1 ? "Entity" : "Entities"} to Trash?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">The selected entities will move to Vault → Trash. Restorable within 30 days, after which they're permanently deleted.</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkDeleteOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={submitBulkDelete} disabled={bulkDeleteSaving} className="font-mono text-xs gap-1.5">
              {bulkDeleteSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareEntityDialog
        open={shareItems !== null}
        onClose={() => setShareItems(null)}
        items={shareItems ?? []}
        entityLabel={shareLabel}
        onShared={() => setSelectedIds([])}
      />
      <ManageSharesDialog open={managingShares} onClose={() => setManagingShares(false)} entityType="entity" />

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

      {/* Delete confirm */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Move to Trash?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">Moves to Vault → Trash. Restorable within 30 days, after which it's permanently deleted.</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteId(null)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => {
              if (deleteId) {
                deleteMutation.mutate({ id: deleteId } as any, {
                  onSuccess: () => { toast({ title: "Moved to Trash", description: "Restorable from Vault → Trash for 30 days." }); queryClient.invalidateQueries(); setDeleteId(null); },
                  onError: () => toast({ variant: "destructive", title: "Failed to delete" }),
                });
              }
            }} className="font-mono text-xs">Move to Trash</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / Edit dialog — key changes on each open to guarantee fresh mount (Feature 1: form isolation) */}
      <Dialog key={dialogKey} open={open} onOpenChange={v => { if (!v) { setOpen(false); resetForm(); setEditId(null); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-5 pt-5 pb-3 flex-shrink-0 border-b border-card-border">
            <DialogTitle className="font-mono text-sm">{editId ? "Edit Entity" : "Add Entity"}</DialogTitle>
          </DialogHeader>

          {/* Form tabs */}
          <div className="px-5 pt-3 flex gap-1 flex-shrink-0 overflow-x-auto">
            {FORM_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => { setFormTab(t.id); setFormSubTab("main"); }}
                className={cn(
                  "px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider flex-shrink-0 transition-all",
                  formTab === t.id ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Platform sub-tabs — Main / Info / Recovery (same shape as account enrollment) */}
          {(formTab === "twitter" || formTab === "discord" || formTab === "telegram") && (
            <div className="px-5 pt-2 flex gap-1 flex-shrink-0 overflow-x-auto">
              {ACCOUNT_SUBTABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setFormSubTab(t.id)}
                  className={cn(
                    "px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider flex-shrink-0 transition-all border",
                    formSubTab === t.id ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {/* Email sub-tabs — one per platform that can carry a linked email */}
          {formTab === "email" && (
            <div className="px-5 pt-2 flex gap-1 flex-shrink-0 overflow-x-auto">
              {EMAIL_SUBTABS.map(t => {
                const synced = t.id === "account" ? !!form.email
                  : t.id === "twitter" ? !!form.twitterEmail
                  : t.id === "telegram" ? !!form.telegramLinkedEmail
                  : t.id === "discord" ? !!form.discordEmail
                  : t.id === "other" ? otherAccounts.some(a => a.email.trim())
                  : false; // wallet — no linked-email field on this platform
                return (
                  <button
                    key={t.id}
                    onClick={() => setFormEmailSubTab(t.id)}
                    className={cn(
                      "px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider flex-shrink-0 transition-all border flex items-center gap-1",
                      formEmailSubTab === t.id ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
                    )}
                  >
                    {t.label}
                    {synced && <span className="w-1 h-1 rounded-full bg-emerald-400" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {formTab === "wallet" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1">
                    <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Entity Name *</Label>
                    <Input value={form.projectName} onChange={f("projectName")} className="font-mono text-xs h-8 bg-input" placeholder="Protocol / Project name" />
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Score (0-10)</Label>
                    <RankBadge score={Number(form.score)} />
                  </div>
                  <Input
                    type="number" min={0} max={10} step={1}
                    value={form.score}
                    onChange={e => setForm(p => ({ ...p, score: e.target.value }))}
                    className="font-mono text-xs h-8 bg-input"
                  />
                  <p className="text-[9px] font-mono text-muted-foreground/50">Drives this entity's rank badge — 0-1 Warrior, 2-3 Elite, 4-5 Master, 6-7 Grandmaster, 8-10 Mythic.</p>
                </div>
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase text-muted-foreground/60 flex items-center gap-1"><Tag className="w-2.5 h-2.5" /> Tags</Label>
                  <Input
                    value={form.tags}
                    onChange={f("tags")}
                    className="font-mono text-xs h-8 bg-input"
                    placeholder="priority, airdrop-live, needs-kyc"
                  />
                  {form.tags.trim() && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {form.tags.split(",").map(s => s.trim()).filter(Boolean).map(t => (
                        <span key={t} className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{t}</span>
                      ))}
                    </div>
                  )}
                  <p className="text-[9px] font-mono text-muted-foreground/50">Comma-separated. Used for filtering and bulk grouping on the list view.</p>
                </div>
                <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1 w-fit">
                  <button
                    onClick={() => setWalletSubTab("manual")}
                    className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] uppercase transition-all", walletSubTab === "manual" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
                  >
                    <Wallet className="w-3 h-3" /> Manual
                  </button>
                  <button
                    onClick={() => setWalletSubTab("drive")}
                    className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] uppercase transition-all", walletSubTab === "drive" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
                  >
                    <HardDrive className="w-3 h-3" /> Drive
                  </button>
                </div>

                {walletSubTab === "manual" && (
                  <>
                    <SchemaForm
                      fields={ENTITY_FIELDS.filter(fld => fld.key === "walletAddresses")}
                      form={form}
                      onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
                    />
                    <div className="space-y-1">
                      <Label className="font-mono text-[10px] uppercase text-muted-foreground/60 flex items-center gap-1"><Lock className="w-2.5 h-2.5" /> Add Private Key</Label>
                      <Textarea
                        value={form.seedPhrase}
                        onChange={onSeedPhraseChange}
                        placeholder="Seed phrase / private key — encrypted before storage"
                        className="font-mono text-xs bg-input resize-none h-16"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!form.seedPhrase.trim() || keyCheckLoading}
                          onClick={runKeyCheck}
                          className="font-mono text-[10px] h-6 px-2 gap-1"
                        >
                          {keyCheckLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                          Test
                        </Button>
                        {keyCheck && keyCheckedValue === form.seedPhrase && (
                          keyCheck.valid ? (
                            <span className="font-mono text-[9px] text-green-500 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" />
                              Valid {keyCheck.type === "mnemonic" ? "seed phrase" : "private key"}
                              {keyCheck.address ? ` — ${keyCheck.address.slice(0, 6)}…${keyCheck.address.slice(-4)}` : ""}
                            </span>
                          ) : (
                            <span className="font-mono text-[9px] text-red-500 flex items-center gap-1">
                              <XCircle className="w-3 h-3" />
                              {keyCheck.error ?? "Invalid"}
                            </span>
                          )
                        )}
                      </div>
                      <p className="text-[9px] font-mono text-muted-foreground/50">Stored AES-256-GCM encrypted. Leave blank to keep the existing one unchanged. Hit Test to verify before saving.</p>
                    </div>
                    <SchemaForm
                      fields={ENTITY_FIELDS.filter(fld => fld.key === "backupCodes")}
                      form={form}
                      onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
                    />
                  </>
                )}

                {walletSubTab === "drive" && (
                  <div className="space-y-3">
                    {!editId ? (
                      <p className="text-[9px] font-mono text-muted-foreground/50">Save the entity first, then set its Drive wallet — it's a one-time fixed record.</p>
                    ) : driveLocked ? (
                      <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 space-y-2">
                        <p className="font-mono text-[9px] uppercase tracking-widest text-amber-400/80 flex items-center gap-1"><Lock className="w-2.5 h-2.5" /> Fixed — cannot be edited</p>
                        {driveForm.label && <p className="font-mono text-xs text-foreground/90">{driveForm.label}</p>}
                        <p className="font-mono text-[11px] text-muted-foreground/80 break-all">{driveForm.address}</p>
                        {driveForm.note && <p className="font-mono text-[10px] text-muted-foreground/50">{driveForm.note}</p>}
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1">
                          <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Label</Label>
                          <Input value={driveForm.label} onChange={e => setDriveForm(p => ({ ...p, label: e.target.value }))} className="font-mono text-xs h-8 bg-input" placeholder="e.g. Main vault wallet" />
                        </div>
                        <div className="space-y-1">
                          <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Wallet Address *</Label>
                          <Input value={driveForm.address} onChange={e => setDriveForm(p => ({ ...p, address: e.target.value }))} className="font-mono text-xs h-8 bg-input" placeholder="0x..." />
                        </div>
                        <div className="space-y-1">
                          <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Note</Label>
                          <Textarea value={driveForm.note} onChange={e => setDriveForm(p => ({ ...p, note: e.target.value }))} className="font-mono text-xs bg-input resize-none h-14" placeholder="Optional note" />
                        </div>
                        <p className="text-[9px] font-mono text-amber-400/70">Once set this becomes permanent — it can't be changed or cleared afterward.</p>
                        <Button size="sm" onClick={saveDriveWallet} disabled={savingDrive} className="font-mono text-xs gap-1.5 w-full">
                          {savingDrive && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Set Drive Wallet
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {(formTab === "twitter" || formTab === "discord" || formTab === "telegram") && formSubTab === "main" && (
              <LocalEntityPicker
                platform={formTab as "twitter" | "discord" | "telegram"}
                accounts={localAccsForPicker}
                loading={localAccPickerLoading}
                linked={localPlatformLink}
                onImport={(acc) => {
                  const p = formTab as "twitter" | "discord" | "telegram";
                  const u: Record<string, string> = {};
                  if (acc.username) u[p === "twitter" ? "twitterUsername" : p === "discord" ? "discordUsername" : "telegramUsername"] = acc.username;
                  if (acc.password) u[p === "twitter" ? "twitterPassword" : p === "discord" ? "discordPassword" : "telegramPassword"] = acc.password;
                  if (acc.email)    u[p === "telegram" ? "telegramLinkedEmail" : p === "twitter" ? "twitterEmail" : "discordEmail"] = acc.email;
                  if (acc.twofa)    u[p === "twitter" ? "twitter2fa" : p === "discord" ? "discord2fa" : "telegram2fa"] = acc.twofa;
                  if (acc.followers) u[p === "twitter" ? "twitterFollowers" : p === "discord" ? "discordFollowers" : "telegramFollowers"] = acc.followers;
                  setForm(prev => ({ ...prev, ...u }));
                  setLocalPlatformLink({ id: acc.id, label: acc.label ?? acc.username ?? `#${acc.id}` });
                  // Persist the link on the local account — best-effort, non-blocking
                  customFetch(`/api/local-accounts/${acc.id}/link-vault`, { method: "PATCH", body: JSON.stringify({ vaultEntryId: editId ?? 0 }) }).catch(() => {});
                }}
                onClear={() => setLocalPlatformLink(null)}
              />
            )}
            {(formTab === "twitter" || formTab === "discord" || formTab === "telegram") && (
              <SchemaForm
                fields={ENTITY_FIELDS.filter(fld => fld.tab === formTab && fld.subtab === formSubTab)}
                form={form}
                onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
              />
            )}
            {formTab === "email" && (
              <div className="space-y-3">
                <p className="font-mono text-[9px] text-muted-foreground/50 leading-relaxed">
                  Emails already entered on each platform tab sync here automatically — set up IMAP/SMTP once per address and it syncs straight to Mail Hub.
                </p>
                {emailAccountsLoading && emailAccounts.length === 0 && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-4 h-4 text-primary animate-spin" />
                  </div>
                )}
                {formEmailSubTab === "account" && (
                  <EmailPlatformPanel
                    email={form.email} label="Account"
                    account={emailAccounts.find(a => a.emailAddress === form.email) ?? null}
                    token={token} onSaved={fetchEmailAccounts}
                  />
                )}
                {formEmailSubTab === "twitter" && (
                  <EmailPlatformPanel
                    email={form.twitterEmail} label="Twitter"
                    account={emailAccounts.find(a => a.emailAddress === form.twitterEmail) ?? null}
                    token={token} onSaved={fetchEmailAccounts}
                    onJump={() => { setFormTab("twitter"); setFormSubTab("main"); }}
                  />
                )}
                {formEmailSubTab === "telegram" && (
                  <EmailPlatformPanel
                    email={form.telegramLinkedEmail} label="Telegram"
                    account={emailAccounts.find(a => a.emailAddress === form.telegramLinkedEmail) ?? null}
                    token={token} onSaved={fetchEmailAccounts}
                    onJump={() => { setFormTab("telegram"); setFormSubTab("main"); }}
                  />
                )}
                {formEmailSubTab === "discord" && (
                  <EmailPlatformPanel
                    email={form.discordEmail} label="Discord"
                    account={emailAccounts.find(a => a.emailAddress === form.discordEmail) ?? null}
                    token={token} onSaved={fetchEmailAccounts}
                    onJump={() => { setFormTab("discord"); setFormSubTab("main"); }}
                  />
                )}
                {formEmailSubTab === "wallet" && (
                  <div className="text-center py-8 space-y-2 border border-dashed border-border/40 rounded-lg px-4">
                    <Wallet className="w-6 h-6 text-muted-foreground/20 mx-auto" />
                    <p className="font-mono text-xs text-muted-foreground/50">Wallets don't carry a linked email in this vault</p>
                    <p className="font-mono text-[9px] text-muted-foreground/40">If a CEX/exchange wallet needs one, add it as a platform under Other — it'll show up here too.</p>
                    <Button variant="outline" size="sm" onClick={() => setFormTab("other")} className="font-mono text-[10px] gap-1.5">
                      Go to Other tab
                    </Button>
                  </div>
                )}
                {formEmailSubTab === "other" && (
                  <div className="space-y-4">
                    {otherAccounts.filter(a => a.email.trim()).length === 0 ? (
                      <div className="text-center py-8 space-y-2 border border-dashed border-border/40 rounded-lg">
                        <Mail className="w-6 h-6 text-muted-foreground/20 mx-auto" />
                        <p className="font-mono text-xs text-muted-foreground/50">No linked emails on Other platforms yet</p>
                        <Button variant="outline" size="sm" onClick={() => setFormTab("other")} className="font-mono text-[10px] gap-1.5">
                          Go to Other tab
                        </Button>
                      </div>
                    ) : (
                      otherAccounts.filter(a => a.email.trim()).map(a => (
                        <EmailPlatformPanel
                          key={a.id}
                          email={a.email} label={a.platform || "Other"}
                          account={emailAccounts.find(acc => acc.emailAddress === a.email) ?? null}
                          token={token} onSaved={fetchEmailAccounts}
                          onJump={() => setFormTab("other")}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            {formTab === "other" && (
              <div className="space-y-3">
                <div className="space-y-1.5 pb-1 border-b border-border/20">
                  <p className="font-mono text-[10px] text-muted-foreground/50">
                    Link Data Entity — reuse an identity/KYC-document record (NID, name, father's name,
                    birthdate, photos) instead of re-typing it. Same bridge a KYC entity uses, and works
                    alongside any Local Entity already linked on the Twitter/Discord/Telegram tabs.
                  </p>
                  <DataEntityPicker
                    value={form.dataEntityId ?? null}
                    onChange={id => setForm(prev => ({ ...prev, dataEntityId: id }))}
                    currentVaultEntryId={editId ?? null}
                  />
                </div>
                {otherAccounts.map(a => (
                  <OtherAccountForm key={a.id} account={a} onChange={u => updateOther(a.id, u)} onRemove={() => removeOther(a.id)} />
                ))}
                <Button variant="outline" size="sm" onClick={addOther} className="font-mono text-xs gap-1.5 w-full">
                  <Plus className="w-3.5 h-3.5" /> Add Platform
                </Button>
              </div>
            )}
          </div>

          {editId && (
            <>
              <ValueEntryDialog
                open={valueDialogOpen}
                onOpenChange={setValueDialogOpen}
                sourceType="vault"
                sourceId={editId}
                title={form.projectName || "Entity"}
                targets={[{ value: "account", label: "Account" }]}
                onSaved={() => queryClient.invalidateQueries()}
              />
              <FollowerEntryDialog
                open={followerDialogOpen}
                onOpenChange={setFollowerDialogOpen}
                sourceId={editId}
                title={form.projectName || "Entity"}
                onSaved={() => queryClient.invalidateQueries()}
              />
            </>
          )}

          <DialogFooter className="px-5 py-3 border-t border-card-border flex-shrink-0">
            <Button variant="outline" size="sm" onClick={() => { setOpen(false); resetForm(); setEditId(null); }} className="font-mono text-xs">Cancel</Button>
            <Button size="sm" onClick={editId ? handleUpdate : handleCreate} disabled={createMutation.isPending || saving} className="font-mono text-xs gap-1.5">
              {(createMutation.isPending || saving) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {editId ? "Save Changes" : "Secure Entity"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Entity Tab wrapper (Dashboard + List) ───────────────────────────────────────
function EntityTab() {
  const search = useSearch();
  const urlEditId = new URLSearchParams(search).get("editId");
  // Force list view when a specific editId is passed in the URL (from Edit button on detail page)
  const [view, setView] = useState<"dashboard" | "list">(urlEditId ? "list" : "dashboard");
  const effectiveView = urlEditId ? "list" : view;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1 w-fit">
        <button
          onClick={() => setView("dashboard")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", effectiveView === "dashboard" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
        >
          <LayoutDashboard className="w-3 h-3" /> Dashboard
        </button>
        <button
          onClick={() => setView("list")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", effectiveView === "list" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
        >
          <List className="w-3 h-3" /> Manage
        </button>
      </div>
      {effectiveView === "dashboard" ? (
        <Suspense fallback={<LoadingTab />}>
          <VaultEntityDashboard />
        </Suspense>
      ) : (
        <EntityManager />
      )}
    </div>
  );
}

// ── Local Tab wrapper (Dashboard + Account) ─────────────────────────────────────
function LocalTab() {
  const [view, setView] = useState<"dashboard" | "account">("dashboard");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1 w-fit">
        <button
          onClick={() => setView("dashboard")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", view === "dashboard" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
        >
          <LayoutDashboard className="w-3 h-3" /> Dashboard
        </button>
        <button
          onClick={() => setView("account")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", view === "account" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
        >
          <Smartphone className="w-3 h-3" /> Account
        </button>
      </div>
      {view === "dashboard" ? (
        <Suspense fallback={<LoadingTab />}>
          <VaultLocalDashboard />
        </Suspense>
      ) : (
        <LocalAccounts />
      )}
    </div>
  );
}

// ── KYC Tab wrapper (Dashboard + Manage) ────────────────────────────────────
// Same Dashboard/Manage split as LocalTab above: Dashboard gives an
// Overview (progress cards per category) + Category switch (view entities
// grouped by exchange/platform category), Manage is the existing KycEntries
// create/edit/list view.
function KycTab() {
  const [view, setView] = useState<"dashboard" | "manage">("dashboard");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1 w-fit">
        <button
          onClick={() => setView("dashboard")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", view === "dashboard" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
        >
          <LayoutDashboard className="w-3 h-3" /> Dashboard
        </button>
        <button
          onClick={() => setView("manage")}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", view === "manage" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
        >
          <List className="w-3 h-3" /> Manage
        </button>
      </div>
      {view === "dashboard" ? (
        <Suspense fallback={<LoadingTab />}>
          <VaultKycDashboard />
        </Suspense>
      ) : (
        <KycEntries />
      )}
    </div>
  );
}

// ── Main Vault Page ────────────────────────────────────────────────────────────
type VaultTab = "entity" | "wallet" | "local" | "mail" | "kyc" | "game";

const TAB_META: Record<VaultTab, { label: string; desc: string }> = {
  entity: { label: "Entity Vault",   desc: "Manage credentials and track entity health completeness" },
  wallet: { label: "Wallet & Seeds", desc: "Seed phrases encrypted per entity + real-time MetaMask connect" },
  local:  { label: "Local Accounts", desc: "Dashboard analytics and account management for local platforms" },
  mail:   { label: "Mail Hub",       desc: "All emails from entities and local accounts in one place" },
  kyc:    { label: "KYC",            desc: "KYC entities per exchange/platform — account, email, and seller/buyer info" },
  game:   { label: "Game",           desc: "Game accounts vault — account, email, rank/level/tags per platform" },
};

export default function UserVault() {
  const search = useSearch();
  const tab = (new URLSearchParams(search).get("tab") as VaultTab) || "entity";
  const meta = TAB_META[tab] ?? TAB_META["entity"];

  return (
    <div className="space-y-5 page-enter">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <KeyRound className="w-4 h-4 text-primary" />
            </div>
            {meta.label}
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1 pl-0.5">{meta.desc}</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-5 min-h-0">
        <VaultSidebar />
        <div className="flex-1 min-w-0">
          {tab === "entity" && <EntityTab />}
          {tab === "local"  && <LocalTab />}
          {tab === "kyc"    && <KycTab />}
          {tab === "game"   && <GameEntries />}
          {tab === "wallet" && (
            <Suspense fallback={<LoadingTab />}>
              <VaultWalletSeed />
            </Suspense>
          )}
          {tab === "mail" && (
            <Suspense fallback={<LoadingTab />}>
              <VaultMail />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
