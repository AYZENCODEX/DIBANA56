import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, History } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { cn } from "@/lib/utils";

interface Repayment {
  id: number;
  amount: number;
  isInterest: number | boolean;
  notes: string | null;
  paidAt: string;
}

export function FinanceRepaymentDialog({
  open, onOpenChange, entry, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: FinanceEntry | null;
  onSaved?: () => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [isInterest, setIsInterest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Repayment[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (!open || !entry) { setHistory([]); return; }
    setLoadingHistory(true);
    financeApi.listRepayments(token, entry.id)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoadingHistory(false));
  }, [open, entry, token]);

  const handleSave = async () => {
    if (!entry) return;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }
    setSaving(true);
    try {
      const created = await financeApi.addRepayment(token, entry.id, { amount: amt, isInterest });
      setHistory(prev => [created, ...prev]);
      toast({ title: "Payment recorded" });
      setAmount("");
      onSaved?.();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
        {entry && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {entry.title} — remaining {fmtMoney(entry.amount, entry.currency)}
            </p>
            <div>
              <Label>Amount Paid</Label>
              <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="flex gap-1 p-0.5 rounded-md bg-muted/20 w-fit">
              {[["principal", false], ["interest", true]].map(([label, val]) => (
                <button
                  key={label as string}
                  type="button"
                  onClick={() => setIsInterest(val as boolean)}
                  className={cn("px-2.5 py-1 rounded font-mono text-[10px] uppercase tracking-wider transition-all",
                    isInterest === val ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5 mb-2">
                <History className="h-3.5 w-3.5" /> Payment History
              </p>
              {loadingHistory ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : history.length === 0 ? (
                <p className="text-xs text-muted-foreground">Kono payment record kora hoyni ekhono.</p>
              ) : (
                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                  {history.map(h => (
                    <div key={h.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("px-1.5 py-0.5 rounded text-[9px] uppercase font-mono", (h.isInterest === 1 || h.isInterest === true) ? "bg-info-muted text-info" : "bg-success-muted text-success")}>
                          {(h.isInterest === 1 || h.isInterest === true) ? "interest" : "principal"}
                        </span>
                        <span className="text-muted-foreground">{new Date(h.paidAt).toLocaleDateString()}</span>
                      </div>
                      <span className="font-mono font-medium">{fmtMoney(h.amount, entry.currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
