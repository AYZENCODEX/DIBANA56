import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { Landmark, CircleCheck, CircleAlert } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { BalanceSheetReport } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader, StatTile, FinanceCard } from "@/components/finance/finance-ui";

export default function FinanceBalanceSheetPage() {
  const { token } = useAuth();
  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    financeApi.balanceSheet(token).then(setReport).catch(() => setReport(null)).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <FinanceLoader />;
  if (!report) return <FinanceEmptyState icon={Landmark} title="Report load kora jayni" />;

  const hasAny = report.assets.length + report.liabilities.length + report.equity.length > 0;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader eyebrow="Finance · Accounting · Reports" title="Balance Sheet" description="Assets = Liabilities + Equity" />

      <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
        <StatTile icon={Landmark} label="Total Assets" value={fmtMoney(report.totalAssets)} tone="success" />
        <StatTile icon={Landmark} label="Total Liabilities" value={fmtMoney(report.totalLiabilities)} tone="warning" />
        <StatTile icon={Landmark} label="Total Equity" value={fmtMoney(report.totalEquity)} tone="info" />
      </div>

      <FinanceCard className="flex items-center gap-2">
        {report.balanced ? <CircleCheck className="h-4 w-4 text-success" /> : <CircleAlert className="h-4 w-4 text-danger" />}
        <span className="text-sm">
          {report.balanced
            ? "Sheet balanced: Assets = Liabilities + Equity"
            : `Off by ${fmtMoney(Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)))}`}
        </span>
      </FinanceCard>

      {!hasAny ? (
        <FinanceEmptyState icon={Landmark} title="Kono account balance nei" description="Finance entry create korle ekhane dekhabe." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2.5">
            <SectionEyebrow icon={Landmark}>Assets</SectionEyebrow>
            <FinanceCard>
              <Table><TableBody>
                {report.assets.map(r => (
                  <TableRow key={r.accountId} className="border-0">
                    <TableCell className="py-1.5 pl-0 text-sm">{r.code} — {r.name}</TableCell>
                    <TableCell className="py-1.5 pr-0 text-right font-mono text-sm">{fmtMoney(r.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody></Table>
            </FinanceCard>
          </div>
          <div className="space-y-4">
            <div className="space-y-2.5">
              <SectionEyebrow icon={Landmark}>Liabilities</SectionEyebrow>
              <FinanceCard>
                <Table><TableBody>
                  {report.liabilities.map(r => (
                    <TableRow key={r.accountId} className="border-0">
                      <TableCell className="py-1.5 pl-0 text-sm">{r.code} — {r.name}</TableCell>
                      <TableCell className="py-1.5 pr-0 text-right font-mono text-sm">{fmtMoney(r.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody></Table>
              </FinanceCard>
            </div>
            <div className="space-y-2.5">
              <SectionEyebrow icon={Landmark}>Equity</SectionEyebrow>
              <FinanceCard>
                <Table><TableBody>
                  {report.equity.map(r => (
                    <TableRow key={r.accountId} className="border-0">
                      <TableCell className="py-1.5 pl-0 text-sm">{r.code} — {r.name}</TableCell>
                      <TableCell className="py-1.5 pr-0 text-right font-mono text-sm">{fmtMoney(r.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody></Table>
              </FinanceCard>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
