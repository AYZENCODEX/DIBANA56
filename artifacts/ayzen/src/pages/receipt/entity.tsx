/**
 * pages/receipt/entity.tsx
 * Public, unauthenticated "fantastic themed" receipt for a Vault Entity —
 * username, followers, age, worth, P&L across the entity + linked
 * platforms. Registered in App.tsx as /receipt/entity/:token.
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { vaultEntityReceiptApi } from "@/lib/receipt-api";
import { FantasticReceiptView, FantasticReceiptLoading, FantasticReceiptError } from "@/components/receipt/fantastic-receipt-view";

interface PublicVaultReceipt {
  id: number;
  entitySerial: string | null;
  projectName: string | null;
  category: string | null;
  username: string | null;
  followers: number | null;
  age: string | null;
  worth: number;
  buyValue: number;
  profit: number | null;
  roiPct: number | null;
  status: string | null;
  score: number | null;
  issuedBy: string | null;
  generatedAt: string;
}

export default function VaultEntityReceiptPublic() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PublicVaultReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;
    vaultEntityReceiptApi.getPublic(params.token)
      .then(setData)
      .catch((e: any) => setError(e?.message ?? "This receipt link is invalid or has been revoked."));
  }, [params.token]);

  if (error) return <FantasticReceiptError message={error} />;
  if (!data) return <FantasticReceiptLoading />;

  const displayName = data.projectName || data.entitySerial || `Vault Entity #${data.id}`;
  const hasRoi = data.roiPct !== null;

  return (
    <FantasticReceiptView
      kicker="Vault Entity Receipt"
      title={displayName}
      subtitle={[data.category, data.username ? `@${data.username}` : null].filter(Boolean).join(" · ") || data.entitySerial || undefined}
      avatarLetter={displayName}
      heroLabel={hasRoi ? "Profit & Loss" : "Total Worth"}
      heroValue={hasRoi ? `${data.roiPct! >= 0 ? "+" : ""}${data.roiPct!.toFixed(1)}%` : `$${data.worth.toFixed(2)}`}
      heroPositive={hasRoi ? data.roiPct! >= 0 : undefined}
      stats={[
        { label: "Username", value: data.username ? `@${data.username}` : "—" },
        { label: "Followers", value: data.followers != null ? String(data.followers) : "—" },
        { label: "Account Age", value: data.age ?? "—" },
        { label: "Total Worth", value: `$${data.worth.toFixed(2)}`, color: "#34d399" },
        { label: "Buy Value", value: `$${data.buyValue.toFixed(2)}` },
        {
          label: "Net Profit",
          value: data.profit != null ? `${data.profit >= 0 ? "+" : ""}$${data.profit.toFixed(2)}` : "—",
          color: data.profit != null ? (data.profit >= 0 ? "#34d399" : "#f87171") : undefined,
        },
      ]}
      receiptId={data.id}
      issuedBy={data.issuedBy}
      generatedAt={data.generatedAt}
      pdfUrl={vaultEntityReceiptApi.publicPdfUrl(params.token!)}
    />
  );
}
