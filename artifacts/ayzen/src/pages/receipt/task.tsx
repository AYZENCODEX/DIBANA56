/**
 * pages/receipt/task.tsx
 * Public, unauthenticated "fantastic themed" receipt for a Task Submission —
 * task name, project, task number, cost, profit, net profit. Mirrors
 * pages/receipt/local.tsx's routing/loading/error pattern. Registered in
 * App.tsx as /receipt/task/:token (outside AppLayout, no auth).
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { taskReceiptApi } from "@/lib/receipt-api";
import { FantasticReceiptView, FantasticReceiptLoading, FantasticReceiptError } from "@/components/receipt/fantastic-receipt-view";

interface PublicTaskReceipt {
  id: number;
  taskId: string | null;
  taskName: string;
  projectName: string | null;
  status: string;
  cost: number;
  profit: number;
  netProfit: number;
  issuedBy: string | null;
  submittedAt: string;
  generatedAt: string;
}

export default function TaskSubmissionReceiptPublic() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PublicTaskReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;
    taskReceiptApi.getPublic(params.token)
      .then(setData)
      .catch((e: any) => setError(e?.message ?? "This receipt link is invalid or has been revoked."));
  }, [params.token]);

  if (error) return <FantasticReceiptError message={error} />;
  if (!data) return <FantasticReceiptLoading />;

  return (
    <FantasticReceiptView
      kicker="Task Submission Receipt"
      title={data.taskName}
      subtitle={[data.projectName, data.taskId].filter(Boolean).join(" · ") || undefined}
      avatarLetter={data.taskName}
      heroLabel="Net Profit"
      heroValue={`${data.netProfit >= 0 ? "+" : ""}$${data.netProfit.toFixed(2)}`}
      heroPositive={data.netProfit >= 0}
      stats={[
        { label: "Task Number", value: data.taskId ?? "—" },
        { label: "Project", value: data.projectName ?? "—" },
        { label: "Status", value: data.status },
        { label: "Cost", value: `$${data.cost.toFixed(2)}`, color: "#f87171" },
        { label: "Profit", value: `$${data.profit.toFixed(2)}`, color: "#34d399" },
        {
          label: "Net Profit",
          value: `${data.netProfit >= 0 ? "+" : ""}$${data.netProfit.toFixed(2)}`,
          color: data.netProfit >= 0 ? "#34d399" : "#f87171",
        },
      ]}
      receiptId={data.id}
      issuedBy={data.issuedBy}
      generatedAt={data.generatedAt}
      pdfUrl={taskReceiptApi.publicPdfUrl(params.token!)}
    />
  );
}
