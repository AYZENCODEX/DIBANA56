import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Percent } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry } from "@/config/finance";
import { fmtMoney, KIND_LABELS } from "@/config/finance";
import { FinancePageHeader, StatTile, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

export default function FinanceInterestPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !token) return;
    Promise.all([
      financeApi.listEntries(token, { kind: "borrowed" }),
      financeApi.listEntries(token, { kind: "lending" }),
      financeApi.listEntries(token, { kind: "investment" }),
    ]).then(([b, l, i]) => setEntries([...b, ...l, ...i].filter(e => e.interestRate != null)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, authLoading]);

  const totalPaid = entries.reduce((s, e) => s + e.interestPaid, 0);
  const totalOwed = entries.reduce((s, e) => s + Math.max(0, ((e.interestRate ?? 0) / 100) * e.amount - e.interestPaid), 0);

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader eyebrow="Finance" title="Interest Tracker" description="Paid / owed / projected — sob interest ekjaigay" />

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <StatTile icon={Percent} label="Interest Paid" value={fmtMoney(totalPaid)} tone="success" />
        <StatTile icon={Percent} label="Interest Owed" value={fmtMoney(totalOwed)} tone="warning" />
      </div>

      {loading ? (
        <FinanceLoader />
      ) : entries.length === 0 ? (
        <FinanceEmptyState icon={Percent} title="Interest rate shoho kono entry nei ekhono" description="Borrowed / Lending / Investment e rate add koro." />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead>Owed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(e => {
                const totalInterest = ((e.interestRate ?? 0) / 100) * e.amount;
                const owed = Math.max(0, totalInterest - e.interestPaid);
                return (
                  <TableRow key={e.id} className="table-row-premium">
                    <TableCell className="font-medium">{e.title}</TableCell>
                    <TableCell><Badge variant="outline">{KIND_LABELS[e.kind]}</Badge></TableCell>
                    <TableCell className="font-mono flex items-center gap-0.5"><Percent className="h-3 w-3" />{e.interestRate}</TableCell>
                    <TableCell className="font-mono text-success">{fmtMoney(e.interestPaid, e.currency)}</TableCell>
                    <TableCell className="font-mono text-warning">{fmtMoney(owed, e.currency)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
