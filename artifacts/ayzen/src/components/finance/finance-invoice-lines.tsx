/**
 * components/finance/finance-invoice-lines.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Line-item editor for a 'receivable' entry — description/qty/unit price/tax%
 * per row, computed line + grand totals. Saving PUTs the full line set,
 * which recomputes entry.amount and reposts the journal on the backend (see
 * PUT /finance/entries/:id/invoice-lines). Once saved, the entry's public
 * receipt link (finance-receipt-dialog.tsx) renders these as an itemized
 * Invoice PDF automatically — no separate "share invoice" step needed.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Loader2, Plus, Trash2, Receipt } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry, InvoiceLine } from "@/config/finance";
import { fmtMoney } from "@/config/finance";

const emptyLine = (): InvoiceLine => ({ description: "", quantity: 1, unitPrice: 0, taxPercent: 0 });

export function FinanceInvoiceLines({ entry, onEntryChanged }: { entry: FinanceEntry; onEntryChanged?: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = () => {
    setLoading(true);
    financeApi.listInvoiceLines(token, entry.id)
      .then((rows: InvoiceLine[]) => { setLines(rows); setEditing(rows.length === 0); })
      .catch(() => setLines([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entry.id]);

  const updateLine = (i: number, patch: Partial<InvoiceLine>) =>
    setLines(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, emptyLine()]);
  const removeLine = (i: number) => setLines(ls => ls.filter((_, idx) => idx !== i));

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const taxTotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxPercent / 100), 0);
  const grandTotal = subtotal + taxTotal;

  const handleSave = async () => {
    const clean = lines.filter(l => l.description.trim());
    if (clean.length === 0) { toast({ variant: "destructive", title: "At least one line item is required" }); return; }
    setSaving(true);
    try {
      await financeApi.saveInvoiceLines(token, entry.id, clean.map(l => ({
        description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxPercent: l.taxPercent,
      })));
      toast({ title: "Invoice saved", description: `Total updated to ${fmtMoney(grandTotal, entry.currency)}` });
      setEditing(false);
      onEntryChanged?.();
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to save invoice", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  if (entry.kind !== "receivable") return null;

  if (loading) {
    return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }

  if (!editing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex items-center gap-1.5">
            <Receipt className="h-3 w-3" /> Invoice — {lines.length} line{lines.length !== 1 ? "s" : ""}
          </p>
          <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={() => setEditing(true)}>Edit</Button>
        </div>
        <div className="rounded-lg border border-card-border overflow-hidden overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.id ?? i}>
                  <TableCell className="text-xs">{l.description}</TableCell>
                  <TableCell className="font-mono text-xs">{l.quantity}</TableCell>
                  <TableCell className="font-mono text-xs">{fmtMoney(l.unitPrice, entry.currency)}</TableCell>
                  <TableCell className="font-mono text-xs">{l.taxPercent ? `${l.taxPercent}%` : "—"}</TableCell>
                  <TableCell className="font-mono text-xs font-semibold">
                    {fmtMoney(l.quantity * l.unitPrice * (1 + l.taxPercent / 100), entry.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-right text-sm font-mono font-semibold">Total: {fmtMoney(grandTotal, entry.currency)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex items-center gap-1.5">
        <Receipt className="h-3 w-3" /> Invoice line items
      </p>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              placeholder="Description" value={l.description}
              onChange={e => updateLine(i, { description: e.target.value })}
              className="h-8 text-xs flex-1"
            />
            <Input
              type="number" min={0} placeholder="Qty" value={l.quantity}
              onChange={e => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })}
              className="h-8 text-xs w-16"
            />
            <Input
              type="number" min={0} placeholder="Price" value={l.unitPrice}
              onChange={e => updateLine(i, { unitPrice: parseFloat(e.target.value) || 0 })}
              className="h-8 text-xs w-24"
            />
            <Input
              type="number" min={0} placeholder="Tax %" value={l.taxPercent}
              onChange={e => updateLine(i, { taxPercent: parseFloat(e.target.value) || 0 })}
              className="h-8 text-xs w-20"
            />
            <Button variant="ghost" size="icon" className="h-8 w-8 text-danger shrink-0" onClick={() => removeLine(i)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={addLine}>
          <Plus className="h-3 w-3" /> Add line
        </Button>
        <p className="text-sm font-mono font-semibold">Total: {fmtMoney(grandTotal, entry.currency)}</p>
      </div>
      <div className="flex justify-end gap-2">
        {lines.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); load(); }}>Cancel</Button>
        )}
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
          Save Invoice
        </Button>
      </div>
    </div>
  );
}
