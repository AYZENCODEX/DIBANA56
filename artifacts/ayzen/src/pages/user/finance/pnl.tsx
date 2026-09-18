import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { TrendingUp, TrendingDown, Layers, Sparkles } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinancePageHeader, StatTile, SectionEyebrow, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { Button } from "@/components/ui/button";
import { ReceiptLinkDialog } from "@/components/receipt-link-dialog";
import { projectPnlReceiptApi } from "@/lib/receipt-api";

interface ProjectRow { projectId: number; projectName: string; invested: number; spent: number; earned: number; netPnl: number; netPosition: number; }
interface Summary { totalIncome: number; totalExpense: number; interestPaid: number; }

export default function FinancePnlPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [receiptProjectId, setReceiptProjectId] = useState<number | null>(null);
  const [receiptProjectName, setReceiptProjectName] = useState<string>("");

  useEffect(() => {
    if (authLoading || !token) return;
    Promise.all([financeApi.investments(token), financeApi.summary(token)])
      .then(([inv, sum]) => { setRows(inv); setSummary(sum); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, authLoading]);

  const overallPnl = summary ? summary.totalIncome - summary.totalExpense - summary.interestPaid : 0;
  const projectPnl = rows.reduce((s, r) => s + r.netPnl, 0);

  if (loading) return <FinanceLoader />;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader eyebrow="Finance" title="Profit & Loss" description="Overall + per-project breakdown" />

      <div className="grid grid-cols-2 gap-3 sm:max-w-lg">
        <StatTile
          icon={overallPnl >= 0 ? TrendingUp : TrendingDown}
          label="Overall PnL"
          value={fmtMoney(overallPnl)}
          tone={overallPnl >= 0 ? "success" : "danger"}
          sublabel="Income − Expense − Interest Paid"
        />
        <StatTile icon={Layers} label="Project PnL (sum)" value={fmtMoney(projectPnl)} tone={projectPnl >= 0 ? "success" : "danger"} />
      </div>

      <div className="space-y-2.5">
        <SectionEyebrow icon={Layers}>Per-Project</SectionEyebrow>
        {rows.length === 0 ? (
          <FinanceEmptyState icon={Layers} title="Kono project-linked data nei" description="Investment entry-te projectId shoho add korle ekhane dekhabe." />
        ) : (
          <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Earned</TableHead>
                  <TableHead>Spent</TableHead>
                  <TableHead>Net PnL</TableHead>
                  <TableHead>%</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => {
                  const pct = r.spent > 0 ? (r.netPnl / r.spent) * 100 : r.earned > 0 ? 100 : 0;
                  return (
                    <TableRow key={r.projectId} className="table-row-premium">
                      <TableCell className="font-medium">{r.projectName}</TableCell>
                      <TableCell className="font-mono">{fmtMoney(r.earned)}</TableCell>
                      <TableCell className="font-mono">{fmtMoney(r.spent)}</TableCell>
                      <TableCell className={cn("font-mono font-semibold", r.netPnl >= 0 ? "text-success" : "text-danger")}>{fmtMoney(r.netPnl)}</TableCell>
                      <TableCell className={cn("font-mono", pct >= 0 ? "text-success" : "text-danger")}>{pct.toFixed(1)}%</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-primary"
                          title="Share receipt"
                          onClick={() => { setReceiptProjectId(r.projectId); setReceiptProjectName(r.projectName); }}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <ReceiptLinkDialog
        open={receiptProjectId !== null}
        onOpenChange={(open) => { if (!open) setReceiptProjectId(null); }}
        itemId={receiptProjectId}
        itemLabel={receiptProjectName}
        api={projectPnlReceiptApi}
        title="Share Project P&L Receipt"
      />
    </div>
  );
}
