import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, PieChart } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceBudget } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinancePageHeader, FinanceCard, FinanceProgress, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

function BudgetDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setCategory(""); setLimit(""); } }, [open]);

  const save = async () => {
    if (!category.trim() || !limit) { toast({ variant: "destructive", title: "Category and limit are required" }); return; }
    setSaving(true);
    try {
      await financeApi.saveBudget(token, { category: category.trim(), monthlyLimit: parseFloat(limit) });
      toast({ title: "Saved" });
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Set Budget</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Category</Label>
            <Input value={category} onChange={e => setCategory(e.target.value)} placeholder="Infra / Team / Marketing / Personal" />
          </div>
          <div>
            <Label>Monthly Limit</Label>
            <Input type="number" value={limit} onChange={e => setLimit(e.target.value)} placeholder="0" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FinanceBudgetsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [budgets, setBudgets] = useState<FinanceBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    financeApi.listBudgets(token).then(setBudgets).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this budget?")) return;
    try {
      await financeApi.deleteBudget(token, id);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Budgets"
        description="Category-wise monthly cap — this month's Expenses against it"
        actions={<Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Set Budget</Button>}
      />

      {loading ? (
        <FinanceLoader />
      ) : budgets.length === 0 ? (
        <FinanceEmptyState icon={PieChart} title="Kono budget set kora hoyni" description="Ekta category er jonno monthly limit set koro." />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {budgets.map((b, i) => {
            const pct = b.monthlyLimit > 0 ? Math.min(100, (b.spent / b.monthlyLimit) * 100) : 0;
            const over = b.spent > b.monthlyLimit;
            const tone = over ? "danger" : pct > 80 ? "warning" : "success";
            return (
              <FinanceCard key={b.id} className="animate-fade-up space-y-3" hover>
                <div className="flex items-start justify-between">
                  <p className="font-semibold">{b.category}</p>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-danger" onClick={() => handleDelete(b.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                <FinanceProgress pct={pct} tone={tone} />
                <div className="flex justify-between text-xs">
                  <span className={cn("font-mono", over ? "text-danger font-semibold" : "text-muted-foreground")}>{fmtMoney(b.spent)} spent</span>
                  <span className="text-muted-foreground font-mono">of {fmtMoney(b.monthlyLimit)}</span>
                </div>
                {over && <p className="text-[11px] text-danger">Over budget by {fmtMoney(b.spent - b.monthlyLimit)}</p>}
              </FinanceCard>
            );
          })}
        </div>
      )}

      <BudgetDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />
    </div>
  );
}
