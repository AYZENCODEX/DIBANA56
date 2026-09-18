/**
 * vault-kyc-data-detail.tsx
 * ─────────────────────────────────────────────
 * KYC → Data Entity → detail. View/edit a single data entity's identity
 * fields, see whether it's used/unused and which KYC entity links to it,
 * and delete it (blocked server-side while a KYC entity still links to it).
 */
import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  ChevronLeft, IdCard, Loader2, Edit2, Trash2, Link2, Unlink, Save, X,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { KYC_DATA_FIELDS } from "@/config/fields/kyc-data-create";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { DataEntity } from "./vault-kyc-data-list";

export default function VaultKycDataDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [entity, setEntity] = useState<DataEntity | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const e = await customFetch<DataEntity>(`/api/kyc-data-entities/${id}`);
      setEntity(e);
      setForm({
        nidNumber: e.nid_number ?? "", name: e.name ?? "", fatherName: e.father_name ?? "",
        birthDate: e.birth_date ? String(e.birth_date).slice(0, 10) : "",
        photo1Url: e.photo1_url ?? "", photo2Url: e.photo2_url ?? "", notes: e.notes ?? "",
      });
    } catch {
      setEntity(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const setField = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await customFetch<unknown>(`/api/kyc-data-entities/${id}`, { method: "PUT", body: JSON.stringify(form) });
      toast({ title: "Data entity updated" });
      setEditing(false);
      load();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this data entity? This can't be undone.")) return;
    try {
      await customFetch<unknown>(`/api/kyc-data-entities/${id}`, { method: "DELETE" });
      toast({ title: "Data entity deleted" });
      navigate("/vault/kyc/data/overview");
    } catch (err: any) {
      toast({ title: "Delete failed", description: err?.message ?? "Still linked to a KYC entity — unlink it first", variant: "destructive" });
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  }
  if (!entity) {
    return <p className="font-mono text-sm text-muted-foreground/60 text-center py-20">Data entity not found.</p>;
  }

  return (
    <div className="space-y-5 page-enter">
      <button
        onClick={() => navigate("/vault/kyc/data/overview")}
        className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground/60 hover:text-primary transition-colors"
      >
        <ChevronLeft className="w-3.5 h-3.5" /> Back to Data Entity Overview
      </button>

      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <IdCard className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold font-mono">{entity.name || `Data Entity #${entity.id}`}</h1>
            {entity.used ? (
              <Badge variant="outline" className="font-mono text-[9px] text-emerald-400 border-emerald-400/30 bg-emerald-400/5 mt-1">
                <Link2 className="w-2.5 h-2.5 mr-1" /> Used
                {entity.linked_kyc_category
                  ? ` · ${entity.linked_kyc_category}`
                  : entity.linked_vault_project_name
                    ? ` · ${entity.linked_vault_project_name}`
                    : ""}
              </Badge>
            ) : (
              <Badge variant="outline" className="font-mono text-[9px] text-amber-400 border-amber-400/30 bg-amber-400/5 mt-1">
                <Unlink className="w-2.5 h-2.5 mr-1" /> Unused
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button variant="outline" size="sm" onClick={() => { setEditing(false); load(); }} disabled={saving}>
                <X className="w-3.5 h-3.5 mr-1" /> Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Save className="w-3.5 h-3.5 mr-1" /> Save</>}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={remove}
                disabled={entity.used}
                title={entity.used ? "Unlink it from its KYC/Vault entity before deleting" : undefined}
                className={cn(entity.used ? "opacity-40 cursor-not-allowed" : "text-red-400 hover:text-red-400 border-red-400/20 hover:bg-red-400/5")}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {entity.used && entity.linked_kyc_entry_id && (
        <button
          onClick={() => navigate(`/vault/kyc/${entity.linked_kyc_entry_id}`)}
          className="w-full text-left bg-card border border-card-border rounded-lg p-3 flex items-center gap-2 hover:border-primary/30 transition-all"
        >
          <Link2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <span className="font-mono text-xs text-muted-foreground">
            Linked to KYC entity <span className="text-primary font-bold">#{entity.linked_kyc_entry_id}</span> — view it →
          </span>
        </button>
      )}

      {entity.used && !entity.linked_kyc_entry_id && entity.linked_vault_entry_id && (
        <button
          onClick={() => navigate(`/vault/entity/${entity.linked_vault_entry_id}`)}
          className="w-full text-left bg-card border border-card-border rounded-lg p-3 flex items-center gap-2 hover:border-primary/30 transition-all"
        >
          <Link2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <span className="font-mono text-xs text-muted-foreground">
            Linked to Vault entity <span className="text-primary font-bold">{entity.linked_vault_project_name || `#${entity.linked_vault_entry_id}`}</span> — view it →
          </span>
        </button>
      )}

      <div className="bg-card border border-card-border rounded-xl p-4">
        {editing ? (
          <SchemaForm fields={KYC_DATA_FIELDS} form={form} onChange={setField} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-xs">
            <div><p className="text-muted-foreground/50 text-[9px] uppercase tracking-wider mb-0.5">NID Number</p><p>{entity.nid_number || "—"}</p></div>
            <div><p className="text-muted-foreground/50 text-[9px] uppercase tracking-wider mb-0.5">Name</p><p>{entity.name || "—"}</p></div>
            <div><p className="text-muted-foreground/50 text-[9px] uppercase tracking-wider mb-0.5">Father's Name</p><p>{entity.father_name || "—"}</p></div>
            <div><p className="text-muted-foreground/50 text-[9px] uppercase tracking-wider mb-0.5">Birthdate</p><p>{entity.birth_date ? String(entity.birth_date).slice(0, 10) : "—"}</p></div>
            {entity.notes && <div className="sm:col-span-2"><p className="text-muted-foreground/50 text-[9px] uppercase tracking-wider mb-0.5">Notes</p><p className="whitespace-pre-wrap">{entity.notes}</p></div>}
            {(entity.photo1_url || entity.photo2_url) && (
              <div className="sm:col-span-2 flex gap-3 mt-2">
                {entity.photo1_url && <img src={entity.photo1_url} alt="Photo 1" className="w-28 h-28 object-cover rounded-lg border border-border/30" />}
                {entity.photo2_url && <img src={entity.photo2_url} alt="Photo 2" className="w-28 h-28 object-cover rounded-lg border border-border/30" />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
