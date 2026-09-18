/**
 * components/finance/finance-amortization.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Loan amortization schedule for a single borrowed/lending finance entry.
 * If no schedule exists yet, shows a small "Generate" form (term in months);
 * once generated, shows the installment table with a "Mark Paid" action per
 * row — which posts a real repayment + journal lines on the backend.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Loader2, CalendarClock, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry, AmortizationRow } from "@/config/finance";
import { fmtMoney } from "@/config/finance";

export function FinanceAmortization({ entry }: { entry: FinanceEntry }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<AmortizationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [termMonths, setTermMonths] = useState("12");
  const [generating, setGenerating] = useState(false);
  const [payingId, setPayingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    financeApi.listAmortization(token, entry.id)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entry.id]);

  const handleGenerate = async () => {
    const months = parseInt(termMonths, 10);
    if (!months || months < 1) { toast({ variant: "destructive", title: "Term must be at least 1 month" }); return; }
    setGenerating(true);
    try {
      const generated = await financeApi.generateAmortization(token, entry.id, months);
      setRows(generated);
      toast({ title: "Amortization schedule generated" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to generate schedule", description: e?.message });
    } finally {
      setGenerating(false);
    }
  };

  const handlePay = async (id: number) => {
    setPayingId(id);
    try {
      await financeApi.payAmortizationInstallment(token, id);
      load();
      toast({ title: "Installment marked paid" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to mark paid", description: e?.message });
    } finally {
      setPayingId(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          Kono amortization schedule nei — term diye generate koro.
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number" min={1} value={termMonths}
            onChange={e => setTermMonths(e.target.value)}
            placeholder="Term (months)" className="w-32 h-8 text-xs"
          />
          <Button size="sm" onClick={handleGenerate} disabled={generating}>
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Generate
          </Button>
        </div>
      </div>
    );
  }

  const paidCount = rows.filter(r => r.status === "paid").length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Amortization — {paidCount}/{rows.length} paid
        </p>
        <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={handleGenerate} disabled={generating}>
          {generating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Regenerate
        </Button>
      </div>
      <div className="rounded-lg border border-card-border overflow-hidden overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Principal</TableHead>
              <TableHead>Interest</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={r.id} className={cn(r.status === "paid" && "opacity-60")}>
                <TableCell className="font-mono text-xs">{r.installmentNo}</TableCell>
                <TableCell className="text-xs">{new Date(r.dueDate).toLocaleDateString()}</TableCell>
                <TableCell className="font-mono text-xs">{fmtMoney(r.principalDue, entry.currency)}</TableCell>
                <TableCell className="font-mono text-xs">{fmtMoney(r.interestDue, entry.currency)}</TableCell>
                <TableCell className="font-mono text-xs font-semibold">{fmtMoney(r.totalDue, entry.currency)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{fmtMoney(r.remainingBalance, entry.currency)}</TableCell>
                <TableCell>
                  {r.status === "paid" ? (
                    <Badge variant="outline" className="text-success border-success/30 bg-success/10 gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Paid
                    </Badge>
                  ) : (
                    <Button
                      size="sm" variant="outline" className="h-6 text-[11px] px-2"
                      disabled={payingId === r.id}
                      onClick={() => handlePay(r.id)}
                    >
                      {payingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Mark Paid"}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
