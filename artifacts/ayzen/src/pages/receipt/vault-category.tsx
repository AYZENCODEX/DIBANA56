/**
 * pages/receipt/vault-category.tsx
 * Public, unauthenticated "fantastic themed" aggregate receipt for a Vault
 * Category — account count, avg age, avg followers, total worth/buy value/
 * P&L across every local account in that category for the issuing user.
 * Mirrors pages/receipt/local.tsx's routing/loading/error pattern.
 * Registered in App.tsx as /receipt/vault-category/:token (outside
 * AppLayout, no auth).
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { categoryReceiptApi } from "@/lib/receipt-api";
import { FantasticReceiptView, FantasticReceiptLoading, FantasticReceiptError } from "@/components/receipt/fantastic-receipt-view";

interface PublicCategoryReceipt {
  id: number;
  category: string;
  accountCount: number;
  avgFollowers: number | null;
  avgAge: string | null;
  totalWorth: number;
  totalBuyValue: number;
  totalPnl: number | null;
  pnlPct: number | null;
  issuedBy: string | null;
  generatedAt: string;
}

export default function VaultCategoryReceiptPublic() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PublicCategoryReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;
    categoryReceiptApi.getPublic(params.token)
      .then(setData)
      .catch((e: any) => setError(e?.message ?? "This receipt link is invalid or has been revoked."));
  }, [params.token]);

  if (error) return <FantasticReceiptError message={error} />;
  if (!data) return <FantasticReceiptLoading />;

  const displayName = data.category.charAt(0).toUpperCase() + data.category.slice(1);
  const hasPnl = data.pnlPct !== null;

  return (
    <FantasticReceiptView
      kicker="Vault Category Receipt"
      title={displayName}
      subtitle={`${data.accountCount} account${data.accountCount === 1 ? "" : "s"}`}
      avatarLetter={displayName}
      heroLabel={hasPnl ? "Category P&L" : "Total Worth"}
      heroValue={hasPnl ? `${data.pnlPct! >= 0 ? "+" : ""}${data.pnlPct!.toFixed(1)}%` : `$${data.totalWorth.toFixed(2)}`}
      heroPositive={hasPnl ? data.pnlPct! >= 0 : undefined}
      stats={[
        { label: "Accounts", value: String(data.accountCount) },
        { label: "Avg Age", value: data.avgAge ?? "—" },
        { label: "Avg Followers", value: data.avgFollowers !== null ? data.avgFollowers.toFixed(0) : "—" },
        { label: "Total Worth", value: `$${data.totalWorth.toFixed(2)}`, color: "#34d399" },
        { label: "Total Buy Value", value: `$${data.totalBuyValue.toFixed(2)}` },
        {
          label: "Total P&L",
          value: data.totalPnl !== null ? `${data.totalPnl >= 0 ? "+" : ""}$${data.totalPnl.toFixed(2)}` : "—",
          color: data.totalPnl !== null ? (data.totalPnl >= 0 ? "#34d399" : "#f87171") : undefined,
        },
      ]}
      receiptId={data.id}
      issuedBy={data.issuedBy}
      generatedAt={data.generatedAt}
      pdfUrl={categoryReceiptApi.publicPdfUrl(params.token!)}
    />
  );
}
