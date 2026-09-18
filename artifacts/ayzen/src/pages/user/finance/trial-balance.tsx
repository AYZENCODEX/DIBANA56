import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Scale } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { TrialBalanceRow, AccountType } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader, StatTile } from "@/components/finance/finance-ui";
import { cn } from "@/lib/utils";

const TYPE_BADGE: Record<AccountType, string> = {
  asset: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  liability: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  equity: "text-violet-400 border-violet-400/30 bg-violet-400/10",
  income: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  expense: "text-red-400 border-red-400/30 bg-red-400/10",
};

export default function FinanceTrialBalancePage() {
  const { token } = useAuth();
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    financeApi.trialBalance(token).then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <FinanceLoader />;

  const totalDebit = rows.reduce((s, r) => s + r.totalDebit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.totalCredit, 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader eyebrow="Finance · Accounting · Reports" title="Trial Balance" description="Total debit vs credit across every account" />

      <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
        <StatTile icon={Scale} label="Total Debit" value={fmtMoney(totalDebit)} tone="info" />
        <StatTile icon={Scale} label="Total Credit" value={fmtMoney(totalCredit)} tone="info" />
        <StatTile icon={Scale} label="Status" value={isBalanced ? "Balanced" : "Off"} tone={isBalanced ? "success" : "danger"} />
      </div>

      <div className="space-y-2.5">
        <SectionEyebrow icon={Scale}>Accounts</SectionEyebrow>
        {rows.length === 0 ? (
          <FinanceEmptyState icon={Scale} title="Kono journal activity nei" description="Finance entry create korle ba manual journal post korle ekhane dekhabe." />
        ) : (
          <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Debit</TableHead>
                  <TableHead>Credit</TableHead>
                  <TableHead>Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.accountId} className="table-row-premium">
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.code}</TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell><Badge variant="outline" className={cn("capitalize", TYPE_BADGE[r.type])}>{r.type}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{r.totalDebit > 0 ? fmtMoney(r.totalDebit) : ""}</TableCell>
                    <TableCell className="font-mono text-xs">{r.totalCredit > 0 ? fmtMoney(r.totalCredit) : ""}</TableCell>
                    <TableCell className="font-mono text-xs font-semibold">{fmtMoney(r.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
