import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Plus, Trash2, Edit2, Gamepad2, Loader2,
  Search, User, Mail as MailIcon, Info as InfoIcon, X, Tag as TagIcon,
  Share2, Users, MoreVertical, Ban,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { customFetch } from "@workspace/api-client-react";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { GAME_FIELDS } from "@/config/fields/game-create";
import { GAME_CATEGORIES, getGameCategoryMeta } from "@/config/vault-game";
import { ShareEntityDialog, type ShareTarget } from "@/components/vault/share-entity-dialog";
import { ManageSharesDialog } from "@/components/vault/manage-shares-dialog";

// ─── Types ──────────────────────────────────────────────────────────────────
export interface GameEntry {
  id: number;
  category: string;
  username: string | null;
  account_password: string | null;
  notes: string | null;
  email: string | null;
  email_password: string | null;
  email_2fa: string | null;
  email_backup_code: string | null;
  rank: string | null;
  level: string | null;
  account_age: string | null;
  tags: string[] | null;
  created_at: string;
}

const EMPTY_FORM: Record<string, any> = {
  category: "", username: "", accountPassword: "", notes: "",
  email: "", emailPassword: "", email2fa: "", emailBackupCode: "",
  rank: "", level: "", accountAge: "", tags: [] as string[],
};

// Maps API's snake_case row -> the dialog form's camelCase keys
function rowToForm(e: GameEntry): Record<string, any> {
  return {
    category: e.category ?? "", username: e.username ?? "", accountPassword: e.account_password ?? "", notes: e.notes ?? "",
    email: e.email ?? "", emailPassword: e.email_password ?? "", email2fa: e.email_2fa ?? "", emailBackupCode: e.email_backup_code ?? "",
    rank: e.rank ?? "", level: e.level ?? "", accountAge: e.account_age ?? "",
    tags: Array.isArray(e.tags) ? e.tags : [],
  };
}

const FORM_TABS = [
  { id: "account", label: "Account", icon: User },
  { id: "email", label: "Email", icon: MailIcon },
  { id: "info", label: "Info", icon: InfoIcon },
] as const;
type FormTab = typeof FORM_TABS[number]["id"];

// Fields SchemaForm should render for the Info tab — "tags" is excluded
// since it renders as its own space-to-chip control (see TagInput below;
// same pattern config/fields/game-create.ts documents for kyc's "paid").
const INFO_SCHEMA_FIELDS = GAME_FIELDS.filter(f => f.tab === "info" && f.key !== "tags");

function CategoryBadge({ category }: { category: string }) {
  const meta = getGameCategoryMeta(category);
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

// ─── Tag input — type freely, press Space (or Enter/,) to commit a tag ─────
function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === " " || e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => onChange(value.filter(t => t !== tag));

  return (
    <div className="space-y-1.5">
      <div
        className="flex flex-wrap items-center gap-1.5 min-h-[2.5rem] bg-input border border-border rounded-lg px-2.5 py-1.5 focus-within:border-primary/60 transition-colors"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map(tag => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/25"
          >
            {tag}
            <button
              type="button"
              onClick={e => { e.stopPropagation(); removeTag(tag); }}
              className="hover:text-red-400 transition-colors"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => commit(draft)}
          placeholder={value.length === 0 ? "e.g. rare skin, high rank, verified..." : ""}
          className="flex-1 min-w-[8ch] bg-transparent outline-none font-mono text-xs placeholder:text-muted-foreground"
        />
      </div>
      <p className="text-[9px] font-mono text-muted-foreground/50">Press space, enter, or comma to turn what you typed into a tag.</p>
    </div>
  );
}

// ─── Create / Edit dialog ───────────────────────────────────────────────────
function GameDialog({ open, editEntry, onClose, onSaved }: {
  open: boolean; editEntry: GameEntry | null; onClose: () => void; onSaved: () => void;
}) {
  const [step, setStep] = useState<"category" | "form">("category");
  const [form, setForm] = useState<Record<string, any>>(EMPTY_FORM);
  const [formTab, setFormTab] = useState<FormTab>("account");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

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
  }, [open, editEntry]);

  const setField = (key: string, value: any) => setForm(p => ({ ...p, [key]: value }));

  const save = async () => {
    if (!form.category) { toast({ variant: "destructive", title: "Pick a platform first" }); return; }
    setSaving(true);
    try {
      if (editEntry) {
        await customFetch<unknown>(`/api/game-entries/${editEntry.id}`, { method: "PUT", body: JSON.stringify(form) });
        toast({ title: "Game entity updated" });
      } else {
        await customFetch<unknown>("/api/game-entries", { method: "POST", body: JSON.stringify(form) });
        toast({ title: "Game entity created" });
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
            <Gamepad2 className="w-4 h-4 text-primary" />
            {editEntry ? "Edit Game Entity" : step === "category" ? "Choose a Platform" : "Add Game Entity"}
          </DialogTitle>
        </DialogHeader>

        {step === "category" ? (
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {GAME_CATEGORIES.map(cat => (
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
                    <Gamepad2 className="w-3.5 h-3.5" style={{ color: cat.color }} />
                  </div>
                  <span className="text-xs font-bold">{cat.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Top-level tabs */}
            <div className="px-5 pt-3 flex gap-1 flex-shrink-0 overflow-x-auto">
              {FORM_TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setFormTab(t.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider flex-shrink-0 transition-all flex items-center gap-1.5",
                    formTab === t.id ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
                  )}
                >
                  <t.icon className="w-3 h-3" /> {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Chosen platform, with a way back to the box picker (add-only) */}
              <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 bg-muted/10">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: getGameCategoryMeta(form.category).color }} />
                  <span className="font-mono text-xs font-bold text-foreground">{form.category || "Platform"}</span>
                </div>
                {!editEntry && (
                  <button onClick={() => setStep("category")} className="font-mono text-[9px] text-muted-foreground/50 hover:text-primary transition-colors">
                    Change
                  </button>
                )}
              </div>

              {formTab === "account" && (
                <SchemaForm fields={GAME_FIELDS} tab="account" form={form} onChange={setField} />
              )}

              {formTab === "email" && (
                <SchemaForm fields={GAME_FIELDS} tab="email" form={form} onChange={setField} />
              )}

              {formTab === "info" && (
                <div className="space-y-4">
                  <SchemaForm fields={INFO_SCHEMA_FIELDS} form={form} onChange={setField} />
                  <div className="space-y-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1.5">
                      <TagIcon className="w-3 h-3" /> Tags
                    </span>
                    <TagInput value={form.tags ?? []} onChange={tags => setField("tags", tags)} />
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
export default function GameEntries() {
  const [entries, setEntries] = useState<GameEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<GameEntry | null>(null);
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
  const shareOne = (e: GameEntry) => { setShareItems([{ entityType: "game", entityId: e.id }]); setShareLabel(e.username || `Game #${e.id}`); };
  const shareSelected = () => { setShareItems(Array.from(selectedIds).map(id => ({ entityType: "game" as const, entityId: id }))); setShareLabel(undefined); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<GameEntry[]>("/api/game-entries");
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      toast({ variant: "destructive", title: "Failed to load game entities" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditEntry(null); setDialogOpen(true); };
  const openEdit = (e: GameEntry) => { setEditEntry(e); setDialogOpen(true); };

  const remove = async (id: number) => {
    try {
      await customFetch<unknown>(`/api/game-entries/${id}`, { method: "DELETE" });
      toast({ title: "Game entity deleted" });
      setDeleteId(null);
      load();
    } catch {
      toast({ variant: "destructive", title: "Failed to delete" });
    }
  };

  const filtered = entries.filter(e => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [e.category, e.username, e.email, e.rank, ...(e.tags ?? [])]
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
            placeholder="Search game entities..."
            className="w-full bg-input border border-border rounded-lg pl-8 pr-3 py-2 text-xs font-mono focus:outline-none focus:border-primary/60 placeholder:text-muted-foreground"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setManagingShares(true)} className="font-mono text-xs gap-1.5 ml-auto">
          <Users className="w-3.5 h-3.5" /> Shares
        </Button>
        <Button size="sm" onClick={openCreate} className="font-mono text-xs gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add Game Entity
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
          <Gamepad2 className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
          <p className="font-mono text-xs text-muted-foreground/50">No game entities yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(e => (
            <div key={e.id} className={cn("bg-card border rounded-xl p-4 hover:border-primary/30 transition-all group relative", selectedIds.has(e.id) ? "border-primary/50" : "border-card-border")}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Checkbox checked={selectedIds.has(e.id)} onCheckedChange={() => toggleSelected(e.id)} />
                  <CategoryBadge category={e.category} />
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity relative">
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
                          { icon: Ban, label: "Ban", action: () => {}, cls: "" },
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
              <p className="font-mono text-sm font-bold text-foreground truncate mb-1">{e.username || "Unnamed"}</p>
              <p className="font-mono text-[10px] text-muted-foreground/50 mb-3 truncate">
                {[e.rank, e.level ? `Lv.${e.level}` : null, e.account_age].filter(Boolean).join(" · ") || "No info on file"}
              </p>
              <div className="flex flex-wrap gap-1">
                {e.username && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">ACCOUNT</span>}
                {e.email && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-sky-400/10 text-sky-400 border border-sky-400/20">EMAIL</span>}
                {(e.tags ?? []).slice(0, 4).map(tag => (
                  <span key={tag} className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{tag}</span>
                ))}
                {(e.tags ?? []).length > 4 && (
                  <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground border border-border/30">+{(e.tags ?? []).length - 4}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <GameDialog open={dialogOpen} editEntry={editEntry} onClose={() => setDialogOpen(false)} onSaved={load} />

      <ShareEntityDialog
        open={shareItems !== null}
        onClose={() => setShareItems(null)}
        items={shareItems ?? []}
        entityLabel={shareLabel}
        onShared={clearSelection}
      />
      <ManageSharesDialog open={managingShares} onClose={() => setManagingShares(false)} entityType="game" />

      <Dialog open={deleteId !== null} onOpenChange={v => !v && setDeleteId(null)}>
        <DialogContent className="bg-card border-card-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2"><X className="w-4 h-4 text-red-400" /> Delete Game Entity</DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">This game entity's credentials will be permanently deleted. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteId(null)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteId && remove(deleteId)} className="font-mono text-xs">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
