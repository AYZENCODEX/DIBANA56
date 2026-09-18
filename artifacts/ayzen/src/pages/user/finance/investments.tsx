import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Boxes, Wallet, TrendingUp, TrendingDown, PiggyBank } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinancePageHeader, StatTile, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { DonutBreakdown, DualBarChart } from "@/components/finance/finance-widgets";

interface ProjectRow {
  projectId: number; projectName: string;
  invested: number; spent: number; earned: number; netPnl: number; netPosition: number;
}

export default function FinanceInvestmentsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !token) return;
    financeApi.investments(token).then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  const totalInvested = rows.reduce((s, r) => s + r.invested, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const totalEarned = rows.reduce((s, r) => s + r.earned, 0);
  const totalNetPnl = rows.reduce((s, r) => s + r.netPnl, 0);
  const allocationData = rows.map(r => ({ label: r.projectName, value: r.invested }));
  const dualBarData = rows.map(r => ({ label: r.projectName, invested: r.invested, earned: r.earned }));

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader eyebrow="Finance" title="Investments" description="Project-wise invest / spend / earn tracking" />

      {!loading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile icon={PiggyBank} label="Total Invested" value={fmtMoney(totalInvested)} tone="secondary" />
            <StatTile icon={TrendingDown} label="Total Spent" value={fmtMoney(totalSpent)} tone="danger" />
            <StatTile icon={TrendingUp} label="Total Earned" value={fmtMoney(totalEarned)} tone="success" />
            <StatTile icon={Wallet} label="Net PnL" value={fmtMoney(totalNetPnl)} tone={totalNetPnl >= 0 ? "success" : "danger"} />
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <DualBarChart title="Invested vs Earned per Project" data={dualBarData} seriesA={{ key: "invested", label: "Invested" }} seriesB={{ key: "earned", label: "Earned" }} />
            <DonutBreakdown title="Invested Distribution" data={allocationData} />
          </div>
        </>
      )}

      {loading ? (
        <FinanceLoader />
      ) : rows.length === 0 ? (
        <FinanceEmptyState icon={Boxes} title="Kono project-linked investment nei ekhono" description="Ekta entry add koro projectId shoho." />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Invested</TableHead>
                <TableHead>Spent</TableHead>
                <TableHead>Earned</TableHead>
                <TableHead>Net PnL</TableHead>
                <TableHead>Net Position</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.projectId} className="table-row-premium cursor-pointer">
                  <TableCell>
                    <Link href={`/finance/investments/${r.projectId}`} className="font-medium text-primary hover:underline">
                      {r.projectName}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono">{fmtMoney(r.invested)}</TableCell>
                  <TableCell className="font-mono">{fmtMoney(r.spent)}</TableCell>
                  <TableCell className="font-mono">{fmtMoney(r.earned)}</TableCell>
                  <TableCell className={cn("font-mono font-semibold", r.netPnl >= 0 ? "text-success" : "text-danger")}>{fmtMoney(r.netPnl)}</TableCell>
                  <TableCell className="font-mono">{fmtMoney(r.netPosition)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
