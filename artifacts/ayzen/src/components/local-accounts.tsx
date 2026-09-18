import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Plus, Trash2, Eye, EyeOff, Copy, Check,
  Lock, Shield, Users, TrendingUp,
  Calendar, DollarSign, Edit3, X, Tag, Smartphone,
  Clock, UserCheck, Star, BarChart2,
  Zap, Loader2, ChevronDown, MoreVertical, Share2, Ban, ShieldOff,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { customFetch } from "@workspace/api-client-react";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { ShareEntityDialog, type ShareTarget } from "@/components/vault/share-entity-dialog";
import { ManageSharesDialog } from "@/components/vault/manage-shares-dialog";
import { LOCAL_ACCOUNT_FIELDS } from "@/config/fields/local-account-create";
import {
  LOCAL_ACCOUNT_DEFAULT_CATEGORIES,
  getLocalAccountPlatformMeta,
  getLocalAccountPlatformGradient,
} from "@/config/vault-local";
import { RankBadge } from "@/lib/entity-rank";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LocalAccount {
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
  score: number | null;
  status?: string | null;
  // Entity ↔ Local bridge — set when this local account was auto-created
  // from (or imported into) a vault entity's platform tab, rather than
  // created standalone from the Local tab. vault_entry_id is the linked
  // entity's id; origin distinguishes "auto-created by the entity form"
  // ('entity') from a normal manual account ('standalone').
  vault_entry_id?: number | null;
  origin?: "entity" | "standalone" | null;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string | number;
  name: string;
  color: string;
  icon: string;
  isCustom?: boolean;
}

// Platform metric config, default categories, and gradient lookup all now
// live in @/config/vault-local.ts (LOCAL_ACCOUNT_PLATFORM_META,
// LOCAL_ACCOUNT_DEFAULT_CATEGORIES, LOCAL_ACCOUNT_PLATFORM_GRADIENTS) —
// imported above. Adding a platform is one entry in that file.

// ─── Utility: age from date ───────────────────────────────────────────────────
function calcAge(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days < 1) return "Today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = days / 365;
  return `${years.toFixed(1)}y`;
}

function calcROI(worth: number, buyPrice: number): number | null {
  if (!buyPrice || buyPrice === 0) return null;
  return ((worth - buyPrice) / buyPrice) * 100;
}

// ─── SecretField: masked with reveal + copy ───────────────────────────────────
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
    <div className="flex items-center gap-2 group/sf py-0.5">
      <span className="text-[9px] font-mono text-muted-foreground/40 uppercase tracking-wider w-16 flex-shrink-0">{label}</span>
      <span className="flex-1 font-mono text-[11px] truncate text-muted-foreground/70">
        {shown ? value : "•".repeat(Math.min(value.length, 12))}
      </span>
      <div className="flex gap-1">
        <button onClick={() => setShown(s => !s)} className="text-muted-foreground/30 hover:text-primary transition-colors">
          {shown ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
        <button onClick={copy} className={cn("transition-colors", copied ? "text-emerald-400" : "text-muted-foreground/30 hover:text-primary")}>
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
    </div>
  );
}

// ─── Account View Dialog ──────────────────────────────────────────────────────
function AccountViewDialog({
  account, open, onClose, onEdit,
}: {
  account: LocalAccount | null;
  open: boolean;
  onClose: () => void;
  onEdit: (a: LocalAccount) => void;
}) {
  const [, navigate] = useLocation();
  if (!account) return null;
  const roi = calcROI(account.account_worth, account.buy_price);
  const age = calcAge(account.account_create_date);
  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="bg-card border-card-border max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-primary flex items-center gap-2">
            <Shield className="w-4 h-4" />
            {account.label || account.username || account.email || `Account #${account.id}`}
            <RankBadge score={account.score} size={16} />
            {account.origin === "entity" && (
              <span
                title="Auto-created from an Entity's platform tab"
                className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/20 flex items-center gap-1"
              >
                <Zap className="w-2.5 h-2.5" /> FROM ENTITY
              </span>
            )}
          </DialogTitle>
          <p className="text-[11px] font-mono text-muted-foreground/50">
            {account.category}{age !== "—" ? ` · ${age} old` : ""}
          </p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Credentials */}
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-primary/60 mb-2">Credentials</p>
            <div className="space-y-0.5 bg-muted/10 rounded-lg px-3 py-2 border border-border/30">
              <SecretField label="Username" value={account.username} />
              <SecretField label="Email" value={account.email} />
              <SecretField label="Password" value={account.password} />
              <SecretField label="Rec. Email" value={account.recovery_email} />
              <SecretField label="Rec. Pass" value={account.recovery_email_password} />
              <SecretField label="2FA" value={account.twofa} />
              <SecretField label="Rec. 2FA" value={account.recovery_email_twofa} />
              <SecretField label="Backups" value={account.backup_codes} />
            </div>
          </div>

          {/* Stats */}
          {(account.account_worth > 0 || account.buy_price > 0 || account.followers) && (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-primary/60 mb-2">Stats</p>
              <div className="grid grid-cols-2 gap-2">
                {account.account_worth > 0 && (
                  <div className="bg-muted/10 border border-border/30 rounded-lg px-3 py-2">
                    <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Worth</div>
                    <div className="font-mono font-bold text-emerald-400 text-sm">${account.account_worth.toFixed(2)}</div>
                  </div>
                )}
                {account.buy_price > 0 && (
                  <div className="bg-muted/10 border border-border/30 rounded-lg px-3 py-2">
                    <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Buy Price</div>
                    <div className="font-mono font-bold text-foreground text-sm">${account.buy_price.toFixed(2)}</div>
                  </div>
                )}
                {roi !== null && (
                  <div className="bg-muted/10 border border-border/30 rounded-lg px-3 py-2">
                    <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">ROI</div>
                    <div className={cn("font-mono font-bold text-sm", roi >= 0 ? "text-green-400" : "text-red-400")}>
                      {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                    </div>
                  </div>
                )}
                {account.followers && (
                  <div className="bg-muted/10 border border-border/30 rounded-lg px-3 py-2">
                    <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">Followers</div>
                    <div className="font-mono font-bold text-foreground text-sm">{account.followers}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Dates */}
          {(account.account_create_date || account.account_buy_date || account.account_last_login_date) && (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-primary/60 mb-2">Dates</p>
              <div className="space-y-1.5">
                {account.account_create_date && (
                  <div className="flex items-center gap-2 text-muted-foreground/60">
                    <Calendar className="w-3 h-3 flex-shrink-0" />
                    <span className="font-mono text-[10px]">Created: {new Date(account.account_create_date).toLocaleDateString()}</span>
                  </div>
                )}
                {account.account_buy_date && (
                  <div className="flex items-center gap-2 text-muted-foreground/60">
                    <Star className="w-3 h-3 flex-shrink-0" />
                    <span className="font-mono text-[10px]">Bought: {new Date(account.account_buy_date).toLocaleDateString()}</span>
                  </div>
                )}
                {account.account_last_login_date && (
                  <div className="flex items-center gap-2 text-muted-foreground/60">
                    <UserCheck className="w-3 h-3 flex-shrink-0" />
                    <span className="font-mono text-[10px]">Last Login: {new Date(account.account_last_login_date).toLocaleDateString()}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Notes */}
          {account.notes && (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-primary/60 mb-2">Notes</p>
              <p className="font-mono text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded-lg px-3 py-2 border border-border/30">
                {account.notes}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="font-mono text-xs">Close</Button>
          <Button variant="ghost" onClick={() => { onClose(); navigate(`/vault/local/${account.id}`); }} className="font-mono text-xs gap-2">
            <Eye className="w-3.5 h-3.5" /> Full Details
          </Button>
          <Button onClick={() => { onEdit(account); onClose(); }} className="font-mono text-xs gap-2">
            <Edit3 className="w-3.5 h-3.5" /> Edit Account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Account Card ─────────────────────────────────────────────────────────────
function AccountCard({
  account, onEdit, onDelete, onView, onShare, onBan, selected, onToggleSelect,
}: {
  account: LocalAccount;
  onEdit: (a: LocalAccount) => void;
  onDelete: (id: number) => void;
  onView: (a: LocalAccount) => void;
  onShare: (a: LocalAccount) => void;
  onBan: (a: LocalAccount) => void;
  selected: boolean;
  onToggleSelect: (id: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isBanned = account.status === "banned";
  const roi = calcROI(account.account_worth, account.buy_price);
  const age = calcAge(account.account_create_date);
  const grad = getLocalAccountPlatformGradient(account.category);

  return (
    <div
      className={cn(
        "bg-card border rounded-xl group transition-all duration-300 cursor-pointer hover:border-primary/40 relative",
        `bg-gradient-to-br ${grad}`,
        isBanned ? "border-red-400/40" : selected && "border-primary/50"
      )}
      onClick={() => { setMenuOpen(false); onView(account); }}
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border/30 rounded-t-xl flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div onClick={e => e.stopPropagation()} className="flex-shrink-0">
            <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(account.id)} />
          </div>
          <Shield className="w-3 h-3 text-primary/40 flex-shrink-0" />
          <span className="font-mono font-bold text-sm text-foreground truncate">
            {account.label || account.username || account.email || `Account #${account.id}`}
          </span>
          {account.username && account.label && (
            <span className="text-[10px] font-mono text-muted-foreground/50 truncate">@{account.username}</span>
          )}
          {isBanned && (
            <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-red-400/10 text-red-400 border border-red-400/20 flex items-center gap-1 flex-shrink-0">
              <Ban className="w-2.5 h-2.5" /> BANNED
            </span>
          )}
          {account.origin === "entity" && (
            <span
              title="Auto-created from an Entity's platform tab"
              className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/20 flex items-center gap-1 flex-shrink-0"
            >
              <Zap className="w-2.5 h-2.5" /> FROM ENTITY
            </span>
          )}
        </div>
        {/* Rank badge */}
        <RankBadge score={account.score} showLabel={false} size={16} />
        {/* 3-dot menu — always visible */}
        <div className="relative flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-all"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-8 bg-card border border-card-border rounded-xl shadow-2xl p-2 z-50 min-w-max">
                <div className="grid grid-cols-4 gap-1">
                  {([
                    { icon: Eye, label: "View", action: () => onView(account), cls: "" },
                    { icon: Edit3, label: "Edit", action: () => onEdit(account), cls: "" },
                    { icon: Share2, label: "Share", action: () => onShare(account), cls: "" },
                    { icon: isBanned ? ShieldOff : Ban, label: isBanned ? "Unban" : "Ban", action: () => onBan(account), cls: isBanned ? "text-emerald-400 hover:bg-emerald-400/10" : "text-amber-400 hover:bg-amber-400/10" },
                    { icon: Trash2, label: "Del", action: () => onDelete(account.id), cls: "text-red-400 hover:bg-red-400/10 hover:border-red-400/30 hover:text-red-400" },
                  ] as const).map(({ icon: Icon, label, action, cls }) => (
                    <button
                      key={label}
                      onClick={() => { action(); setMenuOpen(false); }}
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

      {/* Stats row */}
      <div className="px-4 py-2 flex items-center gap-3 border-b border-border/20 flex-wrap">
        {account.account_worth > 0 && (
          <div className="flex items-center gap-1">
            <DollarSign className="w-3 h-3 text-emerald-400" />
            <span className="text-[11px] font-mono font-bold text-emerald-400">${account.account_worth.toFixed(2)}</span>
          </div>
        )}
        {roi !== null && (
          <div className={cn("flex items-center gap-1", roi >= 0 ? "text-green-400" : "text-red-400")}>
            <BarChart2 className="w-3 h-3" />
            <span className="text-[11px] font-mono font-bold">{roi >= 0 ? "+" : ""}{roi.toFixed(1)}% ROI</span>
          </div>
        )}
        {age !== "—" && (
          <div className="flex items-center gap-1 text-muted-foreground/60">
            <Clock className="w-3 h-3" />
            <span className="text-[10px] font-mono">{age} old</span>
          </div>
        )}
        {account.followers && (
          <div className="flex items-center gap-1 text-muted-foreground/60">
            <Users className="w-3 h-3" />
            <span className="text-[10px] font-mono">{account.followers}</span>
          </div>
        )}
      </div>

      {/* Credentials preview */}
      <div className="px-4 py-2 space-y-0.5">
        <SecretField label="Email" value={account.email} />
        <SecretField label="Password" value={account.password} />
        <SecretField label="Rec. Email" value={account.recovery_email} />
        <SecretField label="Rec. Pass" value={account.recovery_email_password} />
        <SecretField label="2FA" value={account.twofa} />
        <SecretField label="Rec. 2FA" value={account.recovery_email_twofa} />
        <SecretField label="Backups" value={account.backup_codes} />
      </div>

      {/* Dates */}
      {(account.account_create_date || account.account_buy_date || account.account_last_login_date) && (
        <div className="px-4 py-1.5 border-t border-border/20 flex flex-wrap gap-3">
          {account.account_create_date && (
            <div className="flex items-center gap-1 text-muted-foreground/40">
              <Calendar className="w-2.5 h-2.5" />
              <span className="text-[9px] font-mono">Created: {new Date(account.account_create_date).toLocaleDateString()}</span>
            </div>
          )}
          {account.account_buy_date && (
            <div className="flex items-center gap-1 text-muted-foreground/40">
              <Star className="w-2.5 h-2.5" />
              <span className="text-[9px] font-mono">Bought: {new Date(account.account_buy_date).toLocaleDateString()}</span>
            </div>
          )}
          {account.account_last_login_date && (
            <div className="flex items-center gap-1 text-muted-foreground/40">
              <UserCheck className="w-2.5 h-2.5" />
              <span className="text-[9px] font-mono">Login: {new Date(account.account_last_login_date).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      )}

      {account.notes && (
        <div className="px-4 pb-2 pt-1 border-t border-border/20">
          <p className="text-[9px] font-mono text-muted-foreground/40 truncate">{account.notes}</p>
        </div>
      )}
    </div>
  );
}

// ─── Empty form ───────────────────────────────────────────────────────────────
const EMPTY: Omit<LocalAccount, "id" | "user_id" | "created_at" | "updated_at"> = {
  category: "", label: null, username: null,
  email: null, password: null,
  recovery_email: null, recovery_email_password: null,
  backup_codes: null, twofa: null, recovery_email_twofa: null,
  followers: null, account_worth: 0, buy_price: 0,
  account_create_date: null, account_buy_date: null, account_last_login_date: null,
  notes: null, score: 5,
};

function toFormState(a?: LocalAccount) {
  if (!a) return { ...EMPTY };
  return {
    category: a.category || "",
    label: a.label || "",
    username: a.username || "",
    email: a.email || "",
    password: a.password || "",
    recovery_email: a.recovery_email || "",
    recovery_email_password: a.recovery_email_password || "",
    backup_codes: a.backup_codes || "",
    twofa: a.twofa || "",
    recovery_email_twofa: a.recovery_email_twofa || "",
    followers: a.followers || "",
    account_worth: a.account_worth || 0,
    buy_price: a.buy_price || 0,
    account_create_date: a.account_create_date ? a.account_create_date.slice(0, 10) : "",
    account_buy_date: a.account_buy_date ? a.account_buy_date.slice(0, 10) : "",
    account_last_login_date: a.account_last_login_date ? a.account_last_login_date.slice(0, 10) : "",
    notes: a.notes || "",
    score: a.score != null ? a.score : 5,
  };
}

// ─── Account Form Dialog ──────────────────────────────────────────────────────
function AccountFormDialog({
  open, onClose, editAccount, selectedCategory, allCategories, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editAccount?: LocalAccount;
  selectedCategory: string;
  allCategories: Category[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(toFormState(editAccount));
  // Two-step flow for CREATE: pick a platform (as boxes) first, then the
  // per-category form. Editing skips straight to the form (category is
  // already set) but can still jump back via "Change platform".
  const [step, setStep] = useState<"category" | "form">(editAccount ? "form" : "category");
  const [activeSection, setActiveSection] = useState<"creds" | "dates" | "value" | "platform" | "points">("creds");
  const [credSubTab, setCredSubTab] = useState<"main" | "recovery">("main");
  const [pointsData, setPointsData] = useState<{ entries: any[]; total: number }>({ entries: [], total: 0 });
  const [pointsLoading, setPointsLoading] = useState(false);
  const [addingPoint, setAddingPoint] = useState(false);
  const [pointAmount, setPointAmount] = useState("");
  const [pointNotes, setPointNotes] = useState("");

  useEffect(() => {
    if (open) {
      const base = toFormState(editAccount);
      if (!editAccount && selectedCategory) base.category = selectedCategory;
      setForm(base);
      setStep(editAccount ? "form" : "category");
      setActiveSection("creds");
      setPointAmount("");
      setPointNotes("");
    }
  }, [open, editAccount, selectedCategory]);

  const loadPoints = useCallback(async () => {
    if (!editAccount?.id) return;
    setPointsLoading(true);
    try {
      const data = await customFetch<{ entries: any[]; total: number }>(`/api/local-accounts/${editAccount.id}/points`);
      setPointsData(data);
    } catch { setPointsData({ entries: [], total: 0 }); }
    finally { setPointsLoading(false); }
  }, [editAccount?.id]);

  useEffect(() => {
    if (open && activeSection === "points" && editAccount?.id) {
      loadPoints();
    }
  }, [open, activeSection, editAccount?.id, loadPoints]);

  const handleAddPoint = async () => {
    if (!editAccount?.id || !pointAmount || isNaN(Number(pointAmount))) return;
    setAddingPoint(true);
    try {
      await customFetch<unknown>(`/api/local-accounts/${editAccount.id}/points`, {
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

  const SECTIONS: { id: "creds" | "dates" | "value" | "platform" | "points"; label: string }[] = [
    { id: "creds",    label: "Creds" },
    { id: "dates",    label: "Dates" },
    { id: "value",    label: "Value" },
    { id: "platform", label: form.category || "Platform" },
    { id: "points",   label: "Points" },
  ];

  const fv = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  // onChange adapter for <SchemaForm> — same shape as fv() but takes a raw
  // value instead of an input change event.
  const onFieldChange = (key: string, value: any) => setForm(prev => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!form.category) { toast({ variant: "destructive", title: "Select a platform category" }); return; }
    setSaving(true);
    try {
      const payload = {
        category: form.category,
        label: form.label || null,
        username: form.username || null,
        email: form.email || null,
        password: form.password || null,
        recoveryEmail: form.recovery_email || null,
        recoveryEmailPassword: form.recovery_email_password || null,
        backupCodes: form.backup_codes || null,
        twofa: form.twofa || null,
        recoveryEmailTwofa: form.recovery_email_twofa || null,
        followers: form.followers || null,
        accountWorth: Number(form.account_worth) || 0,
        buyPrice: Number(form.buy_price) || 0,
        accountCreateDate: form.account_create_date || null,
        accountBuyDate: form.account_buy_date || null,
        accountLastLoginDate: form.account_last_login_date || null,
        notes: form.notes || null,
        score: Math.max(0, Math.min(10, Math.round(Number(form.score) || 5))),
      };
      if (editAccount) {
        await customFetch<unknown>(`/api/local-accounts/${editAccount.id}`, { method: "PUT", body: JSON.stringify(payload) });
        toast({ title: "Account updated" });
      } else {
        await customFetch<unknown>("/api/local-accounts", { method: "POST", body: JSON.stringify(payload) });
        toast({ title: "Account saved to vault" });
      }
      onSaved();
      onClose();
    } catch {
      toast({ variant: "destructive", title: "Failed to save account" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="bg-card border-card-border max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-primary flex items-center gap-2">
            <Smartphone className="w-4 h-4" />
            {editAccount ? "Edit Account" : step === "category" ? "Choose a Platform" : "Add Local Account"}
          </DialogTitle>
          <p className="text-[11px] font-mono text-muted-foreground">
            {step === "category" ? "Pick which platform this account is for." : "Account farming — store one account per entry."}
          </p>
        </DialogHeader>

        {/* ── Step 1: Platform boxes ─────────────────────────────────────── */}
        {step === "category" ? (
          <div className="space-y-3 py-1">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {allCategories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => { setForm(p => ({ ...p, category: cat.name })); setStep("form"); }}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1.5 rounded-xl border py-4 px-2 font-mono transition-all",
                    form.category === cat.name
                      ? "bg-primary/15 border-primary/50 text-primary"
                      : "border-border/40 text-muted-foreground/70 hover:border-primary/30 hover:bg-primary/5 hover:text-primary/80"
                  )}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${cat.color}22`, border: `1px solid ${cat.color}55` }}
                  >
                    <Tag className="w-3.5 h-3.5" style={{ color: cat.color }} />
                  </div>
                  <span className="text-xs font-bold">{cat.name}</span>
                </button>
              ))}
            </div>
            <p className="text-center font-mono text-[10px] text-muted-foreground/40 pt-1">
              Don't see your platform? Add it from the category picker on the Accounts page.
            </p>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {/* Chosen platform — compact, with a way back to the box picker */}
            <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 bg-muted/10">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: allCategories.find(c => c.name === form.category)?.color ?? "#8b5cf6" }}
                />
                <span className="font-mono text-xs font-bold text-foreground">{form.category || "Platform"}</span>
              </div>
              {!editAccount && (
                <button
                  onClick={() => setStep("category")}
                  className="font-mono text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                >
                  Change platform
                </button>
              )}
            </div>

            {/* Section toggle (5 tabs) */}
            <div className="flex gap-1 p-1 bg-muted/30 rounded-lg">
              {SECTIONS.map(s => (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    "flex-1 py-1 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all",
                    activeSection === s.id
                      ? "bg-card text-primary shadow-sm font-bold"
                      : "text-muted-foreground/50 hover:text-muted-foreground"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

          {/* Tab 1: Credentials — split into Main and Recovery sub-tabs */}
          {activeSection === "creds" && (
            <div className="space-y-2">
              {/* Main / Recovery sub-tabs */}
              <div className="flex gap-1">
                {(["main", "recovery"] as const).map(st => (
                  <button
                    key={st}
                    type="button"
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
                <SchemaForm
                  fields={LOCAL_ACCOUNT_FIELDS.filter(f => f.tab === "creds" && ["username", "password", "email", "email_password"].includes(f.key))}
                  tab="creds" form={form} onChange={onFieldChange}
                />
              )}

              {credSubTab === "recovery" && (
                <SchemaForm
                  fields={LOCAL_ACCOUNT_FIELDS.filter(f => f.tab === "creds" && !["username", "password", "email", "email_password"].includes(f.key))}
                  tab="creds" form={form} onChange={onFieldChange}
                />
              )}
            </div>
          )}

          {/* Tab 2: Dates & Meta — "label" + date fields driven by LOCAL_ACCOUNT_FIELDS (tab: "dates") */}
          {activeSection === "dates" && (
            <div className="space-y-3">
              <SchemaForm
                fields={LOCAL_ACCOUNT_FIELDS.filter(f => f.key === "label")}
                tab="dates" form={form} onChange={onFieldChange}
              />
              <div className="p-3 rounded-lg bg-primary/3 border border-primary/10 space-y-2">
                <div className="flex items-center gap-1.5">
                  <Calendar className="w-3 h-3 text-primary/60" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-primary/70 font-bold">Important Dates</span>
                </div>
                <SchemaForm
                  fields={LOCAL_ACCOUNT_FIELDS.filter(f => f.key !== "label")}
                  tab="dates" form={form} onChange={onFieldChange}
                />
                {form.account_create_date && (
                  <div className="flex items-center gap-1.5 text-muted-foreground/50">
                    <Clock className="w-3 h-3" />
                    <span className="text-[10px] font-mono">Account Age: <strong className="text-foreground/70">{calcAge(form.account_create_date)}</strong></span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 3: Value & ROI — driven by LOCAL_ACCOUNT_FIELDS (tab: "value") */}
          {activeSection === "value" && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-emerald-400/5 border border-emerald-400/10 space-y-2">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="w-3 h-3 text-emerald-400" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-400 font-bold">Account Value & ROI</span>
                </div>
                <SchemaForm fields={LOCAL_ACCOUNT_FIELDS} tab="value" form={form} onChange={onFieldChange} />
                {Number(form.account_worth) > 0 && Number(form.buy_price) > 0 && (
                  <div className={cn(
                    "flex items-center gap-2 p-2 rounded-md text-[11px] font-mono font-bold",
                    calcROI(Number(form.account_worth), Number(form.buy_price))! >= 0
                      ? "bg-green-400/10 text-green-400"
                      : "bg-red-400/10 text-red-400"
                  )}>
                    <BarChart2 className="w-3.5 h-3.5" />
                    ROI: {calcROI(Number(form.account_worth), Number(form.buy_price))! >= 0 ? "+" : ""}
                    {calcROI(Number(form.account_worth), Number(form.buy_price))!.toFixed(2)}%
                    &nbsp;(${(Number(form.account_worth) - Number(form.buy_price)).toFixed(2)} profit)
                  </div>
                )}
              </div>

              {/* Rank / Score */}
              <div className="p-3 rounded-lg bg-violet-400/5 border border-violet-400/10 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Star className="w-3 h-3 text-violet-400" />
                    <span className="font-mono text-[10px] uppercase tracking-wider text-violet-400 font-bold">Rank Score</span>
                  </div>
                  <RankBadge score={Number(form.score)} />
                </div>
                <Input
                  type="number" min={0} max={10} step={1}
                  value={form.score ?? 5}
                  onChange={e => setForm(p => ({ ...p, score: e.target.value === "" ? 5 : Number(e.target.value) }))}
                  className="font-mono text-xs h-8 bg-input"
                />
                <p className="text-[9px] font-mono text-muted-foreground/50">0-1 Warrior, 2-3 Elite, 4-5 Master, 6-7 Grandmaster, 8-10 Mythic.</p>
              </div>
            </div>
          )}

          {/* Tab 5: Points */}
          {activeSection === "points" && (
            <div className="space-y-3">
              {!editAccount ? (
                <div className="py-10 text-center text-muted-foreground/50 font-mono text-xs border border-dashed border-border/30 rounded-xl">
                  Save the account first to track points
                </div>
              ) : (
                <>
                  {/* Balance card */}
                  <div className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-violet-500/5 border border-primary/20 flex items-center justify-between">
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-widest text-primary/60 mb-1">Points Balance</div>
                      <div className="font-mono text-2xl font-bold text-primary">{pointsData.total.toLocaleString()}</div>
                      <div className="font-mono text-[9px] text-muted-foreground/40 mt-0.5">{pointsData.entries.length} entries</div>
                    </div>
                    <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <Zap className="w-5 h-5 text-primary" />
                    </div>
                  </div>

                  {/* Add points form */}
                  <div className="p-3 rounded-xl border border-border/40 bg-muted/10 space-y-2">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Add Points</div>
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
                      placeholder="Note (optional — e.g. Google Play reward)"
                    />
                  </div>

                  {/* History */}
                  <div className="space-y-1">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">History</div>
                    {pointsLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="w-4 h-4 text-primary/40 animate-spin" />
                      </div>
                    ) : pointsData.entries.length === 0 ? (
                      <div className="py-6 text-center text-muted-foreground/40 font-mono text-[10px] border border-dashed border-border/20 rounded-lg">
                        No points recorded yet
                      </div>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                        {pointsData.entries.map((entry: any) => (
                          <div key={entry.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-card border border-border/30 group hover:border-primary/20 transition-all">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono font-bold text-sm text-primary">+{Number(entry.amount).toLocaleString()}</span>
                              {entry.notes && <span className="font-mono text-[10px] text-muted-foreground/50 truncate">{entry.notes}</span>}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="font-mono text-[9px] text-muted-foreground/40">
                                {new Date(entry.created_at).toLocaleDateString()}
                              </span>
                              <button
                                onClick={() => handleDeletePoint(entry.id)}
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
                </>
              )}
            </div>
          )}

          {/* Tab 4: Platform-specific */}
          {activeSection === "platform" && (() => {
            const meta = getLocalAccountPlatformMeta(form.category);
            const MetaIcon = meta.icon;
            return (
              <div className="space-y-3">
                {/* Platform header */}
                <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border/30 bg-muted/20">
                  <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: meta.color + "22", border: `1px solid ${meta.color}44` }}>
                    <MetaIcon className="w-3.5 h-3.5" style={{ color: meta.color }} />
                  </div>
                  <div>
                    <div className="font-mono text-xs font-bold text-foreground">{form.category || "Platform"}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50">Platform-specific stats & notes</div>
                  </div>
                </div>

                {/* Primary metric */}
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
                    <MetaIcon className="w-3 h-3" style={{ color: meta.color }} />
                    {meta.metricLabel}
                  </Label>
                  <Input
                    value={(form as any).followers ?? ""}
                    onChange={fv("followers")}
                    className="font-mono text-xs h-8 bg-input"
                    placeholder={meta.metricPlaceholder}
                  />
                </div>

                {/* Tips */}
                {meta.tips.length > 0 && (
                  <div className="p-3 rounded-lg border border-primary/10 bg-primary/3 space-y-1.5">
                    <div className="font-mono text-[9px] uppercase tracking-wider text-primary/60 font-bold flex items-center gap-1">
                      <Star className="w-2.5 h-2.5" /> Farming Tips
                    </div>
                    {meta.tips.map((tip, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <span className="font-mono text-[9px] text-primary/40 mt-0.5">→</span>
                        <span className="font-mono text-[10px] text-muted-foreground/70">{tip}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Notes */}
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-wider">Notes</Label>
                  <Textarea
                    value={(form as any).notes ?? ""}
                    onChange={fv("notes")}
                    className="font-mono text-xs bg-input min-h-[70px] resize-none"
                    placeholder={`Notes about this ${form.category || "account"}...`}
                  />
                </div>
              </div>
            );
          })()}
        </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="font-mono text-xs">Cancel</Button>
          {step === "form" && (
            <Button onClick={handleSave} disabled={saving} className="font-mono text-xs uppercase tracking-wider gap-2">
              {saving ? <><span className="animate-pulse">Saving...</span></> : <><Shield className="w-3.5 h-3.5" /> {editAccount ? "Update" : "Save Account"}</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Category Dialog ──────────────────────────────────────────────────────
function AddCategoryDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await customFetch<unknown>("/api/local-accounts/categories", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      toast({ title: `"${name.trim()}" category added` });
      setName("");
      onAdded();
      onClose();
    } catch {
      toast({ variant: "destructive", title: "Failed to add category" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="bg-card border-card-border max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-primary flex items-center gap-2">
            <Tag className="w-4 h-4" /> New Category
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Platform Name</Label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAdd()}
            className="font-mono text-xs h-9 bg-input"
            placeholder="e.g. TikTok, Reddit, LinkedIn..."
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="font-mono text-xs">Cancel</Button>
          <Button onClick={handleAdd} disabled={saving || !name.trim()} className="font-mono text-xs gap-2">
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main LocalAccounts Component ─────────────────────────────────────────────
export default function LocalAccounts() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [categories, setCategories] = useState<Category[]>(LOCAL_ACCOUNT_DEFAULT_CATEGORIES);
  const [selectedCat, setSelectedCat] = useState<string>(LOCAL_ACCOUNT_DEFAULT_CATEGORIES[0].name);
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [allAccounts, setAllAccounts] = useState<LocalAccount[]>([]);
  const [loadingAccts, setLoadingAccts] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<LocalAccount | undefined>();
  const [viewAccount, setViewAccount] = useState<LocalAccount | null>(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);

  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [shareItems, setShareItems] = useState<ShareTarget[] | null>(null);
  const [shareLabel, setShareLabel] = useState<string | undefined>(undefined);
  const [managingShares, setManagingShares] = useState(false);

  const toggleSelected = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const shareOne = (a: LocalAccount) => { setShareItems([{ entityType: "local", entityId: a.id }]); setShareLabel(a.label || a.username || a.email || `Account #${a.id}`); };
  const shareSelected = () => { setShareItems(Array.from(selectedIds).map(id => ({ entityType: "local" as const, entityId: id }))); setShareLabel(undefined); };

  // Load categories from API (default + custom)
  const loadCategories = useCallback(async () => {
    try {
      const data = await customFetch<{ defaults: any[]; custom: any[] }>("/api/local-accounts/categories");
      const custom: Category[] = (data.custom || []).map((c: any) => ({
        id: c.id, name: c.name, color: "#8b5cf6", icon: c.name[0], isCustom: true,
      }));
      setCategories([...LOCAL_ACCOUNT_DEFAULT_CATEGORIES, ...custom]);
    } catch { /* keep defaults */ }
  }, []);

  // Load all accounts
  const loadAccounts = useCallback(async () => {
    setLoadingAccts(true);
    try {
      const data = await customFetch<LocalAccount[]>("/api/local-accounts");
      setAllAccounts(Array.isArray(data) ? data : []);
    } catch { setAllAccounts([]); } finally { setLoadingAccts(false); }
  }, []);

  useEffect(() => {
    loadCategories();
    loadAccounts();
  }, [loadCategories, loadAccounts]);

  // Filter by selected category
  useEffect(() => {
    setAccounts(allAccounts.filter(a => a.category === selectedCat));
  }, [selectedCat, allAccounts]);

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await customFetch<unknown>(`/api/local-accounts/${deleteId}`, { method: "DELETE" });
      toast({ title: "Account deleted" });
      await loadAccounts();
    } catch { toast({ variant: "destructive", title: "Delete failed" }); }
    finally { setDeleting(false); setDeleteId(null); }
  };

  const handleBan = async (account: LocalAccount) => {
    const nextStatus = account.status === "banned" ? "active" : "banned";
    try {
      await customFetch<unknown>(`/api/local-accounts/${account.id}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
      toast({ title: nextStatus === "banned" ? "Account banned" : "Account unbanned", description: nextStatus === "banned" ? "It now shows under Vault → Banned." : undefined });
      await loadAccounts();
    } catch { toast({ variant: "destructive", title: "Failed to update ban status" }); }
  };

  const handleDeleteCategory = async (cat: Category) => {
    if (!cat.isCustom) return;
    try {
      await customFetch<unknown>(`/api/local-accounts/categories/${cat.id}`, { method: "DELETE" });
      toast({ title: `"${cat.name}" removed` });
      loadCategories();
      if (selectedCat === cat.name) setSelectedCat(LOCAL_ACCOUNT_DEFAULT_CATEGORIES[0].name);
    } catch { toast({ variant: "destructive", title: "Failed to delete category" }); }
  };

  // Stats for each category
  const catStats = (name: string) => {
    const items = allAccounts.filter(a => a.category === name);
    const totalWorth = items.reduce((s, a) => s + (a.account_worth || 0), 0);
    return { count: items.length, totalWorth };
  };

  const [view, setView] = useState<"accounts" | "dashboard">("accounts");
  const [catDropOpen, setCatDropOpen] = useState(false);
  const [selectedDashCat, setSelectedDashCat] = useState<string | null>(null);
  const totalWorth = allAccounts.reduce((s, a) => s + (a.account_worth || 0), 0);
  const totalBuyPrice = allAccounts.reduce((s, a) => s + (a.buy_price || 0), 0);
  const overallRoi = totalBuyPrice > 0 ? ((totalWorth - totalBuyPrice) / totalBuyPrice) * 100 : null;

  return (
    <div className="space-y-4">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1 p-1 bg-muted/20 rounded-lg border border-border/30">
          {([
            { id: "accounts", label: "Accounts" },
            { id: "dashboard", label: "Dashboard" },
          ] as const).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={cn(
                "px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all",
                view === id
                  ? "bg-card text-primary font-bold shadow-sm border border-border/40"
                  : "text-muted-foreground/50 hover:text-muted-foreground"
              )}
            >{label}</button>
          ))}
        </div>
        {view === "accounts" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="font-mono text-[10px] uppercase tracking-wider gap-1.5 h-8"
              onClick={() => setManagingShares(true)}
            >
              <Users className="w-3.5 h-3.5" /> Shares
            </Button>
            <Button
              size="sm"
              className="font-mono text-[10px] uppercase tracking-wider gap-1.5 h-8"
              onClick={() => { setEditAccount(undefined); setFormOpen(true); }}
            >
              <Plus className="w-3.5 h-3.5" /> Add Account
            </Button>
          </div>
        )}
      </div>

      {view === "accounts" && selectedIds.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="font-mono text-xs text-primary">{selectedIds.size} selected</span>
          <Button size="sm" variant="outline" onClick={shareSelected} className="font-mono text-xs gap-1.5 ml-auto">
            <Share2 className="w-3.5 h-3.5" /> Share Selected
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} className="font-mono text-xs">Clear</Button>
        </div>
      )}

      {/* ── Dashboard view ────────────────────────────────────────────────── */}
      {view === "dashboard" && (
        <div className="space-y-4">
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total Accounts", value: allAccounts.length.toString(), sub: "across all platforms", color: "text-foreground" },
              { label: "Portfolio Worth", value: `$${totalWorth.toFixed(2)}`, sub: "current total value", color: "text-emerald-400" },
              { label: "Total Invested", value: `$${totalBuyPrice.toFixed(2)}`, sub: "buy price sum", color: "text-muted-foreground" },
              { label: "Overall ROI", value: overallRoi !== null ? `${overallRoi >= 0 ? "+" : ""}${overallRoi.toFixed(1)}%` : "—", sub: "profit/loss", color: overallRoi !== null ? (overallRoi >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground" },
            ].map(stat => (
              <div key={stat.label} className="bg-card border border-card-border rounded-xl p-4">
                <div className={cn("font-mono font-bold text-xl", stat.color)}>{stat.value}</div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60 mt-1">{stat.label}</div>
                <div className="font-mono text-[9px] text-muted-foreground/40 mt-0.5">{stat.sub}</div>
              </div>
            ))}
          </div>

          {/* Per-platform breakdown */}
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
              Platform Breakdown — <span className="text-primary/60">click a category for details</span>
            </div>
            <div className="divide-y divide-border/30">
              {categories
                .map(cat => ({ cat, stats: catStats(cat.name) }))
                .filter(({ stats }) => stats.count > 0)
                .sort((a, b) => b.stats.totalWorth - a.stats.totalWorth)
                .map(({ cat, stats }) => {
                  const catBuyPrice = allAccounts.filter(a => a.category === cat.name).reduce((s, a) => s + (a.buy_price || 0), 0);
                  const roi = catBuyPrice > 0 ? ((stats.totalWorth - catBuyPrice) / catBuyPrice) * 100 : null;
                  const isSelected = selectedDashCat === cat.name;
                  return (
                    <div key={cat.id}>
                      <button
                        onClick={() => setSelectedDashCat(isSelected ? null : cat.name)}
                        className={cn(
                          "w-full flex items-center justify-between px-4 py-3 transition-colors text-left",
                          isSelected ? "bg-primary/10 border-l-2 border-primary" : "hover:bg-muted/10"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
                          <div>
                            <div className="font-mono text-xs font-bold text-foreground">{cat.name}</div>
                            <div className="font-mono text-[9px] text-muted-foreground/50">{stats.count} account{stats.count !== 1 ? "s" : ""}</div>
                          </div>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                            <div className="font-mono text-sm font-bold text-emerald-400">${stats.totalWorth.toFixed(2)}</div>
                            {roi !== null && !isNaN(roi) && isFinite(roi) && (
                              <div className={cn("font-mono text-[10px]", roi >= 0 ? "text-green-400" : "text-red-400")}>
                                {roi >= 0 ? "+" : ""}{roi.toFixed(1)}% ROI
                              </div>
                            )}
                          </div>
                          <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground/40 transition-transform", isSelected && "rotate-180")} />
                        </div>
                      </button>
                      {/* Category detail panel */}
                      {isSelected && (
                        <div className="bg-muted/10 border-t border-border/20 px-4 py-3 space-y-2">
                          <div className="font-mono text-[9px] uppercase tracking-widest text-primary/50 mb-2">
                            {cat.name} · {stats.count} account{stats.count !== 1 ? "s" : ""}
                          </div>
                          <div className="space-y-1.5">
                            {allAccounts.filter(a => a.category === cat.name).map(acc => {
                              const accRoi = calcROI(acc.account_worth, acc.buy_price);
                              return (
                                <div
                                  key={acc.id}
                                  className="flex items-center justify-between bg-card border border-border/30 rounded-lg px-3 py-2 cursor-pointer hover:border-primary/40 transition-all group"
                                  onClick={() => { setViewAccount(acc); setViewDialogOpen(true); }}
                                >
                                  <div className="min-w-0">
                                    <div className="font-mono text-xs font-bold text-foreground truncate">
                                      {acc.label || acc.username || acc.email || `Account #${acc.id}`}
                                    </div>
                                    {acc.email && <div className="font-mono text-[9px] text-muted-foreground/50 truncate">{acc.email}</div>}
                                  </div>
                                  <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                                    {acc.account_worth > 0 && (
                                      <span className="font-mono text-xs text-emerald-400">${acc.account_worth.toFixed(2)}</span>
                                    )}
                                    {accRoi !== null && (
                                      <span className={cn("font-mono text-[10px]", accRoi >= 0 ? "text-green-400" : "text-red-400")}>
                                        {accRoi >= 0 ? "+" : ""}{accRoi.toFixed(1)}%
                                      </span>
                                    )}
                                    <Eye className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              {allAccounts.length === 0 && (
                <div className="px-4 py-8 text-center text-muted-foreground font-mono text-xs">No accounts yet.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Accounts view ─────────────────────────────────────────────────── */}
      {view === "accounts" && (
        <div className="space-y-4">
          {/* ── Compact category selector ──────────────────────────────────── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Category button */}
            <div className="relative">
              <button
                onClick={() => setCatDropOpen(o => !o)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/40 bg-card font-mono text-xs hover:border-primary/40 transition-all"
              >
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: categories.find(c => c.name === selectedCat)?.color ?? "#8b5cf6", boxShadow: `0 0 6px ${categories.find(c => c.name === selectedCat)?.color ?? "#8b5cf6"}80` }}
                />
                <span className="font-bold text-foreground">{selectedCat}</span>
                <span className="text-muted-foreground/50">({catStats(selectedCat).count})</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground/50" />
              </button>
              {catDropOpen && (
                <div className="absolute top-full mt-1 left-0 z-50 bg-card border border-card-border rounded-xl shadow-2xl overflow-hidden min-w-[160px]">
                  <div className="p-1 space-y-0.5">
                    {categories.map(cat => {
                      const stats = catStats(cat.name);
                      const isActive = selectedCat === cat.name;
                      return (
                        <button
                          key={cat.id}
                          onClick={() => { setSelectedCat(cat.name); setCatDropOpen(false); }}
                          className={cn(
                            "w-full flex items-center justify-between px-3 py-2 rounded-lg font-mono text-xs transition-all text-left",
                            isActive ? "bg-primary/15 text-primary font-bold" : "text-muted-foreground/70 hover:bg-muted/30 hover:text-foreground"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
                            <span>{cat.name}</span>
                          </div>
                          {stats.count > 0 && (
                            <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full", isActive ? "bg-primary/20 text-primary" : "bg-muted/50 text-muted-foreground/50")}>
                              {stats.count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="border-t border-border/30 p-1">
                    <button
                      onClick={() => { setCatDialogOpen(true); setCatDropOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg font-mono text-[10px] text-muted-foreground/50 hover:text-primary hover:bg-primary/10 transition-colors text-left"
                    >
                      <Plus className="w-3 h-3" /> Add Platform
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Portfolio mini-stat */}
            {allAccounts.length > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground/50">
                ${catStats(selectedCat).totalWorth.toFixed(2)} total
              </span>
            )}

            {catDropOpen && <div className="fixed inset-0 z-40" onClick={() => setCatDropOpen(false)} />}
          </div>

          {/* ── Accounts content ────────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Accounts grid */}
            {loadingAccts ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[1, 2].map(i => (
                  <div key={i} className="h-44 bg-card border border-card-border rounded-xl animate-pulse" />
                ))}
              </div>
            ) : accounts.length === 0 ? (
              <div className="py-16 flex flex-col items-center gap-4 border border-dashed border-primary/15 rounded-xl bg-primary/2">
                <div className="w-12 h-12 rounded-full border border-primary/20 flex items-center justify-center bg-primary/5">
                  <Smartphone className="w-5 h-5 text-primary/30" />
                </div>
                <div className="text-center">
                  <div className="font-mono font-bold text-foreground/60 text-sm mb-1">No {selectedCat} accounts</div>
                  <div className="text-[10px] font-mono text-muted-foreground/40">Add your first {selectedCat} account</div>
                </div>
                <Button size="sm" className="font-mono text-[10px] gap-1.5" onClick={() => { setEditAccount(undefined); setFormOpen(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Add Account
                </Button>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {accounts.map(acc => (
                  <AccountCard
                    key={acc.id}
                    account={acc}
                    onView={a => navigate(`/vault/local/${a.id}`)}
                    onEdit={a => { setEditAccount(a); setFormOpen(true); }}
                    onDelete={id => setDeleteId(id)}
                    onShare={shareOne}
                    onBan={handleBan}
                    selected={selectedIds.has(acc.id)}
                    onToggleSelect={toggleSelected}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      <ShareEntityDialog
        open={shareItems !== null}
        onClose={() => setShareItems(null)}
        items={shareItems ?? []}
        entityLabel={shareLabel}
        onShared={clearSelection}
      />
      <ManageSharesDialog open={managingShares} onClose={() => setManagingShares(false)} entityType="local" />
      <AccountViewDialog
        account={viewAccount}
        open={viewDialogOpen}
        onClose={() => { setViewDialogOpen(false); setViewAccount(null); }}
        onEdit={a => { setViewDialogOpen(false); setViewAccount(null); setEditAccount(a); setFormOpen(true); }}
      />

      <AccountFormDialog
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditAccount(undefined); }}
        editAccount={editAccount}
        selectedCategory={selectedCat}
        allCategories={categories}
        onSaved={loadAccounts}
      />

      <AddCategoryDialog
        open={catDialogOpen}
        onClose={() => setCatDialogOpen(false)}
        onAdded={loadCategories}
      />

      <Dialog open={deleteId !== null} onOpenChange={o => !o && setDeleteId(null)}>
        <DialogContent className="bg-card border-card-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-red-400 flex items-center gap-2">
              <Trash2 className="w-4 h-4" /> Delete Account?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-mono text-muted-foreground">This will permanently remove this account and all its credentials.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting} className="font-mono text-xs">
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
