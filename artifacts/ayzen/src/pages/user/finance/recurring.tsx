import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Plus, Pencil, Trash2, Loader2, RefreshCw, Repeat } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { FinanceRecurringDialog } from "@/components/finance/finance-recurring-dialog";
import type { FinanceRecurringRule } from "@/config/finance";
import { fmtMoney, KIND_LABELS, FREQUENCY_LABELS } from "@/config/finance";
import { FinancePageHeader, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

export default function FinanceRecurringPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [rules, setRules] = useState<FinanceRecurringRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editRule, setEditRule] = useState<FinanceRecurringRule | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    financeApi.listRecurring(token).then(setRules).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (rule: FinanceRecurringRule) => {
    try {
      await financeApi.updateRecurring(token, rule.id, { active: !rule.active });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this recurring rule? Past generated entries stay in the ledger.")) return;
    try {
      await financeApi.deleteRecurring(token, id);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const result = await financeApi.runRecurringNow(token);
      toast({ title: `Swept ${result.rulesChecked} rule(s)`, description: `${result.entriesCreated} new entr${result.entriesCreated === 1 ? "y" : "ies"} created` });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance"
        title="Recurring Transactions"
        description="Monthly rent, salary, hosting — auto-generate ledger entries on schedule (runs daily at 00:15)"
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={runNow} disabled={running}>
              {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              Run Now
            </Button>
            <Button size="sm" onClick={() => { setEditRule(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" /> Add Rule
            </Button>
          </div>
        }
      />

      {loading ? (
        <FinanceLoader />
      ) : rules.length === 0 ? (
        <FinanceEmptyState icon={Repeat} title="Kono recurring rule nei ekhono" description={'"Add Rule" diye monthly khoroch/income set koro.'} />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map(r => (
                <TableRow key={r.id} className="table-row-premium">
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell><Badge variant="outline">{KIND_LABELS[r.kind]}</Badge></TableCell>
                  <TableCell className="font-mono">{fmtMoney(r.amount, r.currency)}</TableCell>
                  <TableCell>{r.intervalCount > 1 ? `Every ${r.intervalCount} ${FREQUENCY_LABELS[r.frequency].toLowerCase()}` : FREQUENCY_LABELS[r.frequency]}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(r.nextRunDate).toLocaleDateString()}</TableCell>
                  <TableCell><Switch checked={r.active} onCheckedChange={() => toggleActive(r)} /></TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditRule(r); setDialogOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-danger" onClick={() => handleDelete(r.id)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FinanceRecurringDialog open={dialogOpen} onOpenChange={setDialogOpen} rule={editRule} onSaved={load} />
    </div>
  );
}
