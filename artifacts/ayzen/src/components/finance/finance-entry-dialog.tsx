import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Loader2, UserPlus } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry, FinanceKind, FinanceParty } from "@/config/finance";
import { STATUS_OPTIONS, CURRENCY_OPTIONS, CRYPTO_CURRENCY_OPTIONS, EXPENSE_CATEGORIES } from "@/config/finance";
import { FinanceAttachments } from "./finance-attachments";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Project { id: number; name: string; }

export function FinanceEntryDialog({
  open, onOpenChange, kind, entry, onSaved, presetProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: FinanceKind;
  entry?: FinanceEntry | null;
  onSaved?: () => void;
  /** Lock the project select to this project (used by the Investment detail page). */
  presetProjectId?: number;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [partyId, setPartyId] = useState<string>("");
  const [projectId, setProjectId] = useState<string>("");
  const [category, setCategory] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState("pending");
  const [notes, setNotes] = useState("");
  const [lateFeeType, setLateFeeType] = useState<string>("none");
  const [lateFeeRate, setLateFeeRate] = useState("");
  const [lateFeeGraceDays, setLateFeeGraceDays] = useState("0");
  const [parties, setParties] = useState<FinanceParty[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [addingParty, setAddingParty] = useState(false);
  const [newPartyName, setNewPartyName] = useState("");
  const [savingParty, setSavingParty] = useState(false);

  const needsProject = kind === "investment" || kind === "expense" || kind === "income";
  const needsParty = kind === "receivable" || kind === "payable" || kind === "borrowed" || kind === "lending";
  const needsInterest = kind === "borrowed" || kind === "lending" || kind === "investment";

  useEffect(() => {
    if (!open) return;
    setTitle(entry?.title ?? "");
    setAmount(entry ? String(entry.amount) : "");
    setCurrency(entry?.currency ?? "BDT");
    setPartyId(entry?.partyId ? String(entry.partyId) : "");
    setProjectId(entry?.projectId ? String(entry.projectId) : presetProjectId ? String(presetProjectId) : "");
    setCategory(entry?.category ?? "");
    setInterestRate(entry?.interestRate != null ? String(entry.interestRate) : "");
    setDueDate(entry?.dueDate ? entry.dueDate.slice(0, 10) : "");
    setStatus(entry?.status ?? "pending");
    setNotes(entry?.notes ?? "");
    setLateFeeType(entry?.lateFeeType ?? "none");
    setLateFeeRate(entry?.lateFeeRate != null ? String(entry.lateFeeRate) : "");
    setLateFeeGraceDays(entry?.lateFeeGraceDays != null ? String(entry.lateFeeGraceDays) : "0");

    financeApi.listParties(token).then(setParties).catch(() => setParties([]));
    setAddingParty(false);
    setNewPartyName("");
    if (needsProject) {
      fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
        .then(r => r.ok ? r.json() : [])
        .then(data => setProjects(Array.isArray(data) ? data : (data?.projects ?? [])))
        .catch(() => setProjects([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry]);

  const handleAddParty = async () => {
    if (!newPartyName.trim()) return;
    setSavingParty(true);
    try {
      const created = await financeApi.createParty(token, { name: newPartyName.trim() });
      setParties(prev => [...prev, created]);
      setPartyId(String(created.id));
      setAddingParty(false);
      setNewPartyName("");
      toast({ title: "Party added" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to add party", description: e?.message });
    } finally {
      setSavingParty(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) { toast({ variant: "destructive", title: "Title is required" }); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }

    setSaving(true);
    try {
      const payload = {
        kind,
        title: title.trim(),
        amount: amt,
        currency,
        partyId: partyId ? parseInt(partyId, 10) : null,
        projectId: projectId ? parseInt(projectId, 10) : null,
        category: category.trim() || null,
        interestRate: interestRate ? parseFloat(interestRate) : null,
        dueDate: dueDate || null,
        status,
        notes: notes.trim() || null,
        lateFeeType: needsParty && lateFeeType !== "none" ? lateFeeType : null,
        lateFeeRate: needsParty && lateFeeType !== "none" && lateFeeRate ? parseFloat(lateFeeRate) : null,
        lateFeeGraceDays: needsParty && lateFeeType !== "none" ? (parseInt(lateFeeGraceDays, 10) || 0) : 0,
      };
      if (entry) {
        await financeApi.updateEntry(token, entry.id, payload);
        toast({ title: "Updated" });
      } else {
        await financeApi.createEntry(token, payload);
        toast({ title: "Added" });
      }
      onOpenChange(false);
      onSaved?.();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{entry ? "Edit" : "Add"} Entry</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Title / Reason</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Rafiq loan, Server bill" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{entry ? "Outstanding Amount" : "Amount"}</Label>
              <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
              {entry && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  What's still owed after any repayments — not the original amount.
                </p>
              )}
            </div>
            <div>
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  {CRYPTO_CURRENCY_OPTIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Due Date</Label>
            <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>

          {needsParty && (
            <div>
              <Label>Party (person/lender)</Label>
              {!addingParty ? (
                <Select value={partyId || "none"} onValueChange={v => v === "__new__" ? setAddingParty(true) : setPartyId(v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="Select party" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {parties.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                    <SelectItem value="__new__" className="text-primary">
                      <span className="flex items-center gap-1.5"><UserPlus className="h-3.5 w-3.5" /> New party…</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={newPartyName}
                    onChange={e => setNewPartyName(e.target.value)}
                    placeholder="Party name"
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddParty(); } }}
                  />
                  <Button type="button" size="sm" onClick={handleAddParty} disabled={savingParty || !newPartyName.trim()}>
                    {savingParty ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setAddingParty(false); setNewPartyName(""); }}>Cancel</Button>
                </div>
              )}
            </div>
          )}

          {needsProject && !presetProjectId && (
            <div>
              <Label>Project</Label>
              <Select value={projectId || "none"} onValueChange={v => setProjectId(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === "expense" && (
            <div>
              <Label>Category</Label>
              <Select value={category || undefined} onValueChange={setCategory}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  {category && !(EXPENSE_CATEGORIES as readonly string[]).includes(category) && (
                    <SelectItem value={category}>{category} (legacy)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {needsInterest && (
            <div>
              <Label>Interest Rate (% total)</Label>
              <Input type="number" value={interestRate} onChange={e => setInterestRate(e.target.value)} placeholder="e.g. 10" />
            </div>
          )}

          {needsParty && dueDate && (
            <div className="border border-card-border rounded-lg p-3 space-y-2">
              <Label className="text-sm">Late Fee (auto-calc when overdue)</Label>
              <Select value={lateFeeType} onValueChange={setLateFeeType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Off</SelectItem>
                  <SelectItem value="flat">Flat amount, once</SelectItem>
                  <SelectItem value="daily_percent">% per day overdue</SelectItem>
                  <SelectItem value="monthly_percent">% per 30 days overdue</SelectItem>
                </SelectContent>
              </Select>
              {lateFeeType !== "none" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">{lateFeeType === "flat" ? `Amount (${currency})` : "Rate (%)"}</Label>
                    <Input type="number" value={lateFeeRate} onChange={e => setLateFeeRate(e.target.value)} placeholder={lateFeeType === "flat" ? "e.g. 100" : "e.g. 2"} />
                  </div>
                  <div>
                    <Label className="text-xs">Grace Days</Label>
                    <Input type="number" min={0} value={lateFeeGraceDays} onChange={e => setLateFeeGraceDays(e.target.value)} />
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>

          {entry && (
            <div className="border-t border-border pt-3">
              <FinanceAttachments entryId={entry.id} />
            </div>
          )}
          {!entry && (
            <p className="text-[11px] text-muted-foreground/70 -mt-1">Save this entry first, then reopen it to attach a receipt.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {entry ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
