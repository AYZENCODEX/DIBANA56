/**
 * data-entity-picker.tsx
 * ─────────────────────────────────────────────
 * Shown in the KYC create/edit dialog (components/kyc-entries.tsx) AND in
 * the Vault Entity create/edit dialog (pages/user/vault.tsx, "Link Data
 * Entity"). Lets the user link an existing "Data Entity" (kyc_data_entities
 * — NID/name/father's name/birthdate/photos) to whichever entity is being
 * created, instead of re-typing that data. A Data Entity is not exclusive
 * to one place — it can be linked from a KYC entity, a Vault entity, or
 * (going forward) any other project that reuses the same bridge, which is
 * why both currentKycEntryId and currentVaultEntryId are accepted here.
 * Same free/used split + link/clear interaction as local-entity-picker.tsx,
 * but fetches its own list rather than being handed one by a parent.
 * Includes an inline "+ Add Data Entity" quick-create so a caller never has
 * to leave the dialog to make a fresh one.
 */
import { useState, useEffect, useCallback } from "react";
import { Link, X, ChevronDown, IdCard, Plus, Loader2 } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

interface DataEntity {
  id: number;
  name: string | null;
  nid_number: string | null;
  used: boolean;
  linked_kyc_entry_id: number | null;
  linked_vault_entry_id: number | null;
}

interface Props {
  /** Currently linked Data Entity id, or null if none linked yet. */
  value: number | null;
  onChange: (id: number | null) => void;
  /** Id of the KYC entity being edited (if editing) — its own linked Data
   *  Entity should count as "free" for re-selection, not "used elsewhere". */
  currentKycEntryId?: number | null;
  /** Id of the Vault entity being edited (if editing) — same "free for
   *  re-selection" treatment as currentKycEntryId, for the Vault side of
   *  the bridge (Exchange-category accounts and beyond). */
  currentVaultEntryId?: number | null;
}

const EMPTY_QUICK_ADD = { name: "", nidNumber: "", fatherName: "" };

export function DataEntityPicker({ value, onChange, currentKycEntryId, currentVaultEntryId }: Props) {
  const [entities, setEntities] = useState<DataEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [quickAdd, setQuickAdd] = useState(EMPTY_QUICK_ADD);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await customFetch<DataEntity[]>("/api/kyc-data-entities");
      setEntities(Array.isArray(rows) ? rows : []);
    } catch {
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const linked = entities.find(e => e.id === value) ?? null;

  const createAndLink = async () => {
    if (!quickAdd.name.trim() && !quickAdd.nidNumber.trim()) return;
    setSaving(true);
    try {
      const created = await customFetch<DataEntity>("/api/kyc-data-entities", {
        method: "POST",
        body: JSON.stringify({
          name: quickAdd.name.trim() || null,
          nidNumber: quickAdd.nidNumber.trim() || null,
          fatherName: quickAdd.fatherName.trim() || null,
        }),
      });
      setEntities(prev => [created, ...prev]);
      onChange(created.id);
      setQuickAdd(EMPTY_QUICK_ADD);
      setAdding(false);
      setOpen(false);
    } catch {
      // best-effort — leave the quick-add form open so the user can retry
    } finally {
      setSaving(false);
    }
  };

  if (value && linked) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-primary/25 bg-primary/5 text-primary font-mono text-[10px] mb-1">
        <Link className="w-3 h-3 flex-shrink-0" />
        <span className="flex-1 truncate">
          Data Entity: <span className="font-bold">{linked.name ?? `#${linked.id}`}</span>
        </span>
        <button
          onClick={() => onChange(null)}
          title="Remove link"
          className="text-muted-foreground/50 hover:text-red-400 transition-colors flex-shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  // "Free" = unused, or used only by the entity currently being edited
  // (either side of the bridge — KYC or Vault).
  const free = entities.filter(e =>
    !e.used ||
    e.linked_kyc_entry_id === currentKycEntryId ||
    (currentVaultEntryId != null && e.linked_vault_entry_id === currentVaultEntryId)
  );
  const used = entities.filter(e => !free.includes(e));

  return (
    <div className="space-y-1 mb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 rounded-lg border font-mono text-[10px] transition-all",
          open
            ? "border-primary/30 text-primary bg-primary/5 shadow-sm"
            : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground hover:border-border/60 bg-muted/5"
        )}
      >
        <IdCard className="w-3 h-3 flex-shrink-0" />
        <span className="flex-1 text-left">
          {loading ? "Loading data entities…" : free.length > 0 ? `Link a data entity (${free.length} unused)` : "No unused data entities"}
        </span>
        <ChevronDown className={cn("w-3 h-3 flex-shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && !loading && (
        <div className="border border-border/30 rounded-lg overflow-hidden bg-card shadow-sm">
          {free.length === 0 && used.length === 0 && !adding && (
            <p className="px-3 py-3 font-mono text-[10px] text-muted-foreground/50 text-center">
              No data entities yet — add one below.
            </p>
          )}
          {free.length > 0 && (
            <div>
              <p className="px-3 py-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/40 border-b border-border/20 bg-muted/10">
                Unused — click to link
              </p>
              {free.map(e => (
                <button
                  key={e.id}
                  onClick={() => { onChange(e.id); setOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/20 transition-colors border-b border-border/10 last:border-0 text-left group"
                >
                  <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 bg-primary/10">
                    <IdCard className="w-2.5 h-2.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-[11px] font-medium text-foreground truncate">
                      {e.name ?? `Data Entity #${e.id}`}
                    </p>
                  </div>
                  <span className="font-mono text-[8px] text-emerald-400 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity">
                    Link →
                  </span>
                </button>
              ))}
            </div>
          )}
          {used.length > 0 && (
            <div>
              <p className="px-3 py-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/40 border-b border-border/20 border-t border-border/10 bg-muted/10">
                Already used elsewhere
              </p>
              {used.map(e => (
                <div
                  key={e.id}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 border-b border-border/10 last:border-0 text-left opacity-50"
                >
                  <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 bg-muted/30">
                    <Link className="w-2.5 h-2.5 text-muted-foreground/50" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-[11px] font-medium text-foreground truncate">
                      {e.name ?? `Data Entity #${e.id}`}
                    </p>
                    <p className="font-mono text-[9px] text-muted-foreground/40 truncate">
                      {e.linked_kyc_entry_id != null ? `KYC entity #${e.linked_kyc_entry_id}` : `Vault entity #${e.linked_vault_entry_id}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className="w-full flex items-center gap-2 px-3 py-2.5 border-t border-border/20 hover:bg-primary/5 transition-colors text-primary font-mono text-[10px]"
            >
              <Plus className="w-3 h-3 flex-shrink-0" /> Add Data Entity
            </button>
          ) : (
            <div className="p-3 space-y-2 border-t border-border/20 bg-muted/10">
              <p className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground/50">New Data Entity</p>
              <input
                value={quickAdd.name}
                onChange={e => setQuickAdd(p => ({ ...p, name: e.target.value }))}
                placeholder="Full name"
                className="w-full px-2 py-1.5 rounded-md border border-border/30 bg-input font-mono text-[11px] outline-none focus:border-primary/40"
              />
              <input
                value={quickAdd.nidNumber}
                onChange={e => setQuickAdd(p => ({ ...p, nidNumber: e.target.value }))}
                placeholder="NID number"
                className="w-full px-2 py-1.5 rounded-md border border-border/30 bg-input font-mono text-[11px] outline-none focus:border-primary/40"
              />
              <input
                value={quickAdd.fatherName}
                onChange={e => setQuickAdd(p => ({ ...p, fatherName: e.target.value }))}
                placeholder="Father's name"
                className="w-full px-2 py-1.5 rounded-md border border-border/30 bg-input font-mono text-[11px] outline-none focus:border-primary/40"
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={createAndLink}
                  disabled={saving || (!quickAdd.name.trim() && !quickAdd.nidNumber.trim())}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/90 text-primary-foreground font-mono text-[10px] font-bold disabled:opacity-40 transition-opacity"
                >
                  {saving && <Loader2 className="w-3 h-3 animate-spin" />} Create &amp; Link
                </button>
                <button
                  onClick={() => { setAdding(false); setQuickAdd(EMPTY_QUICK_ADD); }}
                  className="px-3 py-1.5 rounded-md border border-border/30 text-muted-foreground/60 font-mono text-[10px]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
