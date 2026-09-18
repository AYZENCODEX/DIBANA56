/**
 * pages/finance/payment-agreement-public.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Public "Payment Agreement" page (routes/finance-invoices.ts GET /finance/
 * payment-agreements/public/:token). The debtor's evidence step: sign the
 * submitted payment claim with their own AYZEN passkey. The server stamps
 * IP + device at that moment and the agreement becomes downloadable as a
 * PDF the payer can keep as proof they sent the money. Viewing the status
 * needs no login; confirming does, since it must be the same account that
 * submitted the claim.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { startAuthentication } from "@simplewebauthn/browser";
import { ShieldCheck, Loader2, XCircle, CheckCircle2, Fingerprint, Download } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { financeInvoiceApi } from "@/lib/finance-api";
import { browserSupportsWebAuthn } from "@/lib/passkey-api";
import { PAYMENT_METHOD_LABELS, type PaymentMethodType } from "@/config/finance";
import { Button } from "@/components/ui/button";

type Status = "loading" | "loaded" | "error";

interface PublicAgreement {
  id: number;
  status: "submitted" | "passkey_confirmed" | "creditor_verified" | "disputed";
  methodType: PaymentMethodType;
  referenceId: string | null;
  amount: number;
  submittedAt: string | null;
  confirmedAt: string | null;
  creditorVerifiedAt: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  invoiceTitle: string | null;
  currency: string;
  creditorName: string | null;
  debtorName: string | null;
  evidenceAvailable: boolean;
}

export default function FinancePaymentAgreementPublic() {
  const { token } = useParams<{ token: string }>();
  const { token: authToken, user } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [agreement, setAgreement] = useState<PublicAgreement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const ran = useRef(false);

  const load = () => {
    if (!token) return;
    financeInvoiceApi.getPublicAgreement(token)
      .then((r: PublicAgreement) => { setAgreement(r); setStatus("loaded"); })
      .catch((err: any) => { setStatus("error"); setErrorMessage(err?.message ?? "This payment agreement link is invalid."); });
  };

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setStatus("error"); setErrorMessage("Missing agreement link."); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const confirmWithPasskey = async () => {
    if (!token) return;
    if (!user || !authToken) {
      toast({ title: "Log in to confirm", description: "Log in with the same account you used to submit this payment, then come back to this link." });
      navigate("/login");
      return;
    }
    if (!browserSupportsWebAuthn()) {
      toast({ variant: "destructive", title: "Passkeys not supported", description: "Try this on a device/browser that supports passkeys." });
      return;
    }
    setConfirming(true);
    try {
      const { options, challengeKey } = await financeInvoiceApi.agreementPasskeyOptions(authToken, token);
      const response = await startAuthentication({ optionsJSON: options });
      await financeInvoiceApi.agreementPasskeyVerify(authToken, token, { challengeKey, response });
      toast({ title: "Payment confirmed", description: "Signed with your passkey — kept as evidence." });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Couldn't confirm", description: e?.message ?? "Passkey confirmation failed." });
    } finally {
      setConfirming(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen w-full bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Loading agreement...</p>
        </div>
      </div>
    );
  }

  if (status === "error" || !agreement) {
    return (
      <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center border bg-red-500/10 border-red-500/20">
              <XCircle className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-2xl font-mono font-bold tracking-tighter text-foreground">Agreement Unavailable</h1>
          <div className="bg-card border border-card-border p-6 space-y-2 rounded-lg">
            <p className="font-mono text-sm text-red-400 font-bold">{errorMessage}</p>
          </div>
          <Link href="/login" className="font-mono text-sm text-primary hover:underline">Go to AYZEN</Link>
        </div>
      </div>
    );
  }

  const row = (label: string, value: string | null) => value ? (
    <div className="min-w-0">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">{label}</div>
      <div className="text-sm text-foreground break-words">{value}</div>
    </div>
  ) : null;

  return (
    <div className="min-h-screen w-full bg-background p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3 border-b border-border/40 pb-5">
          <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Fingerprint className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-mono font-bold tracking-tight text-foreground">Payment Agreement</h1>
            <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest">{agreement.invoiceTitle ?? `Agreement #${agreement.id}`}</p>
          </div>
        </div>

        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border/30 bg-muted/10 flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm text-muted-foreground">{agreement.debtorName} paying {agreement.creditorName}</p>
            </div>
            <p className="text-2xl font-mono font-bold text-foreground">{agreement.currency} {agreement.amount.toLocaleString()}</p>
          </div>
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {row("Method", PAYMENT_METHOD_LABELS[agreement.methodType] ?? agreement.methodType)}
            {row("Reference / Txn ID", agreement.referenceId)}
            {row("Submitted", agreement.submittedAt ? new Date(agreement.submittedAt).toLocaleString() : null)}
            {row("Passkey-confirmed", agreement.confirmedAt ? new Date(agreement.confirmedAt).toLocaleString() : null)}
            {row("Verified by creditor", agreement.creditorVerifiedAt ? new Date(agreement.creditorVerifiedAt).toLocaleString() : null)}
          </div>
        </div>

        {agreement.status === "submitted" && (
          <div className="bg-card border border-card-border rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Confirm this payment with your passkey</p>
                <p className="text-sm text-muted-foreground mt-1">
                  This signs the claim above with your AYZEN account's passkey and records your IP address and device at this moment — kept as evidence that you sent this money.
                </p>
              </div>
            </div>
            <Button onClick={confirmWithPasskey} disabled={confirming} className="w-full">
              {confirming ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Fingerprint className="w-4 h-4 mr-2" />}
              Confirm Payment with Passkey
            </Button>
            {!user && <p className="text-xs text-muted-foreground text-center">You'll be asked to log in first — use the same account you submitted this claim from.</p>}
          </div>
        )}

        {agreement.status === "disputed" && (
          <div className="bg-card border border-card-border rounded-xl p-6 flex items-start gap-3">
            <XCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-foreground">This payment claim was disputed</p>
              {agreement.disputeReason && <p className="text-sm text-muted-foreground mt-1">Reason: {agreement.disputeReason}</p>}
              <p className="text-sm text-muted-foreground mt-1">Contact {agreement.creditorName ?? "the creditor"} to resolve this, or submit a fresh claim from the invoice link.</p>
            </div>
          </div>
        )}

        {(agreement.status === "passkey_confirmed" || agreement.status === "creditor_verified") && (
          <div className="bg-card border border-card-border rounded-xl p-6 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-foreground">
                {agreement.status === "creditor_verified" ? "Verified — repayment recorded" : "Confirmed — awaiting creditor review"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">This agreement is signed and timestamped. Keep the PDF below as your record.</p>
              {agreement.evidenceAvailable && (
                <a
                  href={financeInvoiceApi.evidencePdfUrl(token!)}
                  className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 mt-3 rounded-md border border-card-border hover:bg-muted/20 transition-colors"
                >
                  <Download className="w-4 h-4" /> Download Evidence PDF
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
