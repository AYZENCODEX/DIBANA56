import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { LineChart, TrendingUp, TrendingDown } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { IncomeStatementReport } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader, StatTile, FinanceCard } from "@/components/finance/finance-ui";

export default function FinanceIncomeStatementPage() {
  const { token } = useAuth();
  const [report, setReport] = useState<IncomeStatementReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    financeApi.incomeStatement(token).then(setReport).catch(() => setReport(null)).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <FinanceLoader />;
  if (!report) return <FinanceEmptyState icon={LineChart} title="Report load kora jayni" />;

  const hasAny = report.income.length + report.expense.length > 0;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader eyebrow="Finance · Accounting · Reports" title="Income Statement" description="Income − Expense over all recorded journal activity" />

      <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
        <StatTile icon={TrendingUp} label="Total Income" value={fmtMoney(report.totalIncome)} tone="success" />
        <StatTile icon={TrendingDown} label="Total Expense" value={fmtMoney(report.totalExpense)} tone="danger" />
        <StatTile
          icon={report.netIncome >= 0 ? TrendingUp : TrendingDown}
          label="Net Income" value={fmtMoney(report.netIncome)}
          tone={report.netIncome >= 0 ? "success" : "danger"}
        />
      </div>

      {!hasAny ? (
        <FinanceEmptyState icon={LineChart} title="Kono income/expense journal activity nei" description="Finance entry create korle ekhane dekhabe." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2.5">
            <SectionEyebrow icon={TrendingUp}>Income</SectionEyebrow>
            <FinanceCard>
              <Table><TableBody>
                {report.income.map(r => (
                  <TableRow key={r.accountId} className="border-0">
                    <TableCell className="py-1.5 pl-0 text-sm">{r.code} — {r.name}</TableCell>
                    <TableCell className="py-1.5 pr-0 text-right font-mono text-sm text-success">{fmtMoney(r.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody></Table>
            </FinanceCard>
          </div>
          <div className="space-y-2.5">
            <SectionEyebrow icon={TrendingDown}>Expense</SectionEyebrow>
            <FinanceCard>
              <Table><TableBody>
                {report.expense.map(r => (
                  <TableRow key={r.accountId} className="border-0">
                    <TableCell className="py-1.5 pl-0 text-sm">{r.code} — {r.name}</TableCell>
                    <TableCell className="py-1.5 pr-0 text-right font-mono text-sm text-danger">{fmtMoney(r.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody></Table>
            </FinanceCard>
          </div>
        </div>
      )}
    </div>
  );
}
