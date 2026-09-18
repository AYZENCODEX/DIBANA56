/**
 * pages/receipt/project.tsx
 * Public, unauthenticated "fantastic themed" receipt for a user's P&L on a
 * project — same numbers as pages/user/finance/pnl.tsx's per-project row
 * (invested / spent / earned / net PnL / %), just shareable via link/PDF.
 * Registered in App.tsx as /receipt/project/:token.
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { projectPnlReceiptApi } from "@/lib/receipt-api";
import { FantasticReceiptView, FantasticReceiptLoading, FantasticReceiptError } from "@/components/receipt/fantastic-receipt-view";

interface PublicProjectReceipt {
  id: number;
  projectId: number;
  projectName: string;
  projectTier: string | number | null;
  invested: number;
  spent: number;
  earned: number;
  netPnl: number;
  netPosition: number;
  roiPct: number | null;
  issuedBy: string | null;
  generatedAt: string;
}

export default function ProjectPnlReceiptPublic() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PublicProjectReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;
    projectPnlReceiptApi.getPublic(params.token)
      .then(setData)
      .catch((e: any) => setError(e?.message ?? "This receipt link is invalid or has been revoked."));
  }, [params.token]);

  if (error) return <FantasticReceiptError message={error} />;
  if (!data) return <FantasticReceiptLoading />;

  const hasRoi = data.roiPct !== null;

  return (
    <FantasticReceiptView
      kicker="Project P&L Receipt"
      title={data.projectName}
      subtitle={data.projectTier != null ? `Tier ${data.projectTier}` : undefined}
      avatarLetter={data.projectName}
      heroLabel={hasRoi ? "Return on Investment" : "Net P&L"}
      heroValue={hasRoi ? `${data.roiPct! >= 0 ? "+" : ""}${data.roiPct!.toFixed(1)}%` : `${data.netPnl >= 0 ? "+" : ""}$${data.netPnl.toFixed(2)}`}
      heroPositive={hasRoi ? data.roiPct! >= 0 : data.netPnl >= 0}
      stats={[
        { label: "Invested", value: `$${data.invested.toFixed(2)}` },
        { label: "Earned", value: `$${data.earned.toFixed(2)}`, color: "#34d399" },
        { label: "Spent", value: `$${data.spent.toFixed(2)}`, color: "#f87171" },
        { label: "Net PnL", value: `${data.netPnl >= 0 ? "+" : ""}$${data.netPnl.toFixed(2)}`, color: data.netPnl >= 0 ? "#34d399" : "#f87171" },
        { label: "Net Position", value: `$${data.netPosition.toFixed(2)}` },
      ]}
      receiptId={data.id}
      issuedBy={data.issuedBy}
      generatedAt={data.generatedAt}
      pdfUrl={projectPnlReceiptApi.publicPdfUrl(params.token!)}
    />
  );
}
