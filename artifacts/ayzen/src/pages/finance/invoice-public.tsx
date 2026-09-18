/**
 * pages/finance/invoice-public.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Public "Repay" landing page for a Finance invoice link (routes/finance-
 * invoices.ts GET /finance/invoices/public/:token). Same tier as /finance/
 * receipt/:token — outside AppLayout/ProtectedRoute, no login required to
 * view. Shows the creditor's published payment methods (bKash/Nagad/Rocket/
 * bank/USDT); the debtor pays manually outside AYZEN, then must be logged
 * in to submit the method + reference as a payment claim, which moves them
 * on to the Payment Agreement (passkey-confirm) page.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { Receipt, Loader2, XCircle, CheckCircle2, ShieldCheck, Landmark, Smartphone, Wallet, Download, QrCode } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { financeInvoiceApi } from "@/lib/finance-api";
import { PAYMENT_METHOD_LABELS, type PaymentMethodType, type FinancePaymentMethod, type FinanceInvoiceLineItem, type FinanceInvoiceBranding } from "@/config/finance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Status = "loading" | "loaded" | "error";

interface PublicInvoice {
  id: number;
  invoiceNumber: string | null;
  poNumber: string | null;
  creditorName: string;
  debtorName: string;
  amount: number;
  currency: string;
  subtotal: number;
  discountType: "flat" | "percent" | null;
  discountValue: number;
  discountAmount: number;
  taxRate: number;
  taxLabel: string;
  taxAmount: number;
  issueDate: string | null;
  dueDate: string | null;
  notes: string | null;
  terms: string | null;
  status: string;
  paidAmount: number;
  remainingAmount: number;
  lineItems: FinanceInvoiceLineItem[];
  branding: FinanceInvoiceBranding;
  payLinkQrDataUrl: string | null;
  paymentMethods: FinancePaymentMethod[];
}

const METHOD_ICON: Record<PaymentMethodType, typeof Smartphone> = {
  bkash: Smartphone, nagad: Smartphone, rocket: Smartphone, bank: Landmark, usdt: Wallet,
};

function methodDetail(m: FinancePaymentMethod): string {
  if (m.methodType === "bank") return [m.bankName, m.bankAccountName, m.bankAccountNumber].filter(Boolean).join(" · ");
  if (m.methodType === "usdt") return [m.usdtAddress, m.usdtNetwork].filter(Boolean).join(" · ");
  return m.accountNumber ?? "—";
}

export default function FinanceInvoicePublic() {
  const { token } = useParams<{ token: string }>();
  const { token: authToken, user } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType | null>(null);
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setStatus("error"); setErrorMessage("Missing invoice link."); return; }
    financeInvoiceApi.getPublicInvoice(token)
      .then((r: PublicInvoice) => {
        setInvoice(r);
        setSelectedMethod(r.paymentMethods.find(m => m.isDefault)?.methodType ?? r.paymentMethods[0]?.methodType ?? null);
        setStatus("loaded");
      })
      .catch((err: any) => {
        setStatus("error");
        setErrorMessage(err?.message ?? "This invoice link is invalid or has been cancelled.");
      });
  }, [token]);

  const submit = async () => {
    if (!token || !selectedMethod) return;
    if (!user || !authToken) {
      toast({ title: "Log in to confirm", description: "You need an AYZEN account to submit and passkey-confirm this payment. Come back to this link after logging in." });
      navigate("/login");
      return;
    }
    setSubmitting(true);
    try {
      const res = await financeInvoiceApi.submitPayment(authToken, token, {
        methodType: selectedMethod, referenceId: reference.trim() || undefined,
        amount: invoice ? invoice.remainingAmount : undefined,
      });
      toast({ title: "Payment submitted", description: "Now confirm it with your passkey to keep it as evidence." });
      navigate(`/finance/payment-agreement/${res.agreementToken}`);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Couldn't submit", description: e?.message });
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen w-full bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Loading invoice...</p>
        </div>
      </div>
    );
  }

  if (status === "error" || !invoice) {
    return (
      <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center border bg-red-500/10 border-red-500/20">
              <XCircle className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-2xl font-mono font-bold tracking-tighter text-foreground">Invoice Unavailable</h1>
          <div className="bg-card border border-card-border p-6 space-y-2 rounded-lg">
            <p className="font-mono text-sm text-red-400 font-bold">{errorMessage}</p>
          </div>
          <Link href="/login" className="font-mono text-sm text-primary hover:underline">Go to AYZEN</Link>
        </div>
      </div>
    );
  }

  const fullyPaid = invoice.status === "paid" || invoice.status === "creditor_verified";
  const pendingReview = invoice.status === "payment_submitted" || invoice.status === "agreement_confirmed";
  const disputed = invoice.status === "disputed";
  const alreadySubmitted = fullyPaid || pendingReview || disputed;
  const theme = /^#[0-9a-fA-F]{6}$/.test(invoice.branding.themeColor ?? "") ? invoice.branding.themeColor! : undefined;
  const pdfUrl = financeInvoiceApi.publicInvoicePdfUrl(token!);

  return (
    <div className="min-h-screen w-full bg-background p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap border-b border-border/40 pb-5">
          <div className="flex items-center gap-3">
            {invoice.branding.logoUrl ? (
              <img src={invoice.branding.logoUrl} alt={invoice.branding.businessName ?? invoice.creditorName} className="w-11 h-11 rounded-xl object-contain bg-white border border-border/20 p-1" onError={e => (e.currentTarget.style.display = "none")} />
            ) : (
              <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center" style={theme ? { backgroundColor: `${theme}1a`, borderColor: `${theme}33` } : undefined}>
                <Receipt className="w-5 h-5 text-primary" style={theme ? { color: theme } : undefined} />
              </div>
            )}
            <div>
              <h1 className="text-xl font-mono font-bold tracking-tight text-foreground">{invoice.branding.businessName || `${invoice.creditorName} Invoice`}</h1>
              <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest">
                {invoice.invoiceNumber || `Invoice #${invoice.id}`}{invoice.poNumber ? ` · PO ${invoice.poNumber}` : ""}
              </p>
            </div>
          </div>
          <a href={pdfUrl} target="_blank" rel="noreferrer">
            <Button size="sm" variant="outline"><Download className="w-3.5 h-3.5 mr-1.5" /> PDF</Button>
          </a>
        </div>

        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border/30 bg-muted/10 flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-base font-semibold text-foreground">{invoice.creditorName} requests payment</p>
              <p className="text-xs text-muted-foreground">From {invoice.debtorName}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-mono font-bold text-foreground">{invoice.currency} {invoice.amount.toLocaleString()}</p>
              {invoice.paidAmount > 0 && !fullyPaid && (
                <p className="text-xs text-success font-mono">{invoice.currency} {invoice.paidAmount.toLocaleString()} paid · {invoice.currency} {invoice.remainingAmount.toLocaleString()} remaining</p>
              )}
            </div>
          </div>
          {invoice.lineItems.length > 0 && (
            <div className="px-5 py-3 border-b border-border/30 space-y-1.5">
              {invoice.lineItems.map(li => (
                <div key={li.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-foreground truncate">{li.description} {li.quantity !== 1 ? <span className="text-muted-foreground">× {li.quantity}</span> : null}</span>
                  <span className="font-mono text-muted-foreground shrink-0">{invoice.currency} {(li.quantity * li.unitPrice).toLocaleString()}</span>
                </div>
              ))}
              {(invoice.discountAmount > 0 || invoice.taxAmount > 0) && (
                <div className="pt-1.5 mt-1 border-t border-border/20 space-y-1 text-sm">
                  <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="font-mono">{invoice.currency} {invoice.subtotal.toLocaleString()}</span></div>
                  {invoice.discountAmount > 0 && (
                    <div className="flex justify-between text-success">
                      <span>Discount{invoice.discountType === "percent" ? ` (${invoice.discountValue}%)` : ""}</span>
                      <span className="font-mono">− {invoice.currency} {invoice.discountAmount.toLocaleString()}</span>
                    </div>
                  )}
                  {invoice.taxAmount > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{invoice.taxLabel || "Tax"} ({invoice.taxRate}%)</span>
                      <span className="font-mono">{invoice.currency} {invoice.taxAmount.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {invoice.notes && <div className="px-5 py-3 text-sm text-muted-foreground border-b border-border/30">{invoice.notes}</div>}
          {invoice.terms && (
            <div className="px-5 py-3 text-xs text-muted-foreground border-b border-border/30">
              <p className="font-semibold uppercase tracking-wide text-[10px] mb-1">Terms & Conditions</p>
              {invoice.terms}
            </div>
          )}
          <div className="px-5 py-2 text-xs text-muted-foreground border-b border-border/30 flex flex-wrap gap-x-4">
            {invoice.issueDate && <span>Issued {new Date(invoice.issueDate).toLocaleDateString()}</span>}
            {invoice.dueDate && <span>Due {new Date(invoice.dueDate).toLocaleDateString()}</span>}
          </div>
        </div>

        {invoice.payLinkQrDataUrl && (
          <div className="flex items-center gap-3 bg-card border border-card-border rounded-xl p-4">
            <img src={invoice.payLinkQrDataUrl} alt="Scan to open this invoice" className="w-16 h-16 rounded-md border border-border/30 bg-white flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground flex items-center gap-1.5"><QrCode className="w-3.5 h-3.5" /> Scan to open this invoice</p>
              <p className="text-xs text-muted-foreground">Useful for sharing this page from a printed or forwarded copy.</p>
            </div>
          </div>
        )}

        {alreadySubmitted ? (
          <div className="bg-card border border-card-border rounded-xl p-6 flex items-start gap-3">
            {disputed ? <XCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" /> : <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />}
            <div>
              <p className="font-semibold text-foreground">
                {fullyPaid ? "This invoice is fully paid." : disputed ? "Your last payment claim was disputed." : "A payment has already been submitted for this invoice."}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {fullyPaid ? "Thanks — nothing else to do here."
                  : disputed ? "Contact the creditor to resolve this before submitting another claim."
                  : "If that was you, check your email or Telegram for the Confirm Payment link."}
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/30 bg-muted/10">
              <p className="text-sm font-semibold text-foreground">How to pay {invoice.creditorName}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Send the amount above using one of these, then tell us the reference below.</p>
            </div>
            <div className="p-5 space-y-2">
              {invoice.paymentMethods.length === 0 && (
                <p className="text-sm text-muted-foreground">{invoice.creditorName} hasn't published a payment method yet — reach out to them directly.</p>
              )}
              {invoice.paymentMethods.map((m) => {
                const Icon = METHOD_ICON[m.methodType];
                const selected = selectedMethod === m.methodType;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedMethod(m.methodType)}
                    className={cn(
                      "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors",
                      selected ? "border-primary bg-primary/5" : "border-card-border hover:bg-muted/20",
                    )}
                  >
                    <Icon className="w-4 h-4 text-primary flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{m.label || PAYMENT_METHOD_LABELS[m.methodType]}</p>
                      <p className="text-xs text-muted-foreground truncate">{methodDetail(m)}</p>
                    </div>
                    {selected && m.qrDataUrl && (
                      <img src={m.qrDataUrl} alt={`Scan to pay ${PAYMENT_METHOD_LABELS[m.methodType]}`} className="w-14 h-14 rounded-md border border-border/30 bg-white flex-shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
            {invoice.paymentMethods.length > 0 && (
              <div className="px-5 pb-5 space-y-3 border-t border-border/30 pt-4">
                <div>
                  <Label htmlFor="ref" className="text-xs">Transaction / Reference ID (optional but recommended)</Label>
                  <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. bKash TrxID" className="mt-1" />
                </div>
                <Button onClick={submit} disabled={submitting || !selectedMethod} className="w-full">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  I've Sent {invoice.currency} {invoice.remainingAmount.toLocaleString()}
                </Button>
                {!user && <p className="text-xs text-muted-foreground text-center">You'll be asked to log in to confirm this with your passkey.</p>}
              </div>
            )}
          </div>
        )}

        <div className="flex items-start gap-2.5 px-1">
          <ShieldCheck className="w-4 h-4 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
          <p className="font-mono text-[10px] text-muted-foreground/50">
            Submitting a payment here doesn't move any money automatically — it starts a Payment Agreement you confirm with your own AYZEN passkey, kept as evidence of what you sent.
          </p>
        </div>
      </div>
    </div>
  );
}
