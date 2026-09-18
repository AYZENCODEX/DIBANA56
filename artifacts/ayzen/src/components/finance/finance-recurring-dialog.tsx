import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceKind, FinanceRecurringRule, RecurringFrequency } from "@/config/finance";
import { KIND_LABELS, FREQUENCY_LABELS, CURRENCY_OPTIONS, CRYPTO_CURRENCY_OPTIONS } from "@/config/finance";

export function FinanceRecurringDialog({
  open, onOpenChange, rule, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: FinanceRecurringRule | null;
  onSaved?: () => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [kind, setKind] = useState<FinanceKind>("expense");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [frequency, setFrequency] = useState<RecurringFrequency>("monthly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [nextRunDate, setNextRunDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [autoInvoice, setAutoInvoice] = useState(false);
  const [invoiceDebtorName, setInvoiceDebtorName] = useState("");
  const [invoiceDebtorEmail, setInvoiceDebtorEmail] = useState("");
  const [invoiceDebtorTelegramChatId, setInvoiceDebtorTelegramChatId] = useState("");
  const [invoiceDueDays, setInvoiceDueDays] = useState("7");
  const [saving, setSaving] = useState(false);

  const invoiceable = kind === "receivable" || kind === "lending";

  useEffect(() => {
    if (!open) return;
    setKind(rule?.kind ?? "expense");
    setTitle(rule?.title ?? "");
    setAmount(rule ? String(rule.amount) : "");
    setCurrency(rule?.currency ?? "BDT");
    setFrequency(rule?.frequency ?? "monthly");
    setIntervalCount(rule ? String(rule.intervalCount) : "1");
    setNextRunDate(rule?.nextRunDate ? rule.nextRunDate.slice(0, 10) : new Date().toISOString().slice(0, 10));
    setEndDate(rule?.endDate ? rule.endDate.slice(0, 10) : "");
    setCategory(rule?.category ?? "");
    setNotes(rule?.notes ?? "");
    setAutoInvoice(!!rule?.autoInvoice);
    setInvoiceDebtorName(rule?.invoiceDebtorName ?? "");
    setInvoiceDebtorEmail(rule?.invoiceDebtorEmail ?? "");
    setInvoiceDebtorTelegramChatId(rule?.invoiceDebtorTelegramChatId ?? "");
    setInvoiceDueDays(rule ? String(rule.invoiceDueDays ?? 7) : "7");
  }, [open, rule]);

  const handleSave = async () => {
    if (!title.trim()) { toast({ variant: "destructive", title: "Title is required" }); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast({ variant: "destructive", title: "Enter a valid amount" }); return; }
    if (invoiceable && autoInvoice && !invoiceDebtorName.trim()) {
      toast({ variant: "destructive", title: "Debtor name is required for auto-invoicing" }); return;
    }
    if (invoiceable && autoInvoice && !invoiceDebtorEmail.trim() && !invoiceDebtorTelegramChatId.trim()) {
      toast({ variant: "destructive", title: "Provide a debtor email or Telegram chat ID to auto-send to" }); return;
    }

    setSaving(true);
    try {
      const payload = {
        kind, title: title.trim(), amount: amt, currency,
        frequency, intervalCount: parseInt(intervalCount, 10) || 1,
        nextRunDate, endDate: endDate || null,
        category: category.trim() || null,
        notes: notes.trim() || null,
        autoInvoice: invoiceable && autoInvoice ? 1 : 0,
        invoiceDebtorName: invoiceable && autoInvoice ? invoiceDebtorName.trim() : null,
        invoiceDebtorEmail: invoiceable && autoInvoice ? (invoiceDebtorEmail.trim() || null) : null,
        invoiceDebtorTelegramChatId: invoiceable && autoInvoice ? (invoiceDebtorTelegramChatId.trim() || null) : null,
        invoiceDueDays: parseInt(invoiceDueDays, 10) || 7,
      };
      if (rule) {
        await financeApi.updateRecurring(token, rule.id, payload);
        toast({ title: "Updated" });
      } else {
        await financeApi.createRecurring(token, payload);
        toast({ title: "Recurring rule added" });
      }
      onOpenChange(false);
      onSaved?.();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{rule ? "Edit" : "Add"} Recurring Rule</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Type</Label>
            <Select value={kind} onValueChange={v => setKind(v as FinanceKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as FinanceKind[]).map(k => <SelectItem key={k} value={k}>{KIND_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Server hosting, Team salary" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Amount</Label>
              <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div>
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[...CURRENCY_OPTIONS, ...CRYPTO_CURRENCY_OPTIONS].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={v => setFrequency(v as RecurringFrequency)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(FREQUENCY_LABELS) as RecurringFrequency[]).map(f => <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Every</Label>
              <Input type="number" min={1} value={intervalCount} onChange={e => setIntervalCount(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Next Run</Label>
              <Input type="date" value={nextRunDate} onChange={e => setNextRunDate(e.target.value)} />
            </div>
            <div>
              <Label>End Date (optional)</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          {kind === "expense" && (
            <div>
              <Label>Category</Label>
              <Input value={category} onChange={e => setCategory(e.target.value)} placeholder="Infra / Team / Marketing / Personal" />
            </div>
          )}
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
          {invoiceable && (
            <div className="border border-card-border rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Auto-invoice (rent / EMI style)</Label>
                  <p className="text-xs text-muted-foreground">Mint + email/Telegram an invoice every time this rule runs</p>
                </div>
                <Switch checked={autoInvoice} onCheckedChange={setAutoInvoice} />
              </div>
              {autoInvoice && (
                <div className="space-y-2 pt-1">
                  <div><Label>Debtor Name</Label><Input value={invoiceDebtorName} onChange={e => setInvoiceDebtorName(e.target.value)} placeholder="Who owes this each cycle" /></div>
                  <div><Label>Debtor Email</Label><Input type="email" value={invoiceDebtorEmail} onChange={e => setInvoiceDebtorEmail(e.target.value)} placeholder="optional if Telegram provided" /></div>
                  <div><Label>Debtor Telegram Chat ID</Label><Input value={invoiceDebtorTelegramChatId} onChange={e => setInvoiceDebtorTelegramChatId(e.target.value)} placeholder="optional if email provided" /></div>
                  <div><Label>Due (days after each run)</Label><Input type="number" min={0} value={invoiceDueDays} onChange={e => setInvoiceDueDays(e.target.value)} /></div>
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {rule ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
