/**
 * vault-kyc-data-list.tsx
 * ─────────────────────────────────────────────
 * KYC → Data Entity → Overview / Used / Unused. One page component, three
 * thin route wrappers (vault-kyc-data-overview / -used / -unused) each pass
 * a different `mode`:
 *   - "overview": roll-up stats bar + every data entity
 *   - "used":     only entities linked to a KYC entity
 *   - "unused":   only entities not yet linked to any KYC entity
 * Click a card to go to the detail page. "Add Data Entity" opens an inline
 * create dialog (identity fields only — see config/fields/kyc-data-create.ts).
 */
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  IdCard, Loader2, Plus, Users, Link2, Unlink, LayoutDashboard,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { KYC_DATA_FIELDS } from "@/config/fields/kyc-data-create";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface DataEntity {
  id: number;
  nid_number: string | null;
  name: string | null;
  father_name: string | null;
  birth_date: string | null;
  photo1_url: string | null;
  photo2_url: string | null;
  notes: string | null;
  used: boolean;
  linked_kyc_entry_id: number | null;
  linked_kyc_category: string | null;
  linked_vault_entry_id: number | null;
  linked_vault_project_name: string | null;
  created_at: string;
}

const EMPTY_FORM = { nidNumber: "", name: "", fatherName: "", birthDate: "", photo1Url: "", photo2Url: "", notes: "" };

// ─── Create Data Entity dialog ─────────────────────────────────────────────
function CreateDataEntityDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, any>>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => { if (open) setForm(EMPTY_FORM); }, [open]);
  const setField = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await customFetch<unknown>("/api/kyc-data-entities", { method: "POST", body: JSON.stringify(form) });
      toast({ title: "Data entity created" });
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <IdCard className="w-4 h-4 text-primary" /> New Data Entity
          </DialogTitle>
        </DialogHeader>
        <p className="font-mono text-[10px] text-muted-foreground/50 -mt-2">
          Identity / KYC-document fields only — no account password. Link this to a KYC entity from the KYC create dialog afterward.
        </p>
        <SchemaForm fields={KYC_DATA_FIELDS} form={form} onChange={setField} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function VaultKycDataList({ mode }: { mode: "overview" | "used" | "unused" }) {
  const [, navigate] = useLocation();
  const [entities, setEntities] = useState<DataEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = mode === "overview" ? "" : `?status=${mode}`;
      const rows = await customFetch<DataEntity[]>(`/api/kyc-data-entities${qs}`);
      setEntities(Array.isArray(rows) ? rows : []);
    } catch {
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => { load(); }, [load]);

  const total = entities.length;
  const usedCount = entities.filter(e => e.used).length;
  const unusedCount = total - usedCount;

  const meta = {
    overview: { title: "Data Entity — Overview", icon: LayoutDashboard, empty: "No data entities yet — create one to link into a KYC entity." },
    used:     { title: "Data Entity — Used",     icon: Link2,           empty: "No data entities are linked to a KYC entity yet." },
    unused:   { title: "Data Entity — Unused",   icon: Unlink,          empty: "No unused data entities — every one is linked to a KYC entity." },
  }[mode];

  return (
    <VaultSectionPage
      title={meta.title}
      description="Identity/KYC-document records — link one into a KYC entity instead of duplicating its fields"
      icon={meta.icon}
      headerExtra={
        <Button size="sm" onClick={() => setCreateOpen(true)} className="font-mono text-xs">
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Data Entity
        </Button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : (
        <div className="space-y-5">
          {mode === "overview" && (
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total", value: total, icon: Users, color: "text-cyan-400", bg: "bg-cyan-400/10" },
                { label: "Used", value: usedCount, icon: Link2, color: "text-emerald-400", bg: "bg-emerald-400/10" },
                { label: "Unused", value: unusedCount, icon: Unlink, color: "text-amber-400", bg: "bg-amber-400/10" },
              ].map(s => (
                <div key={s.label} className="bg-card border border-card-border rounded-xl p-3.5 flex items-start gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", s.bg)}>
                    <s.icon className={cn("w-4 h-4", s.color)} />
                  </div>
                  <div>
                    <p className={cn("text-lg font-bold font-mono", s.color)}>{s.value}</p>
                    <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 leading-tight">{s.label}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {entities.length === 0 ? (
            <VaultSectionEmptyState icon={meta.icon} title="Nothing here yet" note={meta.empty} />
          ) : (
            <div className="space-y-2">
              {entities.map(e => (
                <button
                  key={e.id}
                  onClick={() => navigate(`/vault/kyc/data/${e.id}`)}
                  className="w-full bg-card border border-card-border rounded-lg p-3.5 flex items-center gap-3 hover:border-primary/30 hover:bg-primary/5 transition-all text-left group"
                >
                  <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                    <IdCard className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                      {e.name || `Data Entity #${e.id}`}
                    </p>
                    <p className="font-mono text-[9px] text-muted-foreground/50 truncate mt-0.5">
                      {e.nid_number ? `NID: ${e.nid_number}` : "No NID set"}
                    </p>
                  </div>
                  {e.used ? (
                    <Badge variant="outline" className="font-mono text-[9px] text-emerald-400 border-emerald-400/30 bg-emerald-400/5">
                      Used{e.linked_kyc_category
                        ? ` · ${e.linked_kyc_category}`
                        : e.linked_vault_project_name
                          ? ` · ${e.linked_vault_project_name}`
                          : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="font-mono text-[9px] text-amber-400 border-amber-400/30 bg-amber-400/5">
                      Unused
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <CreateDataEntityDialog open={createOpen} onClose={() => setCreateOpen(false)} onSaved={load} />
    </VaultSectionPage>
  );
}
