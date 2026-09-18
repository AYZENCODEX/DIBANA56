import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Plus, TrendingUp, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type SourceType = "vault" | "local";
type Target = { value: string; label: string; currentValue?: number; currentBuyValue?: number };
type EntryMode = "add" | "set";

function ModeToggle({ mode, onChange }: { mode: EntryMode; onChange: (m: EntryMode) => void }) {
  return (
    <div className="flex gap-1 p-0.5 rounded-md bg-muted/20 w-fit">
      {(["add", "set"] as EntryMode[]).map(m => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn("px-2.5 py-1 rounded font-mono text-[10px] uppercase tracking-wider transition-all",
            mode === m ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground")}
        >
          {m === "add" ? "Add amount" : "Set exact"}
        </button>
      ))}
    </div>
  );
}

export function ValueEntryDialog({
  open, onOpenChange, sourceType, sourceId, title, targets, defaultTarget, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceType: SourceType;
  sourceId: number;
  title: string;
  targets?: Target[];
  defaultTarget?: string;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const [target, setTarget] = useState(defaultTarget ?? targets?.[0]?.value ?? "account");
  const [mode, setMode] = useState<EntryMode>("add");
  const [value, setValue] = useState("");
  const [buyValue, setBuyValue] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const selected = targets?.find(t => t.value === target);

  useEffect(() => {
    if (!open) return;
    setTarget(defaultTarget ?? targets?.[0]?.value ?? "account");
    setMode("add");
    setValue("");
    setBuyValue("");
    setNote("");
    const path = sourceType === "vault" ? `/api/vault/${sourceId}/value-history?metric=value` : `/api/local-accounts/${sourceId}/value-history`;
    fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem("ayzen_token") ?? ""}` } })
      .then(r => r.ok ? r.json() : [])
      .then(data => setHistory(Array.isArray(data) ? data : []))
      .catch(() => setHistory([]));
  }, [open, sourceType, sourceId, defaultTarget]);

  const save = async () => {
    const numericValue = Number(value);
    const numericBuy = Number(buyValue || 0);
    if (!Number.isFinite(numericValue) || (mode === "set" && numericValue < 0)) {
      toast({ variant: "destructive", title: "Enter a valid value" }); return;
    }
    setSaving(true);
    try {
      const path = sourceType === "vault" ? `/api/vault/${sourceId}/value` : `/api/local-accounts/${sourceId}/value`;
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("ayzen_token") ?? ""}` },
        body: JSON.stringify({ target, label: selected?.label ?? title, mode, value: numericValue, buyValue: numericBuy, note: note || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to save value");
      toast({ title: mode === "add" ? "Value added" : "Value updated", description: "Value history and P&L were updated." });
      setHistory(prev => [data.history ?? data, ...prev]);
      onSaved?.();
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Value save failed", description: err?.message });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-card-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" /> Value · {title}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {targets && targets.length > 1 && (
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Value target</Label>
              <select value={target} onChange={e => { setTarget(e.target.value); setValue(""); setBuyValue(""); }}
                className="w-full h-8 rounded-md border border-input bg-input px-2 font-mono text-xs">
                {targets.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          )}
          <ModeToggle mode={mode} onChange={setMode} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase text-emerald-400/80">{mode === "add" ? "Amount to add ($)" : "New worth ($)"}</Label>
              <Input type="number" step="0.01" value={value} onChange={e => setValue(e.target.value)} placeholder="0.00" className="font-mono text-xs bg-input" />
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/70">{mode === "add" ? "Buy value added ($)" : "New buy value ($)"}</Label>
              <Input type="number" step="0.01" value={buyValue} onChange={e => setBuyValue(e.target.value)} placeholder="0.00" className="font-mono text-xs bg-input" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Note (optional)</Label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="What changed?" className="font-mono text-xs bg-input resize-none h-16" />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Recent value history</p>
            {history.length === 0 ? <p className="font-mono text-[10px] text-muted-foreground/40">No value history yet</p> : (
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {history.slice(0, 5).map((row, i) => (
                  <div key={row.id ?? i} className="flex justify-between gap-2 font-mono text-[10px]">
                    <span className="text-muted-foreground/60">{row.note ? row.note : (row.label ?? row.target)}</span>
                    <span className="text-emerald-400">${Number(row.value).toFixed(2)} · {new Date(row.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="font-mono text-xs">Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving} className={cn("font-mono text-xs gap-1.5", saving && "opacity-70")}>
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} {mode === "add" ? "Add Value" : "Set Value"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ValueEntryButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" variant="outline" onClick={onClick} className="font-mono text-[10px] gap-1.5 h-7"><Plus className="w-3 h-3" /> Add Value</Button>;
}

// ─── Follower tracking — same add/set + note + history pattern as value ──────
export function FollowerEntryDialog({
  open, onOpenChange, sourceId, title, targets, defaultTarget, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: number;
  title: string;
  targets?: Target[];
  defaultTarget?: string;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const [target, setTarget] = useState(defaultTarget ?? targets?.[0]?.value ?? "entity");
  const [mode, setMode] = useState<EntryMode>("add");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const selected = targets?.find(t => t.value === target);

  useEffect(() => {
    if (!open) return;
    setTarget(defaultTarget ?? targets?.[0]?.value ?? "entity");
    setMode("add"); setValue(""); setNote("");
    fetch(`${BASE}/api/vault/${sourceId}/value-history?metric=follower`, { headers: { Authorization: `Bearer ${localStorage.getItem("ayzen_token") ?? ""}` } })
      .then(r => r.ok ? r.json() : [])
      .then(data => setHistory(Array.isArray(data) ? data : []))
      .catch(() => setHistory([]));
  }, [open, sourceId, defaultTarget]);

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || (mode === "set" && n < 0)) {
      toast({ variant: "destructive", title: "Enter a valid follower count" }); return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/vault/${sourceId}/followers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("ayzen_token") ?? ""}` },
        body: JSON.stringify({ target, mode, value: n, note: note || null, label: selected?.label ?? title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to save follower count");
      toast({ title: mode === "add" ? "Followers added" : "Followers updated", description: "Follower history was updated." });
      setHistory(prev => [data.history ?? data, ...prev]);
      onSaved?.();
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Follower save failed", description: err?.message });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-card-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <Users className="w-4 h-4 text-sky-400" /> Followers · {title}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {targets && targets.length > 1 && (
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Follower target</Label>
              <select value={target} onChange={e => { setTarget(e.target.value); setValue(""); }}
                className="w-full h-8 rounded-md border border-input bg-input px-2 font-mono text-xs">
                {targets.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          )}
          <ModeToggle mode={mode} onChange={setMode} />
          <div className="space-y-1">
            <Label className="font-mono text-[10px] uppercase text-sky-400/80">{mode === "add" ? "Followers to add" : "New follower count"}</Label>
            <Input type="number" step="1" value={value} onChange={e => setValue(e.target.value)} placeholder="e.g. 200" className="font-mono text-xs bg-input" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Note (optional)</Label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="What changed?" className="font-mono text-xs bg-input resize-none h-16" />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Recent follower history</p>
            {history.length === 0 ? <p className="font-mono text-[10px] text-muted-foreground/40">No follower history yet</p> : (
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {history.slice(0, 5).map((row, i) => (
                  <div key={row.id ?? i} className="flex justify-between gap-2 font-mono text-[10px]">
                    <span className="text-muted-foreground/60">{row.note ? row.note : (row.label ?? row.target)}</span>
                    <span className="text-sky-400">{Number(row.value).toLocaleString()} · {new Date(row.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="font-mono text-xs">Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving} className={cn("font-mono text-xs gap-1.5", saving && "opacity-70")}>
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} {mode === "add" ? "Add Followers" : "Set Followers"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FollowerEntryButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" variant="outline" onClick={onClick} className="font-mono text-[10px] gap-1.5 h-7"><Users className="w-3 h-3" /> Add Followers</Button>;
}