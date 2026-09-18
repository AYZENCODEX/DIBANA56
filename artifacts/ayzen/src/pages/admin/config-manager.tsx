import { useState, useEffect } from "react";
import { useConfigDomains, useConfigDomain, type ConfigEntry } from "@/hooks/use-config-domain";
import { CONFIG_ICON_NAMES, resolveConfigIcon } from "@/lib/dev-nav-icons";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Settings2, Plus, Trash2, Edit2, Loader2, FileJson, Cog } from "lucide-react";

// Keys that render as an icon picker instead of a plain text input, when
// present in an entry's data object.
const ICON_KEYS = new Set(["icon"]);

function coerceLikeOriginal(rawValue: string, original: unknown): unknown {
  if (typeof original === "number") {
    const n = Number(rawValue);
    return Number.isNaN(n) ? original : n;
  }
  if (typeof original === "boolean") return rawValue === "true";
  return rawValue;
}

function EntryEditor({
  open, initialData, onClose, onSave, saving,
}: {
  open: boolean;
  initialData: Record<string, unknown> | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Record<string, unknown>>(initialData ?? {});
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    if (open) { setForm(initialData ?? {}); setNewKey(""); }
  }, [open, initialData]);

  if (!open) return null;
  const keys = Object.keys(form);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{initialData ? "Edit entry" : "New entry"}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          {keys.length === 0 && (
            <p className="text-xs text-muted-foreground font-mono">No fields yet — add one below.</p>
          )}
          {keys.map(key => (
            <div key={key} className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{key}</Label>
              {ICON_KEYS.has(key) ? (
                <Select value={String(form[key] ?? "Circle")} onValueChange={(v) => setForm(f => ({ ...f, [key]: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {CONFIG_ICON_NAMES.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={String(form[key] ?? "")}
                  onChange={(e) => setForm(f => ({ ...f, [key]: coerceLikeOriginal(e.target.value, f[key]) }))}
                  className="font-mono text-xs"
                />
              )}
            </div>
          ))}
          <div className="flex gap-2 pt-2 border-t border-border/50">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="new field name"
              className="font-mono text-xs h-9"
            />
            <Button
              type="button" size="sm" variant="outline"
              onClick={() => { if (newKey.trim()) { setForm(f => ({ ...f, [newKey.trim()]: "" })); setNewKey(""); } }}
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(form)} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntryCard({ entry, onEdit, onDelete, onToggle }: {
  entry: ConfigEntry;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const iconName = typeof entry.data.icon === "string" ? entry.data.icon : undefined;
  const Icon = iconName ? resolveConfigIcon(iconName) : FileJson;
  const label = (entry.data.label ?? entry.data.id ?? entry.data.name ?? `Entry #${entry.id}`) as string;

  return (
    <div className={cn(
      "flex items-center gap-2 p-2.5 rounded-lg border border-border/50 hover:bg-muted/20 group",
      !entry.enabled && "opacity-50"
    )}>
      <Icon className="w-4 h-4 text-primary/70 flex-shrink-0" />
      <span className="text-sm font-mono flex-1 truncate">{String(label)}</span>
      <Badge variant="outline" className="text-[9px] font-mono">{Object.keys(entry.data).length} fields</Badge>
      <Switch checked={entry.enabled} onCheckedChange={onToggle} />
      <div className="flex gap-1">
        <button onClick={onEdit} className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary">
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button onClick={onDelete} className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function AdminConfigManager() {
  const { domains, isLoading: domainsLoading } = useConfigDomains();
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const { entries, isLoading, addEntry, updateEntry, removeEntry } = useConfigDomain(selectedDomain ?? "");
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ id?: number; data: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConfigEntry | null>(null);

  const save = async (data: Record<string, unknown>) => {
    setSaving(true);
    try {
      const result = editing?.id !== undefined
        ? await updateEntry(editing.id, { data })
        : await addEntry(data);
      if (result.ok) {
        toast({ title: editing?.id !== undefined ? "Entry updated" : "Entry added" });
        setEditing(null);
      } else {
        toast({ title: "Couldn't save", description: result.error, variant: "destructive" });
      }
    } finally { setSaving(false); }
  };

  const toggle = async (entry: ConfigEntry, enabled: boolean) => {
    const result = await updateEntry(entry.id, { enabled });
    if (!result.ok) toast({ title: "Couldn't toggle entry", description: result.error, variant: "destructive" });
  };

  const confirmedDelete = async () => {
    if (!confirmDelete) return;
    const result = await removeEntry(confirmDelete.id);
    if (result.ok) toast({ title: "Entry removed" });
    else toast({ title: "Couldn't remove entry", description: result.error, variant: "destructive" });
    setConfirmDelete(null);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-2.5">
        <Settings2 className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-lg font-mono font-semibold">Config Manager</h1>
          <p className="text-xs text-muted-foreground font-mono">
            Edit config-driven arrays (payment methods, categories, currencies...) without touching code.
            Only domains a page has been wired to read from here actually take effect live.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-4">
        {/* Domain list */}
        <Card className="h-fit">
          <CardContent className="p-2">
            {domainsLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            ) : domains.length === 0 ? (
              <p className="text-xs text-muted-foreground font-mono p-3">No domains registered yet.</p>
            ) : (
              <div className="space-y-1">
                {domains.map(d => (
                  <button
                    key={d.domain}
                    onClick={() => setSelectedDomain(d.domain)}
                    className={cn(
                      "w-full text-left px-2.5 py-2 rounded-md text-xs font-mono flex items-center gap-2 transition-colors",
                      selectedDomain === d.domain ? "bg-primary/10 text-primary" : "hover:bg-muted/30 text-muted-foreground"
                    )}
                  >
                    <Cog className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 truncate">{d.label}</span>
                    <Badge variant="outline" className="text-[9px]">{d.count}</Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Entries for selected domain */}
        <Card>
          <CardContent className="p-3">
            {!selectedDomain ? (
              <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <Settings2 className="w-6 h-6 opacity-40" />
                <p className="text-sm font-mono">Pick a domain on the left.</p>
              </div>
            ) : isLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <Button size="sm" className="gap-1.5" onClick={() => setEditing({ data: {} })}>
                    <Plus className="w-3.5 h-3.5" /> Add Entry
                  </Button>
                </div>
                {entries.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
                    <FileJson className="w-6 h-6 opacity-40" />
                    <p className="text-sm font-mono">No entries in this domain yet.</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {entries.map(entry => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        onEdit={() => setEditing({ id: entry.id, data: entry.data })}
                        onDelete={() => setConfirmDelete(entry)}
                        onToggle={(v) => toggle(entry, v)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <EntryEditor
        open={!!editing}
        initialData={editing?.data ?? null}
        onClose={() => setEditing(null)}
        onSave={save}
        saving={saving}
      />

      <Dialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remove this entry?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground font-mono">This can't be undone.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmedDelete}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
