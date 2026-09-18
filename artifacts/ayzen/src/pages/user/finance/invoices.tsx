/**
 * pages/user/finance/invoices.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Creditor side of the peer invoicing flow (routes/finance-invoices.ts).
 * Create an invoice — optionally linked to an existing receivable/lending
 * entry — send it by email/Telegram, then track it through sent → viewed →
 * payment submitted → passkey-confirmed by the debtor → verified by you
 * (which posts a real repayment against the linked entry, if any).
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Plus, Loader2, Send, Mail, XCircle, Copy, CheckCircle2, Fingerprint, ShieldCheck, Ban, Trash2, Download, Palette } from "lucide-react";
import { financeInvoiceApi, financeApi } from "@/lib/finance-api";
import {
  INVOICE_STATUS_LABELS, INVOICE_STATUS_STYLES, PAYMENT_METHOD_LABELS,
  type FinanceInvoice, type FinancePaymentAgreement, type FinanceInvoiceLineItem, type FinanceInvoiceBranding,
} from "@/config/finance";
import { FinancePageHeader, FinanceCard, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { cn } from "@/lib/utils";

function money(currency: string, amount: number) {
  return `${currency} ${amount.toLocaleString()}`;
}

type DraftLine = { description: string; quantity: string; unitPrice: string };
const emptyLine = (): DraftLine => ({ description: "", quantity: "1", unitPrice: "" });

function lineItemsTotal(lines: DraftLine[]): number {
  return lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
}

function LineItemsEditor({ lines, setLines, currency }: { lines: DraftLine[]; setLines: (l: DraftLine[]) => void; currency: string }) {
  const update = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines);

  return (
    <div className="space-y-2">
      <Label>Line Items</Label>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <Input placeholder="Description" value={l.description} onChange={e => update(i, { description: e.target.value })} className="flex-1" />
            <Input type="number" placeholder="Qty" value={l.quantity} onChange={e => update(i, { quantity: e.target.value })} className="w-16" />
            <Input type="number" placeholder="Unit price" value={l.unitPrice} onChange={e => update(i, { unitPrice: e.target.value })} className="w-24" />
            <Button type="button" size="icon" variant="ghost" className="text-danger shrink-0" disabled={lines.length <= 1} onClick={() => remove(i)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, emptyLine()])}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Line
      </Button>
      <div className="flex justify-end pt-1 text-sm font-mono font-semibold">Total: {money(currency, lineItemsTotal(lines))}</div>
    </div>
  );
}

function NewInvoiceDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [entries, setEntries] = useState<any[]>([]);
  const [entryId, setEntryId] = useState<string>("");
  const [debtorName, setDebtorName] = useState("");
  const [debtorEmail, setDebtorEmail] = useState("");
  const [debtorTelegramChatId, setDebtorTelegramChatId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [currency, setCurrency] = useState("BDT");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [discountType, setDiscountType] = useState<"none" | "flat" | "percent">("none");
  const [discountValue, setDiscountValue] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [taxLabel, setTaxLabel] = useState("Tax");
  const [terms, setTerms] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEntryId(""); setDebtorName(""); setDebtorEmail(""); setDebtorTelegramChatId("");
    setLines([emptyLine()]); setCurrency("BDT"); setDueDate(""); setNotes("");
    setPoNumber(""); setDiscountType("none"); setDiscountValue(""); setTaxRate(""); setTaxLabel("Tax"); setTerms("");
    Promise.all([
      financeApi.listEntries(token, { kind: "receivable" }),
      financeApi.listEntries(token, { kind: "lending" }),
    ]).then(([rec, len]) => setEntries([...(rec ?? []), ...(len ?? [])])).catch(() => setEntries([]));
  }, [open, token]);

  const applyEntry = (id: string) => {
    setEntryId(id);
    const entry = entries.find(e => String(e.id) === id);
    if (entry) {
      setLines([{ description: entry.title, quantity: "1", unitPrice: String(entry.amount) }]);
      setCurrency(entry.currency);
      if (entry.dueDate) setDueDate(entry.dueDate.slice(0, 10));
    }
  };

  const save = async () => {
    const validLines = lines.filter(l => l.description.trim());
    if (!debtorName.trim() || validLines.length === 0) { toast({ variant: "destructive", title: "Debtor name and at least one line item are required" }); return; }
    if (!debtorEmail.trim() && !debtorTelegramChatId.trim()) { toast({ variant: "destructive", title: "Provide an email or Telegram chat ID to send this to" }); return; }
    setSaving(true);
    try {
      await financeInvoiceApi.createInvoice(token, {
        entryId: entryId ? Number(entryId) : undefined,
        debtorName: debtorName.trim(),
        debtorEmail: debtorEmail.trim() || undefined,
        debtorTelegramChatId: debtorTelegramChatId.trim() || undefined,
        lineItems: validLines.map(l => ({ description: l.description.trim(), quantity: Number(l.quantity) || 1, unitPrice: Number(l.unitPrice) || 0 })),
        currency,
        dueDate: dueDate || undefined,
        notes: notes.trim() || undefined,
        poNumber: poNumber.trim() || undefined,
        discountType: discountType === "none" ? undefined : discountType,
        discountValue: discountType === "none" ? undefined : Number(discountValue) || 0,
        taxRate: Number(taxRate) || undefined,
        taxLabel: taxLabel.trim() || undefined,
        terms: terms.trim() || undefined,
      });
      toast({ title: "Invoice created" });
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>New Invoice</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          {entries.length > 0 && (
            <div>
              <Label>Link to existing entry (optional)</Label>
              <Select value={entryId} onValueChange={applyEntry}>
                <SelectTrigger><SelectValue placeholder="None — standalone invoice" /></SelectTrigger>
                <SelectContent>
                  {entries.map(e => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.title} — {money(e.currency, e.amount)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div><Label>Debtor Name</Label><Input value={debtorName} onChange={e => setDebtorName(e.target.value)} placeholder="Who owes this" /></div>
          <div><Label>Debtor Email</Label><Input type="email" value={debtorEmail} onChange={e => setDebtorEmail(e.target.value)} placeholder="optional if Telegram provided" /></div>
          <div><Label>Debtor Telegram Chat ID</Label><Input value={debtorTelegramChatId} onChange={e => setDebtorTelegramChatId(e.target.value)} placeholder="optional if email provided" /></div>
          <div><Label>Currency</Label><Input value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} maxLength={6} className="w-24" /></div>
          <LineItemsEditor lines={lines} setLines={setLines} currency={currency} />
          <div><Label>Due Date (optional)</Label><Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></div>
          <div><Label>PO / Reference Number (optional)</Label><Input value={poNumber} onChange={e => setPoNumber(e.target.value)} placeholder="e.g. PO-2026-118" /></div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Discount</Label>
              <div className="flex gap-1.5">
                <Select value={discountType} onValueChange={(v: any) => setDiscountType(v)}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="flat">Flat</SelectItem>
                    <SelectItem value="percent">%</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="number" value={discountValue} onChange={e => setDiscountValue(e.target.value)} disabled={discountType === "none"} placeholder="0" />
              </div>
            </div>
            <div>
              <Label>Tax Rate %</Label>
              <div className="flex gap-1.5">
                <Input type="number" value={taxRate} onChange={e => setTaxRate(e.target.value)} placeholder="0" className="w-20" />
                <Input value={taxLabel} onChange={e => setTaxLabel(e.target.value)} placeholder="Tax label" className="flex-1" />
              </div>
            </div>
          </div>

          {(() => {
            const subtotal = lineItemsTotal(lines);
            const dVal = Number(discountValue) || 0;
            const discountAmount = discountType === "percent" ? subtotal * Math.min(Math.max(dVal, 0), 100) / 100 : discountType === "flat" ? Math.min(Math.max(dVal, 0), subtotal) : 0;
            const taxable = subtotal - discountAmount;
            const taxAmount = taxable * (Number(taxRate) || 0) / 100;
            const total = taxable + taxAmount;
            return (
              <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 text-sm space-y-1">
                <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="font-mono">{money(currency, subtotal)}</span></div>
                {discountAmount > 0 && <div className="flex justify-between text-success"><span>Discount</span><span className="font-mono">− {money(currency, discountAmount)}</span></div>}
                {taxAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>{taxLabel || "Tax"}</span><span className="font-mono">{money(currency, taxAmount)}</span></div>}
                <div className="flex justify-between font-semibold pt-1 border-t border-border/30"><span>Total</span><span className="font-mono">{money(currency, total)}</span></div>
              </div>
            );
          })()}

          <div><Label>Terms & Conditions (optional)</Label><Textarea value={terms} onChange={e => setTerms(e.target.value)} rows={2} placeholder="Overrides your default terms for this invoice only" /></div>
          <div><Label>Notes (optional)</Label><Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Per-user logo/theme, reused on every invoice PDF and the public repay
// page — see routes/finance-invoices.ts GET/PUT /finance/invoice-branding.
function InvoiceBrandingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [logoUrl, setLogoUrl] = useState("");
  const [themeColor, setThemeColor] = useState("#00a89f");
  const [businessName, setBusinessName] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [footerNote, setFooterNote] = useState("");
  const [taxId, setTaxId] = useState("");
  const [businessEmail, setBusinessEmail] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [termsText, setTermsText] = useState("");
  const [numberPrefix, setNumberPrefix] = useState("INV");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    financeInvoiceApi.getInvoiceBranding(token)
      .then((b: FinanceInvoiceBranding) => {
        setLogoUrl(b.logoUrl ?? ""); setThemeColor(b.themeColor ?? "#00a89f");
        setBusinessName(b.businessName ?? ""); setBusinessAddress(b.businessAddress ?? ""); setFooterNote(b.footerNote ?? "");
        setTaxId(b.taxId ?? ""); setBusinessEmail(b.businessEmail ?? ""); setBusinessPhone(b.businessPhone ?? "");
        setWebsite(b.website ?? ""); setTermsText(b.termsText ?? ""); setNumberPrefix(b.numberPrefix ?? "INV");
      })
      .finally(() => setLoading(false));
  }, [open, token]);

  const save = async () => {
    setSaving(true);
    try {
      await financeInvoiceApi.updateInvoiceBranding(token, {
        logoUrl: logoUrl.trim(), themeColor, businessName: businessName.trim(),
        businessAddress: businessAddress.trim(), footerNote: footerNote.trim(),
        taxId: taxId.trim(), businessEmail: businessEmail.trim(), businessPhone: businessPhone.trim(),
        website: website.trim(), termsText: termsText.trim(), numberPrefix: numberPrefix.trim() || "INV",
      });
      toast({ title: "Branding saved", description: "Applied to every invoice PDF and repay page from now on." });
      onOpenChange(false);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Invoice Branding</DialogTitle></DialogHeader>
        {loading ? <FinanceLoader /> : (
          <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <Label>Logo URL</Label>
              <Input value={logoUrl} onChange={e => setLogoUrl(e.target.value)} placeholder="https://... or a data:image/png;base64,... URL" />
              {logoUrl && <img src={logoUrl} alt="Logo preview" className="mt-2 h-12 rounded border border-border/30 bg-white object-contain p-1" onError={e => (e.currentTarget.style.display = "none")} />}
            </div>
            <div>
              <Label>Theme Color</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(themeColor) ? themeColor : "#00a89f"} onChange={e => setThemeColor(e.target.value)} className="h-9 w-12 rounded border border-border/30 bg-transparent" />
                <Input value={themeColor} onChange={e => setThemeColor(e.target.value)} placeholder="#00a89f" className="flex-1" />
              </div>
            </div>
            <div><Label>Business Name (optional)</Label><Input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="Defaults to your username" /></div>
            <div><Label>Business Address (optional)</Label><Input value={businessAddress} onChange={e => setBusinessAddress(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>Business Email</Label><Input type="email" value={businessEmail} onChange={e => setBusinessEmail(e.target.value)} placeholder="optional" /></div>
              <div><Label>Business Phone</Label><Input value={businessPhone} onChange={e => setBusinessPhone(e.target.value)} placeholder="optional" /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>Website</Label><Input value={website} onChange={e => setWebsite(e.target.value)} placeholder="optional" /></div>
              <div><Label>Tax / VAT ID</Label><Input value={taxId} onChange={e => setTaxId(e.target.value)} placeholder="optional" /></div>
            </div>
            <div>
              <Label>Invoice Number Prefix</Label>
              <Input value={numberPrefix} onChange={e => setNumberPrefix(e.target.value.toUpperCase())} maxLength={8} className="w-28" placeholder="INV" />
              <p className="text-xs text-muted-foreground mt-1">Invoices are numbered {numberPrefix || "INV"}-{new Date().getFullYear()}-00001, etc.</p>
            </div>
            <div><Label>Default Terms & Conditions (optional)</Label><Textarea value={termsText} onChange={e => setTermsText(e.target.value)} rows={3} placeholder="e.g. Payment due within 30 days. Late payments may incur a fee." /></div>
            <div><Label>PDF Footer Note (optional)</Label><Textarea value={footerNote} onChange={e => setFooterNote(e.target.value)} rows={2} placeholder="Defaults to a standard AYZEN footer" /></div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || loading}>{saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvoiceRow({ invoice, onChanged }: { invoice: FinanceInvoice; onChanged: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [detail, setDetail] = useState<(FinanceInvoice & { agreements: FinancePaymentAgreement[] }) | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState<number | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<number | null>(null);
  const [disputeReason, setDisputeReason] = useState("");
  const [disputing, setDisputing] = useState(false);
  const [reopening, setReopening] = useState(false);

  const loadDetail = async () => {
    if (detail) return;
    setLoadingDetail(true);
    try { setDetail(await financeInvoiceApi.getInvoice(token, invoice.id)); }
    finally { setLoadingDetail(false); }
  };

  const send = async () => {
    setSending(true);
    try {
      const res = await financeInvoiceApi.sendInvoice(token, invoice.id);
      toast({ title: res.sentEmail || res.sentTelegram ? "Invoice sent" : "Nothing to send", description: !res.sentEmail && !res.sentTelegram ? "Add a debtor email or Telegram chat ID first." : undefined });
      onChanged();
      setDetail(null);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!confirm("Cancel this invoice? The Repay link will stop working.")) return;
    try {
      await financeInvoiceApi.cancelInvoice(token, invoice.id);
      toast({ title: "Invoice cancelled" });
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const verify = async (agreementId: number) => {
    setVerifying(agreementId);
    try {
      await financeInvoiceApi.verifyAgreement(token, agreementId);
      toast({ title: "Verified", description: "Repayment posted to your books." });
      setDetail(null);
      await loadDetail();
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setVerifying(null);
    }
  };

  const dispute = async () => {
    if (!disputeTarget || !disputeReason.trim()) return;
    setDisputing(true);
    try {
      await financeInvoiceApi.disputeAgreement(token, disputeTarget, disputeReason.trim());
      toast({ title: "Payment claim disputed" });
      setDisputeTarget(null); setDisputeReason("");
      setDetail(null);
      await loadDetail();
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setDisputing(false);
    }
  };

  const reopen = async () => {
    setReopening(true);
    try {
      await financeInvoiceApi.reopenInvoice(token, invoice.id);
      toast({ title: "Invoice reopened", description: "The debtor can submit a new payment claim again." });
      setDetail(null);
      await loadDetail();
      onChanged();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setReopening(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/finance/invoice/${invoice.invoiceToken}`);
    toast({ title: "Link copied" });
  };

  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const downloadPdf = async () => {
    // Authenticated route (Authorization header, not a query param) — fetch
    // as a blob and trigger the save ourselves rather than window.open,
    // which can't attach the header.
    setDownloadingPdf(true);
    try {
      const r = await fetch(financeInvoiceApi.invoicePdfUrl(invoice.id), { headers: { Authorization: `Bearer ${token ?? ""}` } });
      if (!r.ok) throw new Error("Couldn't generate the PDF");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ayzen-invoice-${invoice.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setDownloadingPdf(false);
    }
  };

  return (
    <AccordionItem value={String(invoice.id)} className="border border-card-border rounded-xl px-4 bg-card">
      <AccordionTrigger onClick={loadDetail} className="hover:no-underline py-3">
        <div className="flex items-center justify-between w-full gap-3 pr-2">
          <div className="text-left min-w-0">
            <p className="font-semibold truncate">{invoice.debtorName} <span className="text-xs font-mono font-normal text-muted-foreground">{invoice.invoiceNumber ? `· ${invoice.invoiceNumber}` : `· #${invoice.id}`}</span></p>
            <p className="text-xs text-muted-foreground">{invoice.debtorEmail || invoice.debtorTelegramChatId}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="font-mono text-sm">
              {invoice.paidAmount > 0 && invoice.paidAmount < invoice.amount
                ? `${money(invoice.currency, invoice.paidAmount)} / ${money(invoice.currency, invoice.amount)}`
                : money(invoice.currency, invoice.amount)}
            </span>
            <Badge className={cn("capitalize", INVOICE_STATUS_STYLES[invoice.status])}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="pb-4 space-y-3">
        {invoice.notes && <p className="text-sm text-muted-foreground">{invoice.notes}</p>}
        <div className="flex flex-wrap gap-2">
          {invoice.status !== "cancelled" && (
            <Button size="sm" variant="outline" onClick={send} disabled={sending}>
              {sending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />} Send / Resend
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={copyLink}><Copy className="h-3.5 w-3.5 mr-1.5" /> Copy Repay Link</Button>
          <Button size="sm" variant="outline" onClick={downloadPdf} disabled={downloadingPdf}>
            {downloadingPdf ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />} PDF
          </Button>
          {invoice.status === "disputed" && (
            <Button size="sm" variant="outline" onClick={reopen} disabled={reopening}>
              {reopening ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />} Reopen for new claim
            </Button>
          )}
          {invoice.status !== "cancelled" && invoice.status !== "creditor_verified" && (
            <Button size="sm" variant="ghost" className="text-danger" onClick={cancel}><XCircle className="h-3.5 w-3.5 mr-1.5" /> Cancel</Button>
          )}
        </div>

        {loadingDetail ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : detail?.lineItems && detail.lineItems.length > 0 ? (
          <div className="space-y-1 pt-2 border-t border-border/30">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Line Items</p>
            {detail.lineItems.map((li: FinanceInvoiceLineItem) => (
              <div key={li.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-foreground truncate">{li.description} {li.quantity !== 1 ? <span className="text-muted-foreground">× {li.quantity}</span> : null}</span>
                <span className="font-mono text-muted-foreground shrink-0">{money(invoice.currency, li.quantity * li.unitPrice)}</span>
              </div>
            ))}
            {(() => {
              const subtotal = detail.lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
              const discountAmount = detail.discountType === "percent" ? subtotal * (detail.discountValue / 100) : detail.discountType === "flat" ? detail.discountValue : 0;
              const taxAmount = detail.taxRate ? (subtotal - discountAmount) * (detail.taxRate / 100) : 0;
              if (discountAmount <= 0 && taxAmount <= 0 && !detail.poNumber) return null;
              return (
                <div className="pt-1.5 mt-1 border-t border-border/20 space-y-1 text-sm">
                  {detail.poNumber && <div className="flex justify-between text-muted-foreground text-xs"><span>PO / Reference</span><span className="font-mono">{detail.poNumber}</span></div>}
                  {discountAmount > 0 && <div className="flex justify-between text-success"><span>Discount</span><span className="font-mono">− {money(invoice.currency, discountAmount)}</span></div>}
                  {taxAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>{detail.taxLabel || "Tax"} ({detail.taxRate}%)</span><span className="font-mono">{money(invoice.currency, taxAmount)}</span></div>}
                </div>
              );
            })()}
          </div>
        ) : null}

        {loadingDetail ? null : detail && detail.agreements.length > 0 ? (
          <div className="space-y-2 pt-2 border-t border-border/30">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Payment Claims</p>
            {detail.agreements.map(a => (
              <div key={a.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-muted/10 border border-border/30 text-sm">
                <div className="min-w-0">
                  <p>{PAYMENT_METHOD_LABELS[a.methodType]} {a.referenceId ? `· ${a.referenceId}` : ""} <span className="text-muted-foreground">({money(invoice.currency, a.amount)})</span></p>
                  <p className="text-xs text-muted-foreground">
                    {a.status === "submitted" && "Submitted — awaiting debtor's passkey confirmation"}
                    {a.status === "passkey_confirmed" && `Confirmed with passkey ${a.confirmedAt ? new Date(a.confirmedAt).toLocaleString() : ""}`}
                    {a.status === "creditor_verified" && "Verified — repayment posted"}
                    {a.status === "disputed" && `Disputed — ${a.disputeReason}`}
                  </p>
                </div>
                {a.status === "passkey_confirmed" ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button size="sm" onClick={() => verify(a.id)} disabled={verifying === a.id}>
                      {verifying === a.id ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />} Verify
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDisputeTarget(a.id)}>
                      <Ban className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : a.status === "creditor_verified" ? (
                  <CheckCircle2 className="h-4 w-4 text-success flex-shrink-0" />
                ) : a.status === "disputed" ? (
                  <Ban className="h-4 w-4 text-danger flex-shrink-0" />
                ) : (
                  <Fingerprint className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        ) : null}
      </AccordionContent>

      <Dialog open={disputeTarget !== null} onOpenChange={(o) => { if (!o) { setDisputeTarget(null); setDisputeReason(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Dispute this payment claim</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea value={disputeReason} onChange={e => setDisputeReason(e.target.value)} rows={3} placeholder="e.g. reference ID doesn't match anything received" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDisputeTarget(null); setDisputeReason(""); }}>Cancel</Button>
            <Button variant="destructive" onClick={dispute} disabled={disputing || !disputeReason.trim()}>
              {disputing && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AccordionItem>
  );
}

export default function FinanceInvoicesPage() {
  const { token } = useAuth();
  const [invoices, setInvoices] = useState<FinanceInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    financeInvoiceApi.listInvoices(token).then(setInvoices).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Invoices"
        title="Invoices"
        description="Bill whoever owes you, over email or Telegram — track it through payment-submitted, passkey-confirmed, and verified"
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setBrandingOpen(true)}><Palette className="h-4 w-4 mr-1.5" /> Branding</Button>
            <Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Invoice</Button>
          </div>
        }
      />

      {loading ? (
        <FinanceLoader />
      ) : invoices.length === 0 ? (
        <FinanceEmptyState icon={Mail} title="No invoices yet" description="Create one to bill a debtor by email or Telegram, with a Repay button linking to your payment methods." />
      ) : (
        <Accordion type="single" collapsible className="space-y-2">
          {invoices.map(inv => <InvoiceRow key={inv.id} invoice={inv} onChanged={load} />)}
        </Accordion>
      )}

      <NewInvoiceDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />
      <InvoiceBrandingDialog open={brandingOpen} onOpenChange={setBrandingOpen} />
    </div>
  );
}
