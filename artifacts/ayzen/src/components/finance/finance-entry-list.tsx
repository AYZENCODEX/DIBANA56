import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Plus, Pencil, Trash2, Wallet2, ScrollText, Hash, CalendarClock, AlertTriangle, Receipt, Eye } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { FinanceEntryDialog } from "./finance-entry-dialog";
import { FinanceEntryDetailDialog } from "./finance-entry-detail-dialog";
import { FinanceRepaymentDialog } from "./finance-repayment-dialog";
import { FinanceReceiptDialog } from "./finance-receipt-dialog";
import type { FinanceEntry, FinanceKind, FinanceCurrencyRate } from "@/config/finance";
import { fmtMoney, STATUS_STYLES } from "@/config/finance";
import { cn } from "@/lib/utils";
import { FinancePageHeader, StatTile, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { DonutBreakdown, TrendMiniChart, groupByMonth, groupByStatus, groupByCategory, computeEntryStats, rateMapFromCurrencies, type FinanceRateMap } from "@/components/finance/finance-widgets";

function dueBadge(dueDate: string | null) {
  if (!dueDate) return null;
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000);
  if (days < 0) return <Badge className="bg-danger-muted text-danger border-danger/30">Overdue {Math.abs(days)}d</Badge>;
  if (days <= 7) return <Badge className="bg-warning-muted text-warning border-warning/30">Due in {days}d</Badge>;
  return <span className="text-xs text-muted-foreground">{new Date(dueDate).toLocaleDateString()}</span>;
}

export function FinanceEntryList({
  kind, title, description, showRepay = true,
}: {
  kind: FinanceKind;
  title: string;
  description?: string;
  showRepay?: boolean;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [rates, setRates] = useState<FinanceRateMap>({});
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<FinanceEntry | null>(null);
  const [detailEntry, setDetailEntry] = useState<FinanceEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [repayEntry, setRepayEntry] = useState<FinanceEntry | null>(null);
  const [repayOpen, setRepayOpen] = useState(false);
  const [receiptEntry, setReceiptEntry] = useState<FinanceEntry | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    financeApi.listEntries(token, { kind })
      .then(setEntries)
      .catch(() => toast({ variant: "destructive", title: "Failed to load" }))
      .finally(() => setLoading(false));
  }, [token, kind]);

  useEffect(() => { load(); }, [load]);

  // Entries can be booked in different currencies; convert to base currency
  // before summing into totals/charts (see finance-widgets.tsx's toBase for
  // why raw e.amount sums are wrong here).
  useEffect(() => {
    financeApi.listCurrencies(token)
      .then((data: FinanceCurrencyRate[]) => setRates(rateMapFromCurrencies(data)))
      .catch(() => {});
  }, [token]);

  const toBaseAmount = (e: FinanceEntry) => e.amount * (rates[e.currency] ?? 1);
  const totalAmount = entries.reduce((s, e) => s + toBaseAmount(e), 0);
  const pendingAmount = entries.filter(e => e.status !== "paid" && e.status !== "closed").reduce((s, e) => s + toBaseAmount(e), 0);
  const stats = computeEntryStats(entries, rates);
  const hasCategories = entries.some(e => e.category);

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this entry?")) return;
    try {
      await financeApi.deleteEntry(token, id);
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
        title={title}
        description={description}
        actions={<Button onClick={() => { setEditEntry(null); setDialogOpen(true); }} size="sm"><Plus className="h-4 w-4 mr-1.5" /> Add</Button>}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile icon={Wallet2} label="Total" value={fmtMoney(totalAmount)} tone="primary" />
        <StatTile icon={Wallet2} label="Outstanding" value={fmtMoney(pendingAmount)} tone="warning" />
        <StatTile icon={Hash} label="Entries" value={stats.count} tone="neutral" sublabel={`Avg ${fmtMoney(stats.avgAmount)}`} />
        <StatTile icon={CalendarClock} label="This Month" value={fmtMoney(stats.thisMonthAmount)} tone="info" />
      </div>

      {stats.overdueCount > 0 && (
        <div className="rounded-lg border border-danger/30 bg-danger-muted px-3.5 py-2.5 flex items-center gap-2.5 text-sm">
          <AlertTriangle className="h-4 w-4 text-danger shrink-0" />
          <span className="text-danger font-medium">{stats.overdueCount} overdue</span>
          <span className="text-danger/80">— {fmtMoney(stats.overdueAmount)} past due date</span>
        </div>
      )}

      {!loading && entries.length > 0 && (
        <div className="grid lg:grid-cols-3 gap-4">
          <DonutBreakdown title="By Status" data={groupByStatus(entries, rates)} />
          {hasCategories ? (
            <TrendMiniChart title="By Category" data={groupByCategory(entries, rates)} layout="vertical" color="hsl(var(--secondary))" />
          ) : (
            <TrendMiniChart title="Amount Distribution" data={entries.map(e => ({ label: e.title.slice(0, 10), value: toBaseAmount(e) }))} layout="vertical" color="hsl(var(--secondary))" />
          )}
          <TrendMiniChart title="Last 6 Months" data={groupByMonth(entries, 6, rates)} color="hsl(var(--info))" />
        </div>
      )}

      {loading ? (
        <FinanceLoader />
      ) : entries.length === 0 ? (
        <FinanceEmptyState icon={ScrollText} title="No entries yet" description='Click "Add" to create one.' />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(e => (
                <TableRow key={e.id} className="table-row-premium">
                  <TableCell>
                    <p className="font-medium">{e.title}</p>
                    {e.notes && <p className="text-xs text-muted-foreground line-clamp-1">{e.notes}</p>}
                    {e.interestRate != null && <p className="text-xs text-muted-foreground">Interest: {e.interestRate}%{e.interestPaid ? ` · paid ${fmtMoney(e.interestPaid, e.currency)}` : ""}</p>}
                  </TableCell>
                  <TableCell className="font-mono">{fmtMoney(e.amount, e.currency)}</TableCell>
                  <TableCell>{dueBadge(e.dueDate)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("capitalize", STATUS_STYLES[e.status])}>{e.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="View details" onClick={() => { setDetailEntry(e); setDetailOpen(true); }}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    {showRepay && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" title="Record payment" onClick={() => { setRepayEntry(e); setRepayOpen(true); }}>
                        <Wallet2 className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Receipt link" onClick={() => { setReceiptEntry(e); setReceiptOpen(true); }}>
                      <Receipt className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditEntry(e); setDialogOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-danger" onClick={() => handleDelete(e.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FinanceEntryDialog open={dialogOpen} onOpenChange={setDialogOpen} kind={kind} entry={editEntry} onSaved={load} />
      <FinanceEntryDetailDialog open={detailOpen} onOpenChange={setDetailOpen} entry={detailEntry} onEntryChanged={load} />
      <FinanceRepaymentDialog open={repayOpen} onOpenChange={setRepayOpen} entry={repayEntry} onSaved={load} />
      <FinanceReceiptDialog open={receiptOpen} onOpenChange={setReceiptOpen} entry={receiptEntry} />
    </div>
  );
}
