/**
 * pages/receipt/local.tsx
 * Public, unauthenticated "fantastic themed" receipt for a Local Entity —
 * username, followers, age, price, P&L. Mirrors pages/finance/receipt.tsx's
 * routing/loading/error pattern but renders through FantasticReceiptView.
 * Registered in App.tsx as /receipt/local/:token (outside AppLayout, no auth).
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { localEntityReceiptApi } from "@/lib/receipt-api";
import { FantasticReceiptView, FantasticReceiptLoading, FantasticReceiptError } from "@/components/receipt/fantastic-receipt-view";

interface PublicLocalReceipt {
  id: number;
  category: string | null;
  label: string | null;
  username: string | null;
  followers: string | number | null;
  age: string | null;
  accountWorth: number;
  buyPrice: number;
  profit: number | null;
  roiPct: number | null;
  status: string | null;
  score: number | null;
  issuedBy: string | null;
  generatedAt: string;
}

export default function LocalEntityReceiptPublic() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PublicLocalReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;
    localEntityReceiptApi.getPublic(params.token)
      .then(setData)
      .catch((e: any) => setError(e?.message ?? "This receipt link is invalid or has been revoked."));
  }, [params.token]);

  if (error) return <FantasticReceiptError message={error} />;
  if (!data) return <FantasticReceiptLoading />;

  const displayName = data.label || data.username || `Local Entity #${data.id}`;
  const hasRoi = data.roiPct !== null;

  return (
    <FantasticReceiptView
      kicker="Local Entity Receipt"
      title={displayName}
      subtitle={[data.category, data.username ? `@${data.username}` : null].filter(Boolean).join(" · ") || undefined}
      avatarLetter={displayName}
      heroLabel={hasRoi ? "Profit & Loss" : "Account Worth"}
      heroValue={hasRoi ? `${data.roiPct! >= 0 ? "+" : ""}${data.roiPct!.toFixed(1)}%` : `$${data.accountWorth.toFixed(2)}`}
      heroPositive={hasRoi ? data.roiPct! >= 0 : undefined}
      stats={[
        { label: "Username", value: data.username ? `@${data.username}` : "—" },
        { label: "Followers", value: data.followers != null ? String(data.followers) : "—" },
        { label: "Account Age", value: data.age ?? "—" },
        { label: "Current Worth", value: `$${data.accountWorth.toFixed(2)}`, color: "#34d399" },
        { label: "Buy Price", value: `$${data.buyPrice.toFixed(2)}` },
        {
          label: "Net Profit",
          value: data.profit != null ? `${data.profit >= 0 ? "+" : ""}$${data.profit.toFixed(2)}` : "—",
          color: data.profit != null ? (data.profit >= 0 ? "#34d399" : "#f87171") : undefined,
        },
      ]}
      receiptId={data.id}
      issuedBy={data.issuedBy}
      generatedAt={data.generatedAt}
      pdfUrl={localEntityReceiptApi.publicPdfUrl(params.token!)}
    />
  );
}
