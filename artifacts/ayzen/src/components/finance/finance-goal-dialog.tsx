/**
 * components/finance/finance-goal-dialog.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Create/edit dialog for a Financial Goal. When linked to an Asset, the
 * "Current Amount" field is disabled — its value auto-syncs from the asset
 * (see lib/finance-networth.ts syncGoalProgress on the backend), so editing
 * it here would just be overwritten on the next fetch.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceGoal, GoalType, FinanceAsset } from "@/config/finance";
import { GOAL_TYPE_LABELS, CURRENCY_OPTIONS, CRYPTO_CURRENCY_OPTIONS } from "@/config/finance";

export function FinanceGoalDialog({
  open, onOpenChange, goal, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: FinanceGoal | null;
  onSaved?: () => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [goalType, setGoalType] = useState<GoalType>("savings");
  const [targetAmount, setTargetAmount] = useState("");
  const [currentAmount, setCurrentAmount] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [targetDate, setTargetDate] = useState("");
  const [linkedAssetId, setLinkedAssetId] = useState<string>("__none");
  const [notes, setNotes] = useState("");
  const [assets, setAssets] = useState<FinanceAsset[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(goal?.title ?? "");
    setGoalType(goal?.goalType ?? "savings");
    setTargetAmount(goal ? String(goal.targetAmount) : "");
    setCurrentAmount(goal ? String(goal.currentAmount) : "0");
    setCurrency(goal?.currency ?? "BDT");
    setTargetDate(goal?.targetDate ? goal.targetDate.slice(0, 10) : "");
    setLinkedAssetId(goal?.linkedAssetId != null ? String(goal.linkedAssetId) : "__none");
    setNotes(goal?.notes ?? "");
    financeApi.listAssets(token).then(setAssets).catch(() => setAssets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal]);

  const isLinked = linkedAssetId !== "__none";

  const handleSave = async () => {
    if (!title.trim()) { toast({ variant: "destructive", title: "Title is required" }); return; }
    const target = parseFloat(targetAmount);
    if (!target || target <= 0) { toast({ variant: "destructive", title: "Enter a valid target amount" }); return; }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        goalType,
        targetAmount: target,
        currentAmount: isLinked ? 0 : (parseFloat(currentAmount) || 0),
        currency: isLinked ? "BDT" : currency,
        targetDate: targetDate || null,
        linkedAssetId: isLinked ? Number(linkedAssetId) : null,
        notes: notes.trim() || null,
      };
      if (goal) {
        await financeApi.updateGoal(token, goal.id, payload);
        toast({ title: "Updated" });
      } else {
        await financeApi.createGoal(token, payload);
        toast({ title: "Goal created" });
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
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{goal ? "Edit" : "New"} Goal</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Emergency Fund, Pay off credit card" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={goalType} onValueChange={v => setGoalType(v as GoalType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(GOAL_TYPE_LABELS) as GoalType[]).map(t => (
                    <SelectItem key={t} value={t}>{GOAL_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Target Date (optional)</Label>
              <Input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Target Amount</Label>
              <Input type="number" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} />
            </div>
            <div>
              <Label>Currency {isLinked && <span className="text-muted-foreground font-normal">(asset-linked, always base)</span>}</Label>
              <Select value={isLinked ? "BDT" : currency} onValueChange={setCurrency} disabled={isLinked}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[...CURRENCY_OPTIONS, ...CRYPTO_CURRENCY_OPTIONS].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Current Amount {isLinked && <span className="text-muted-foreground font-normal">(auto from asset)</span>}</Label>
              <Input type="number" value={isLinked ? "" : currentAmount} onChange={e => setCurrentAmount(e.target.value)} disabled={isLinked} placeholder={isLinked ? "Synced automatically" : "0"} />
            </div>
          </div>

          <div>
            <Label>Link to an Asset (optional)</Label>
            <Select value={linkedAssetId} onValueChange={setLinkedAssetId}>
              <SelectTrigger><SelectValue placeholder="No linked asset — track manually" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No linked asset — track manually</SelectItem>
                {assets.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Linked hole goal-er progress oi asset-er value theke automatically update hobe (always in the base currency — assets don't carry their own currency).</p>
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {goal ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
