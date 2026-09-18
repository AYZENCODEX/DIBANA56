import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { ArrowLeftRight, TrendingUp, TrendingDown, Landmark, CircleCheck, CircleAlert } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { CashFlowReport } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader, StatTile, FinanceCard } from "@/components/finance/finance-ui";

export default function FinanceCashFlowPage() {
  const { token } = useAuth();
  const [report, setReport] = useState<CashFlowReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    financeApi.cashFlow(token).then(setReport).catch(() => setReport(null)).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <FinanceLoader />;
  if (!report) return <FinanceEmptyState icon={ArrowLeftRight} title="Report load kora jayni" />;

  const hasAny = report.operatingActivities.length + report.investingActivities.length + report.financingActivities.length > 0;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Accounting · Reports"
        title="Cash Flow Statement"
        description="Indirect method — net income theke shuru kore Operating, Investing, Financing activities-e cash movement"
      />

      <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
        <StatTile
          icon={report.netChangeInCash >= 0 ? TrendingUp : TrendingDown}
          label="Net Change in Cash" value={fmtMoney(report.netChangeInCash)}
          tone={report.netChangeInCash >= 0 ? "success" : "danger"}
        />
        <StatTile icon={Landmark} label="Beginning Cash" value={fmtMoney(report.beginningCash)} tone="info" />
        <StatTile icon={Landmark} label="Ending Cash" value={fmtMoney(report.endingCash)} tone="info" />
      </div>

      <FinanceCard className="flex items-center gap-2">
        {report.reconciled ? <CircleCheck className="h-4 w-4 text-success" /> : <CircleAlert className="h-4 w-4 text-danger" />}
        <span className="text-sm">
          {report.reconciled
            ? "Reconciled: Beginning Cash + Net Change = Ending Cash"
            : `Off by ${fmtMoney(Math.abs((report.endingCash - report.beginningCash) - report.netChangeInCash))}`}
        </span>
      </FinanceCard>

      {!hasAny ? (
        <FinanceEmptyState icon={ArrowLeftRight} title="Kono journal activity nei" description="Finance entry create korle ekhane dekhabe." />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2.5">
            <SectionEyebrow icon={ArrowLeftRight}>Operating Activities</SectionEyebrow>
            <FinanceCard>
              <Table><TableBody>
                {report.operatingActivities.map((r, i) => (
                  <TableRow key={i} className="border-0">
                    <TableCell className="py-1.5 pl-0 text-sm">{r.label}</TableCell>
                    <TableCell className="py-1.5 pr-0 text-right font-mono text-sm">{fmtMoney(r.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-0 border-t">
                  <TableCell className="py-1.5 pl-0 text-sm font-medium">Net Cash from Operating</TableCell>
                  <TableCell className="py-1.5 pr-0 text-right font-mono text-sm font-medium">{fmtMoney(report.netOperating)}</TableCell>
                </TableRow>
              </TableBody></Table>
            </FinanceCard>
          </div>
          <div className="space-y-2.5">
            <SectionEyebrow icon={ArrowLeftRight}>Investing Activities</SectionEyebrow>
            <FinanceCard>
              <Table><TableBody>
                {report.investingActivities.map((r, i) => (
                  <TableRow key={i} className="border-0">
                    <TableCell className="py-1.5 pl-0 text-sm">{r.label}</TableCell>
                    <TableCell className="py-1.5 pr-0 text-right font-mono text-sm">{fmtMoney(r.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-0 border-t">
                  <TableCell className="py-1.5 pl-0 text-sm font-medium">Net Cash from Investing</TableCell>
                  <TableCell className="py-1.5 pr-0 text-right font-mono text-sm font-medium">{fmtMoney(report.netInvesting)}</TableCell>
                </TableRow>
              </TableBody></Table>
            </FinanceCard>
          </div>
          <div className="space-y-2.5">
            <SectionEyebrow icon={ArrowLeftRight}>Financing Activities</SectionEyebrow>
            <FinanceCard>
              <Table><TableBody>
                {report.financingActivities.map((r, i) => (
                  <TableRow key={i} className="border-0">
                    <TableCell className="py-1.5 pl-0 text-sm">{r.label}</TableCell>
                    <TableCell className="py-1.5 pr-0 text-right font-mono text-sm">{fmtMoney(r.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-0 border-t">
                  <TableCell className="py-1.5 pl-0 text-sm font-medium">Net Cash from Financing</TableCell>
                  <TableCell className="py-1.5 pr-0 text-right font-mono text-sm font-medium">{fmtMoney(report.netFinancing)}</TableCell>
                </TableRow>
              </TableBody></Table>
            </FinanceCard>
          </div>
        </div>
      )}
    </div>
  );
}
