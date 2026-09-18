import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { NotebookPen, Plus, Loader2, Trash2, Minus } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceAccount, JournalEntry } from "@/config/finance";
import { fmtMoney } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { BookSelect } from "@/components/finance/finance-book-select";

interface DraftLine { accountId: string; debit: string; credit: string; }

export default function FinanceJournalPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bookId, setBookId] = useState("");

  const [memo, setMemo] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftLine[]>([
    { accountId: "", debit: "", credit: "" },
    { accountId: "", debit: "", credit: "" },
  ]);

  const accountsById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const load = () => {
    if (authLoading || !token) return;
    setLoading(true);
    Promise.all([financeApi.listJournal(token, bookId ? { bookId } : {}), financeApi.listAccounts(token, bookId ? { bookId } : {})])
      .then(([je, acc]) => { setEntries(je); setAccounts(acc); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, authLoading, bookId]);

  const resetForm = () => {
    setMemo(""); setDate(new Date().toISOString().slice(0, 10));
    setLines([{ accountId: "", debit: "", credit: "" }, { accountId: "", debit: "", credit: "" }]);
  };

  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const handleCreate = async () => {
    if (!memo.trim()) { toast({ variant: "destructive", title: "Memo is required" }); return; }
    const validLines = lines.filter(l => l.accountId && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));
    if (validLines.length < 2) { toast({ variant: "destructive", title: "At least 2 lines are required" }); return; }
    if (!balanced) { toast({ variant: "destructive", title: "Debit and credit must balance" }); return; }

    setSaving(true);
    try {
      await financeApi.createJournalEntry(token, {
        memo: memo.trim(),
        date: new Date(date).toISOString(),
        lines: validLines.map(l => ({ accountId: parseInt(l.accountId, 10), debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0 })),
        bookId: bookId ? Number(bookId) : undefined,
      });
      toast({ title: "Journal entry posted" });
      setDialogOpen(false);
      resetForm();
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to post entry", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await financeApi.deleteJournalEntry(token, id);
      toast({ title: "Journal entry deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to delete", description: e?.message });
    }
  };

  const updateLine = (i: number, patch: Partial<DraftLine>) => {
    setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  };

  if (loading) return <FinanceLoader />;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Accounting" title="Journal"
        description="Every debit/credit posting — auto-posted from Finance entries, plus manual entries"
        actions={
          <div className="flex items-center gap-2">
            <BookSelect value={bookId} onChange={setBookId} />
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Manual Entry
            </Button>
          </div>
        }
      />

      <div className="space-y-2.5">
        <SectionEyebrow icon={NotebookPen}>Entries</SectionEyebrow>
        {entries.length === 0 ? (
          <FinanceEmptyState icon={NotebookPen} title="Kono journal entry nei" description="Finance entry create korle, ba manually post korle ekhane dekhabe." />
        ) : (
          <div className="space-y-2">
            {entries.map(je => (
              <div key={je.id} className="rounded-xl border border-card-border bg-card p-4 elevation-1">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="text-sm font-medium">{je.memo}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(je.date).toLocaleString()}
                      {!je.isManual && <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0">Auto</Badge>}
                    </p>
                  </div>
                  {!!je.isManual && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-danger" onClick={() => handleDelete(je.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <Table>
                  <TableBody>
                    {je.lines.map(l => (
                      <TableRow key={l.id} className="border-0">
                        <TableCell className="py-1 text-xs text-muted-foreground pl-0">
                          {accountsById.get(l.accountId)?.code} — {accountsById.get(l.accountId)?.name ?? `#${l.accountId}`}
                        </TableCell>
                        <TableCell className="py-1 text-xs font-mono text-right">{l.debit > 0 ? fmtMoney(l.debit) : ""}</TableCell>
                        <TableCell className="py-1 text-xs font-mono text-right pr-0">{l.credit > 0 ? fmtMoney(l.credit) : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Manual Journal Entry</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Memo</Label>
                <Input value={memo} onChange={e => setMemo(e.target.value)} placeholder="e.g. Opening balance" />
              </div>
              <div className="space-y-1.5">
                <Label>Date</Label>
                <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Lines</Label>
                <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => setLines(prev => [...prev, { accountId: "", debit: "", credit: "" }])}>
                  <Plus className="h-3 w-3 mr-1" /> Add line
                </Button>
              </div>
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_80px_28px] gap-1.5 items-center">
                  <Select value={l.accountId} onValueChange={(v) => updateLine(i, { accountId: v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Account" /></SelectTrigger>
                    <SelectContent>
                      {accounts.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.code} — {a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input className="h-8 text-xs" type="number" placeholder="Debit" value={l.debit} onChange={e => updateLine(i, { debit: e.target.value, credit: "" })} />
                  <Input className="h-8 text-xs" type="number" placeholder="Credit" value={l.credit} onChange={e => updateLine(i, { credit: e.target.value, debit: "" })} />
                  <Button
                    variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-danger"
                    disabled={lines.length <= 2}
                    onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between text-xs px-1">
              <span className="text-muted-foreground">Total Debit: <span className="font-mono">{fmtMoney(totalDebit)}</span></span>
              <span className="text-muted-foreground">Total Credit: <span className="font-mono">{fmtMoney(totalCredit)}</span></span>
              <Badge variant="outline" className={balanced ? "text-success border-success/30 bg-success/10" : "text-danger border-danger/30 bg-danger/10"}>
                {balanced ? "Balanced" : "Not balanced"}
              </Badge>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving || !balanced}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Post Entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
