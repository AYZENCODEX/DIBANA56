/**
 * lib/compliance-report-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 14 — Compliance Audit Report Export.
 * Thin typed wrapper around customFetch for routes/compliance-report.ts.
 */
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

function vaultApiPath(path: string): string {
  return `${getApiBase()}/api${path}`;
}

export type ReportFormat = "csv" | "pdf";

async function downloadBlob(url: string, filename: string): Promise<void> {
  const blob = await customFetch<Blob>(url, { responseType: "blob" });
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

/** Downloads the caller's own compliance report for the given date range. */
export function downloadComplianceReport(from: string, to: string, format: ReportFormat): Promise<void> {
  const qs = new URLSearchParams({ from, to, format }).toString();
  return downloadBlob(vaultApiPath(`/compliance/report?${qs}`), `ayzen-compliance-report-${from}_to_${to}.${format}`);
}

/** Admin-only: downloads a compliance report for any user by id. */
export function downloadAdminComplianceReport(userId: number, from: string, to: string, format: ReportFormat): Promise<void> {
  const qs = new URLSearchParams({ userId: String(userId), from, to, format }).toString();
  return downloadBlob(vaultApiPath(`/admin/compliance/report?${qs}`), `ayzen-compliance-report-user${userId}-${from}_to_${to}.${format}`);
}
