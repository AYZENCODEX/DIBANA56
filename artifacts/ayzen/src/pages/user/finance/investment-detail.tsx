import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ArrowLeft, Plus, Trash2, Pencil, TrendingUp, TrendingDown, Wallet, ScrollText } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { FinanceEntryDialog } from "@/components/finance/finance-entry-dialog";
import type { FinanceEntry, FinanceKind } from "@/config/finance";
import { fmtMoney, KIND_LABELS } from "@/config/finance";
import { cn } from "@/lib/utils";
import { StatTile, FinanceCard, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

export default function FinanceInvestmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id, 10);
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKind, setDialogKind] = useState<FinanceKind>("investment");
  const [editEntry, setEditEntry] = useState<FinanceEntry | null>(null);

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    Promise.all([
      financeApi.listEntries(token, { kind: "investment", projectId: id }),
      financeApi.listEntries(token, { kind: "expense", projectId: id }),
      financeApi.listEntries(token, { kind: "income", projectId: id }),
    ]).then(([inv, exp, inc]) => {
      const all = [...inv, ...exp, ...inc].sort((a, b) => new Date(b.occurredDate).getTime() - new Date(a.occurredDate).getTime());
      setEntries(all);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading, id]);

  useEffect(() => { load(); }, [load]);

  const invested = entries.filter(e => e.kind === "investment").reduce((s, e) => s + e.amount, 0);
  const spent = entries.filter(e => e.kind === "expense").reduce((s, e) => s + e.amount, 0);
  const earned = entries.filter(e => e.kind === "income").reduce((s, e) => s + e.amount, 0);
  const netPnl = earned - spent;
  const netPosition = invested - spent + earned;

  const openAdd = (kind: FinanceKind) => { setDialogKind(kind); setEditEntry(null); setDialogOpen(true); };
  const openEdit = (e: FinanceEntry) => { setDialogKind(e.kind); setEditEntry(e); setDialogOpen(true); };

  const handleDelete = async (entryId: number) => {
    if (!confirm("Delete this entry?")) return;
    try {
      await financeApi.deleteEntry(token, entryId);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <Link href="/finance/investments" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Investments
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.16em] uppercase text-primary/70 mb-1">Finance · Investment</p>
          <h1 className="text-2xl font-bold tracking-tight gradient-text-primary">Project #{projectId}</h1>
          <p className="text-sm text-muted-foreground mt-1">Amount given, spent, earned, o net position</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => openAdd("investment")}><Plus className="h-4 w-4 mr-1" /> Invest</Button>
          <Button size="sm" variant="outline" onClick={() => openAdd("expense")}><Plus className="h-4 w-4 mr-1" /> Spend</Button>
          <Button size="sm" variant="outline" onClick={() => openAdd("income")}><Plus className="h-4 w-4 mr-1" /> Earn</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile icon={Wallet} label="Invested" value={fmtMoney(invested)} tone="primary" />
        <StatTile icon={TrendingDown} label="Spent" value={fmtMoney(spent)} tone="danger" />
        <StatTile icon={TrendingUp} label="Earned" value={fmtMoney(earned)} tone="success" />
        <StatTile icon={netPnl >= 0 ? TrendingUp : TrendingDown} label="Net PnL" value={fmtMoney(netPnl)} tone={netPnl >= 0 ? "success" : "danger"} />
      </div>

      <FinanceCard className="flex items-center gap-2 w-fit" hover={false}>
        <Wallet className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Net Position:</span>
        <span className="font-mono font-bold">{fmtMoney(netPosition)}</span>
      </FinanceCard>

      <h2 className="text-xs font-semibold tracking-[0.1em] uppercase text-muted-foreground pt-2">Timeline</h2>
      {loading ? (
        <FinanceLoader />
      ) : entries.length === 0 ? (
        <FinanceEmptyState icon={ScrollText} title="Kono entry nei ekhono" />
      ) : (
        <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(e => (
                <TableRow key={e.id} className="table-row-premium">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(e.occurredDate).toLocaleDateString()}</TableCell>
                  <TableCell><Badge variant="outline">{KIND_LABELS[e.kind]}</Badge></TableCell>
                  <TableCell className="font-medium">{e.title}</TableCell>
                  <TableCell className={cn("font-mono", e.kind === "expense" ? "text-danger" : e.kind === "income" ? "text-success" : "")}>
                    {fmtMoney(e.amount, e.currency)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(e)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-danger" onClick={() => handleDelete(e.id)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FinanceEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        kind={dialogKind}
        entry={editEntry}
        presetProjectId={projectId}
        onSaved={load}
      />
    </div>
  );
}
