/**
 * pages/finance/receipt.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Public, unauthenticated landing page for a finance ledger entry's receipt
 * link (routes/finance.ts GET /finance/receipt/:token). Same tier as
 * /emergency-access/* — outside AppLayout/ProtectedRoute, no login required.
 * Anyone holding the link can view this one entry and download it as a PDF;
 * nothing else in the account is reachable from here.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { Receipt, Loader2, XCircle, Download, ShieldCheck } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import { fmtMoney, KIND_LABELS, STATUS_STYLES } from "@/config/finance";
import { cn } from "@/lib/utils";

type Status = "loading" | "loaded" | "error";

interface PublicReceipt {
  id: number;
  kind: keyof typeof KIND_LABELS;
  title: string;
  amount: number;
  currency: string;
  category: string | null;
  interestRate: number | null;
  interestPaid: number;
  dueDate: string | null;
  occurredDate: string;
  status: string;
  partyName: string | null;
  issuedBy: string | null;
  generatedAt: string;
}

export default function FinanceReceiptPublic() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [receipt, setReceipt] = useState<PublicReceipt | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setStatus("error"); setErrorMessage("Missing receipt link."); return; }
    financeApi.getPublicReceipt(token)
      .then((r: PublicReceipt) => { setReceipt(r); setStatus("loaded"); })
      .catch((err: any) => {
        setStatus("error");
        setErrorMessage(err?.message ?? "This receipt link is invalid or has been revoked.");
      });
  }, [token]);

  if (status === "loading") {
    return (
      <div className="min-h-screen w-full bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Loading receipt...</p>
        </div>
      </div>
    );
  }

  if (status === "error" || !receipt) {
    return (
      <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center border bg-red-500/10 border-red-500/20">
              <XCircle className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-2xl font-mono font-bold tracking-tighter text-foreground">Receipt Unavailable</h1>
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
        <div className="flex items-start justify-between gap-4 flex-wrap border-b border-border/40 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-mono font-bold tracking-tight text-foreground">AYZEN Receipt</h1>
              <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest">Receipt #{receipt.id}</p>
            </div>
          </div>
          <a
            href={financeApi.publicReceiptPdfUrl(token!)}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-md border border-card-border hover:bg-muted/20 transition-colors"
          >
            <Download className="w-4 h-4" /> Download PDF
          </a>
        </div>

        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border/30 bg-muted/10 flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-base font-semibold text-foreground">{receipt.title}</p>
              <p className="text-xs text-muted-foreground">{KIND_LABELS[receipt.kind] ?? receipt.kind}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-mono font-bold text-foreground">{fmtMoney(receipt.amount, receipt.currency)}</p>
              <span className={cn("inline-block mt-1 text-xs px-2 py-0.5 rounded-full border capitalize", STATUS_STYLES[receipt.status])}>
                {receipt.status}
              </span>
            </div>
          </div>
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {row("Party", receipt.partyName)}
            {row("Category", receipt.category)}
            {row("Date", new Date(receipt.occurredDate).toLocaleDateString())}
            {row("Due date", receipt.dueDate ? new Date(receipt.dueDate).toLocaleDateString() : null)}
            {row("Interest rate", receipt.interestRate != null ? `${receipt.interestRate}%` : null)}
            {row("Interest paid", receipt.interestPaid ? fmtMoney(receipt.interestPaid, receipt.currency) : null)}
            {row("Issued by", receipt.issuedBy)}
          </div>
        </div>

        <div className="flex items-start gap-2.5 px-1">
          <ShieldCheck className="w-4 h-4 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
          <p className="font-mono text-[10px] text-muted-foreground/50">
            This is a system-generated, read-only receipt. Generated {new Date(receipt.generatedAt).toLocaleString()}.
          </p>
        </div>
      </div>
    </div>
  );
}
