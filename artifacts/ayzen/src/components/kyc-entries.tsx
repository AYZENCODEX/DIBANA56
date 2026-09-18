import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Plus, Trash2, Edit2, ShieldCheck, Building2, Loader2,
  Search, User, Mail as MailIcon, KeyRound, X, CheckCircle2, XCircle,
  Share2, Users, Ban, ShieldOff, MoreVertical,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { customFetch } from "@workspace/api-client-react";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { KYC_FIELDS, ACCOUNT_KYC_SUBTABS } from "@/config/fields/kyc-create";
import { KYC_CATEGORIES, getKycCategoryMeta } from "@/config/vault-kyc";
import { ShareEntityDialog, type ShareTarget } from "@/components/vault/share-entity-dialog";
import { ManageSharesDialog } from "@/components/vault/manage-shares-dialog";
import { ImapSmtpForm, type EmailAccount } from "@/components/mail/imap-smtp-form";
import { DataEntityPicker } from "@/components/vault/data-entity-picker";

const MAIL_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

// ─── Types ──────────────────────────────────────────────────────────────────
export interface KycEntry {
  id: number;
  category: string;
  username: string | null;
  account_password: string | null;
  notes: string | null;
  email: string | null;
  email_password: string | null;
  email_2fa: string | null;
  email_backup_code: string | null;
  account_2fa: string | null;
  account_backup_code: string | null;
  last_login_at: string | null;
  account_buy_date: string | null;
  account_create_date: string | null;
  account_buy_price: number | null;
  account_worth: number | null;
  followers: string | null;
  email_recovery: string | null;
  email_recovery_password: string | null;
  recovery_2fa: string | null;
  recovery_backup_code: string | null;
  nid_number: string | null;
  name: string | null;
  father_name: string | null;
  birth_date: string | null;
  photo1_url: string | null;
  photo2_url: string | null;
  data_entity_id: number | null;
  platform: string | null;
  buy_price: number | null;
  location: string | null;
  connection: string | null;
  contact_number: string | null;
  buy_date: string | null;
  paid: boolean;
  seller_name: string | null;
  social_account: string | null;
  status?: string | null;
  created_at: string;
}

const EMPTY_FORM: Record<string, any> = {
  category: "",
  // Account · Main
  username: "", accountPassword: "", notes: "",
  email: "", emailPassword: "", account2fa: "", accountBackupCode: "",
  email2fa: "", emailBackupCode: "",
  // Account · Info
  lastLoginAt: "", accountBuyDate: "", accountCreateDate: "",
  accountBuyPrice: "", accountWorth: "", kycFollowers: "",
  // Account · Recovery
  emailRecovery: "", emailRecoveryPassword: "", recovery2fa: "", recoveryBackupCode: "",
  // KYC · Info — identity fields now live on a linked Data Entity
  dataEntityId: null as number | null,
  // KYC · Seller
  platform: "", buyPrice: "", location: "", connection: "",
  contactNumber: "", buyDate: "", paid: false, sellerName: "", socialAccount: "",
};

// Maps API's snake_case row -> the dialog form's camelCase keys
function rowToForm(e: KycEntry): Record<string, any> {
  return {
    category: e.category ?? "",
    // Account · Main
    username: e.username ?? "", accountPassword: e.account_password ?? "", notes: e.notes ?? "",
    email: e.email ?? "", emailPassword: e.email_password ?? "",
    account2fa: e.account_2fa ?? "", accountBackupCode: e.account_backup_code ?? "",
    email2fa: e.email_2fa ?? "", emailBackupCode: e.email_backup_code ?? "",
    // Account · Info
    lastLoginAt: e.last_login_at ? String(e.last_login_at).slice(0, 10) : "",
    accountBuyDate: e.account_buy_date ? String(e.account_buy_date).slice(0, 10) : "",
    accountCreateDate: e.account_create_date ? String(e.account_create_date).slice(0, 10) : "",
    accountBuyPrice: e.account_buy_price ?? "",
    accountWorth: e.account_worth ?? "",
    kycFollowers: e.followers ?? "",
    // Account · Recovery
    emailRecovery: e.email_recovery ?? "",
    emailRecoveryPassword: e.email_recovery_password ?? "",
    recovery2fa: e.recovery_2fa ?? "",
    recoveryBackupCode: e.recovery_backup_code ?? "",
    // KYC · Info — identity fields now live on a linked Data Entity
    dataEntityId: (e as any).data_entity_id ?? null,
    // KYC · Seller
    platform: e.platform ?? "", buyPrice: e.buy_price ?? "", location: e.location ?? "",
    connection: e.connection ?? "", contactNumber: e.contact_number ?? "",
    buyDate: e.buy_date ? String(e.buy_date).slice(0, 10) : "",
    paid: !!e.paid, sellerName: e.seller_name ?? "", socialAccount: e.social_account ?? "",
  };
}

const FORM_TABS = [
  { id: "account", label: "Account", icon: User },
  { id: "email", label: "Email", icon: MailIcon },
  { id: "kyc", label: "KYC", icon: ShieldCheck },
] as const;
type FormTab = typeof FORM_TABS[number]["id"];
type AccountSubTab = typeof ACCOUNT_KYC_SUBTABS[number]["id"];

const KYC_SUBTABS = [
  { id: "info", label: "Info" },
  { id: "seller", label: "Seller" },
] as const;
type KycSubTab = typeof KYC_SUBTABS[number]["id"];

// Fields SchemaForm should render for the KYC · Seller sub-tab — "paid" is
// excluded here since it renders as its own Yes/No pill pair below.
const SELLER_SCHEMA_FIELDS = KYC_FIELDS.filter(f => f.tab === "kyc" && f.subtab === "seller" && f.key !== "paid");

export function KycDialog({ open, editEntry, onClose, onSaved }: {
  open: boolean; editEntry: KycEntry | null; onClose: () => void; onSaved: () => void;
}) {
  // Re-export as named export so other pages can import it directly.
  return <KycDialogInner open={open} editEntry={editEntry} onClose={onClose} onSaved={onSaved} />;
}

function CategoryBadge({ category }: { category: string }) {
  const meta = getKycCategoryMeta(category);
  return (
    <Badge
      variant="outline"
      className="font-mono text-[9px] uppercase tracking-wider px-1.5"
      style={{ color: meta.color, borderColor: `${meta.color}40`, backgroundColor: `${meta.color}10` }}
    >
      {category}
    </Badge>
  );
}

// ─── Create / Edit dialog ───────────────────────────────────────────────────
function KycDialogInner({ open, editEntry, onClose, onSaved }: {
  open: boolean; editEntry: KycEntry | null; onClose: () => void; onSaved: () => void;
}) {
  const [step, setStep] = useState<"category" | "form">("category");
  const [form, setForm] = useState<Record<string, any>>(EMPTY_FORM);
  const [formTab, setFormTab] = useState<FormTab>("account");
  const [acctSubTab, setAcctSubTab] = useState<AccountSubTab>("main");
  const [formSubTab, setFormSubTab] = useState<KycSubTab>("info");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const { token } = useAuth() as any;

  // Email Settings — configure IMAP/SMTP for this entry's email directly from
  // the Email tab, same /api/email-accounts data source as the Mail Hub
  // Overview and Settings page use, so it shows up everywhere immediately.
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
    if (!open) return;
    if (editEntry) {
      setForm(rowToForm(editEntry));
      setStep("form");
    } else {
      setForm(EMPTY_FORM);
      setStep("category");
    }
    setFormTab("account");
    setAcctSubTab("main");
    setFormSubTab("info");
  }, [open, editEntry]);

  const setField = (key: string, value: any) => setForm(p => ({ ...p, [key]: value }));

  useEffect(() => {
    if (formTab === "email" && emailAccounts.length === 0 && !emailAccountsLoading) fetchEmailAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formTab]);

  const save = async () => {
    if (!form.category) { toast({ variant: "destructive", title: "Pick a category first" }); return; }
    setSaving(true);
    try {
      if (editEntry) {
        await customFetch<unknown>(`/api/kyc-entries/${editEntry.id}`, { method: "PUT", body: JSON.stringify(form) });
        toast({ title: "KYC entity updated" });
      } else {
        await customFetch<unknown>("/api/kyc-entries", { method: "POST", body: JSON.stringify(form) });
        toast({ title: "KYC entity created" });
      }
      onSaved();
      onClose();
    } catch {
      toast({ variant: "destructive", title: "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-5 pt-5 pb-3 flex-shrink-0 border-b border-card-border">
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            {editEntry ? "Edit KYC Entity" : step === "category" ? "Choose a Platform" : "Add KYC Entity"}
          </DialogTitle>
        </DialogHeader>

        {step === "category" ? (
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {KYC_CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => { setField("category", cat.name); setStep("form"); }}
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
                    <Building2 className="w-3.5 h-3.5" style={{ color: cat.color }} />
                  </div>
                  <span className="text-xs font-bold">{cat.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Top-level tabs */}
            <div className="px-5 pt-3 flex gap-1 flex-shrink-0 overflow-x-auto border-b border-border/20 pb-2">
              {FORM_TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setFormTab(t.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider flex-shrink-0 transition-all flex items-center gap-1.5",
                    formTab === t.id ? "bg-primary/10 text-primary font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
                  )}
                >
                  <t.icon className="w-3 h-3" /> {t.label}
                </button>
              ))}
            </div>

            {/* Account sub-tabs (Main / Info / Recovery) */}
            {formTab === "account" && (
              <div className="px-5 pt-2 flex gap-1 flex-shrink-0 overflow-x-auto">
                {ACCOUNT_KYC_SUBTABS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setAcctSubTab(t.id)}
                    className={cn(
                      "px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider flex-shrink-0 transition-all border",
                      acctSubTab === t.id ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {/* KYC sub-tabs */}
            {formTab === "kyc" && (
              <div className="px-5 pt-2 flex gap-1 flex-shrink-0 overflow-x-auto">
                {KYC_SUBTABS.map(t => (
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

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Chosen platform, with a way back to the box picker (add-only) */}
              <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 bg-muted/10">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: getKycCategoryMeta(form.category).color }} />
                  <span className="font-mono text-xs font-bold text-foreground">{form.category || "Platform"}</span>
                </div>
                {!editEntry && (
                  <button onClick={() => setStep("category")} className="font-mono text-[9px] text-muted-foreground/50 hover:text-primary transition-colors">
                    Change
                  </button>
                )}
              </div>

              {/* Account · Main */}
              {formTab === "account" && acctSubTab === "main" && (
                <SchemaForm
                  fields={KYC_FIELDS.filter(f => f.tab === "account" && f.subtab === "main")}
                  form={form}
                  onChange={setField}
                />
              )}

              {/* Account · Info */}
              {formTab === "account" && acctSubTab === "info" && (
                <SchemaForm
                  fields={KYC_FIELDS.filter(f => f.tab === "account" && f.subtab === "info")}
                  form={form}
                  onChange={setField}
                />
              )}

              {/* Account · Recovery */}
              {formTab === "account" && acctSubTab === "recovery" && (
                <SchemaForm
                  fields={KYC_FIELDS.filter(f => f.tab === "account" && f.subtab === "recovery")}
                  form={form}
                  onChange={setField}
                />
              )}

              {/* Email — IMAP/SMTP configuration */}
              {formTab === "email" && (
                <div className="space-y-4">
                  {form.email ? (
                    <div className="rounded-lg border border-border/40">
                      <div className="px-3 py-2 border-b border-border/30 flex items-center gap-1.5">
                        <MailIcon className="w-3.5 h-3.5 text-primary" />
                        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Email Settings (IMAP/SMTP) — {form.email}
                        </span>
                      </div>
                      {emailAccountsLoading && emailAccounts.length === 0 ? (
                        <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-primary" /></div>
                      ) : (
                        <ImapSmtpForm
                          emailAddress={form.email}
                          existingAccount={emailAccounts.find(a => a.emailAddress === form.email) ?? null}
                          token={token}
                          onSaved={fetchEmailAccounts}
                          onDeleted={fetchEmailAccounts}
                          compact
                        />
                      )}
                    </div>
                  ) : (
                    <p className="font-mono text-xs text-muted-foreground/50 text-center py-6">
                      Enter an email in Account → Main to configure IMAP/SMTP here.
                    </p>
                  )}
                </div>
              )}

              {formTab === "kyc" && formSubTab === "info" && (
                <div className="space-y-2">
                  <p className="font-mono text-[10px] text-muted-foreground/50">
                    Link the Data Entity that holds this KYC entity's identity details (NID, name, father's name, birthdate, photos).
                  </p>
                  <DataEntityPicker
                    value={form.dataEntityId ?? null}
                    onChange={id => setField("dataEntityId", id)}
                    currentKycEntryId={editEntry?.id ?? null}
                  />
                </div>
              )}

              {formTab === "kyc" && formSubTab === "seller" && (
                <div className="space-y-4">
                  <SchemaForm fields={SELLER_SCHEMA_FIELDS} form={form} onChange={setField} />
                  {/* Paid / Unpaid — Yes/No pill pair (SchemaForm has no toggle control) */}
                  <div className="space-y-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Payment Status</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setField("paid", true)}
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-lg border py-2 font-mono text-xs transition-all",
                          form.paid ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-400 font-bold" : "border-border/40 text-muted-foreground/60 hover:border-emerald-400/30"
                        )}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Paid
                      </button>
                      <button
                        onClick={() => setField("paid", false)}
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-lg border py-2 font-mono text-xs transition-all",
                          !form.paid ? "border-red-400/50 bg-red-400/10 text-red-400 font-bold" : "border-border/40 text-muted-foreground/60 hover:border-red-400/30"
                        )}
                      >
                        <XCircle className="w-3.5 h-3.5" /> Unpaid
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="px-5 py-3 border-t border-card-border flex-shrink-0">
              <Button variant="outline" size="sm" onClick={onClose} className="font-mono text-xs">Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving} className="font-mono text-xs gap-1.5">
                {saving && <Loader2 className="w-3 h-3 animate-spin" />} {editEntry ? "Save Changes" : "Create Entity"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main list ───────────────────────────────────────────────────────────────
export default function KycEntries() {
  const [, navigate] = useLocation();
  const [entries, setEntries] = useState<KycEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<KycEntry | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [shareItems, setShareItems] = useState<ShareTarget[] | null>(null);
  const [shareLabel, setShareLabel] = useState<string | undefined>(undefined);
  const [managingShares, setManagingShares] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const { toast } = useToast();

  const toggleSelected = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const shareOne = (e: KycEntry) => { setShareItems([{ entityType: "kyc", entityId: e.id }]); setShareLabel(e.name || e.username || `KYC #${e.id}`); };
  const shareSelected = () => { setShareItems(Array.from(selectedIds).map(id => ({ entityType: "kyc" as const, entityId: id }))); setShareLabel(undefined); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<KycEntry[]>("/api/kyc-entries");
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      toast({ variant: "destructive", title: "Failed to load KYC entities" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditEntry(null); setDialogOpen(true); };
  const openEdit = (e: KycEntry) => { setEditEntry(e); setDialogOpen(true); };

  const remove = async (id: number) => {
    try {
      await customFetch<unknown>(`/api/kyc-entries/${id}`, { method: "DELETE" });
      toast({ title: "KYC entity deleted" });
      setDeleteId(null);
      load();
    } catch {
      toast({ variant: "destructive", title: "Failed to delete" });
    }
  };

  const handleBan = async (entry: KycEntry) => {
    const nextStatus = entry.status === "banned" ? "active" : "banned";
    try {
      await customFetch<unknown>(`/api/kyc-entries/${entry.id}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
      toast({ title: nextStatus === "banned" ? "KYC entity banned" : "KYC entity unbanned", description: nextStatus === "banned" ? "It now shows under Vault → Banned." : undefined });
      load();
    } catch {
      toast({ variant: "destructive", title: "Failed to update ban status" });
    }
  };

  const filtered = entries.filter(e => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [e.category, e.name, e.username, e.email, e.nid_number, e.seller_name]
      .some(v => v?.toLowerCase().includes(q));
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search KYC entities..."
            className="w-full bg-input border border-border rounded-lg pl-8 pr-3 py-2 text-xs font-mono focus:outline-none focus:border-primary/60 placeholder:text-muted-foreground"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setManagingShares(true)} className="font-mono text-xs gap-1.5 ml-auto">
          <Users className="w-3.5 h-3.5" /> Shares
        </Button>
        <Button size="sm" onClick={openCreate} className="font-mono text-xs gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add KYC Entity
        </Button>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="font-mono text-xs text-primary">{selectedIds.size} selected</span>
          <Button size="sm" variant="outline" onClick={shareSelected} className="font-mono text-xs gap-1.5 ml-auto">
            <Share2 className="w-3.5 h-3.5" /> Share Selected
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} className="font-mono text-xs">Clear</Button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border/40 rounded-xl">
          <ShieldCheck className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-xs text-muted-foreground/50">No KYC entities yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(e => (
            <div key={e.id} onClick={() => navigate(`/vault/kyc/${e.id}`)} className={cn("bg-card border rounded-xl p-4 hover:border-primary/30 transition-all group relative cursor-pointer", e.status === "banned" ? "border-red-400/40" : selectedIds.has(e.id) ? "border-primary/50" : "border-card-border")}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Checkbox checked={selectedIds.has(e.id)} onCheckedChange={() => toggleSelected(e.id)} />
                  <CategoryBadge category={e.category} />
                  {e.status === "banned" && (
                    <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-red-400/10 text-red-400 border border-red-400/20 flex items-center gap-1">
                      <Ban className="w-2.5 h-2.5" /> BANNED
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity relative" onClick={ev => ev.stopPropagation()}>
                  <button
                    onClick={() => setOpenMenuId(openMenuId === e.id ? null : e.id)}
                    className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
                  >
                    <MoreVertical className="w-3.5 h-3.5" />
                  </button>
                  {openMenuId === e.id && (
                    <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-card-border rounded-xl shadow-2xl p-2 min-w-max">
                      <div className="grid grid-cols-4 gap-1">
                        {([
                          { icon: Edit2, label: "Edit", action: () => openEdit(e), cls: "" },
                          { icon: Share2, label: "Share", action: () => shareOne(e), cls: "" },
                          { icon: e.status === "banned" ? ShieldOff : Ban, label: e.status === "banned" ? "Unban" : "Ban", action: () => handleBan(e), cls: "" },
                          { icon: Trash2, label: "Del", action: () => setDeleteId(e.id), cls: "text-red-400 hover:bg-red-400/10 hover:border-red-400/30 hover:text-red-400" },
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
              <p className="font-mono text-sm font-bold text-foreground truncate mb-1">{e.name || "Unnamed"}</p>
              <p className="font-mono text-[10px] text-muted-foreground/50 mb-3 truncate">{e.nid_number ? `NID: ${e.nid_number}` : "No NID on file"}</p>
              {(e.photo1_url || e.photo2_url) && (
                <div className="flex gap-1.5 mb-3">
                  {e.photo1_url && <img src={e.photo1_url} alt="Photo 1" className="w-10 h-10 rounded-md object-cover border border-border/40" />}
                  {e.photo2_url && <img src={e.photo2_url} alt="Photo 2" className="w-10 h-10 rounded-md object-cover border border-border/40" />}
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                {e.username && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-cyan-400/10 text-cyan-400 border border-cyan-400/20 flex items-center gap-1"><KeyRound className="w-2.5 h-2.5" />ACCOUNT</span>}
                {e.email && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-sky-400/10 text-sky-400 border border-sky-400/20">EMAIL</span>}
                <span className={cn(
                  "font-mono text-[8px] px-1.5 py-0.5 rounded border flex items-center gap-1",
                  e.paid ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" : "bg-red-400/10 text-red-400 border-red-400/20"
                )}>
                  {e.paid ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
                  {e.paid ? "PAID" : "UNPAID"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <KycDialogInner open={dialogOpen} editEntry={editEntry} onClose={() => setDialogOpen(false)} onSaved={load} />

      <ShareEntityDialog
        open={shareItems !== null}
        onClose={() => setShareItems(null)}
        items={shareItems ?? []}
        entityLabel={shareLabel}
        onShared={clearSelection}
      />
      <ManageSharesDialog open={managingShares} onClose={() => setManagingShares(false)} entityType="kyc" />

      <Dialog open={deleteId !== null} onOpenChange={v => !v && setDeleteId(null)}>
        <DialogContent className="bg-card border-card-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2"><X className="w-4 h-4 text-red-400" /> Delete KYC Entity</DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">This KYC entity's credentials will be permanently deleted. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteId(null)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteId && remove(deleteId)} className="font-mono text-xs">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
