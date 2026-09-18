/**
 * lib/receipt-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Client for the "fantastic themed" public receipt types added alongside the
 * existing Finance ledger receipt (lib/finance-api.ts):
 *   - Local Entity   → POST/DELETE /local-accounts/:id/receipt,              GET /local-accounts/receipt/:token(/pdf)
 *   - Vault Entity   → POST/DELETE /vault/:id/receipt,                       GET /vault/receipt/:token(/pdf)
 *   - Project P&L    → POST/DELETE /projects/:id/pnl-receipt,                GET /projects/pnl-receipt/:token(/pdf)
 *   - Task Submission→ POST/DELETE /tasks/submissions/:id/receipt,           GET /tasks/submissions/receipt/:token(/pdf)
 *                       POST /tasks/submissions/:id/receipt/email
 *   - Vault Category → POST/DELETE /local-accounts/category-receipt/:category, GET /local-accounts/category-receipt/:token(/pdf)
 *                       POST /local-accounts/category-receipt/:category/email
 *
 * Mint/revoke/email go through customFetch (owner-authenticated, bearer token
 * attached automatically). The public GET/PDF routes need no auth — plain
 * fetch, same pattern as financeApi.getPublicReceipt/publicReceiptPdfUrl.
 */
import { customFetch } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export interface ReceiptLink {
  token: string;
  url: string;
}

async function handlePublic(r: Response) {
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error ?? `Request failed (${r.status})`);
  }
  return r.json();
}

export const localEntityReceiptApi = {
  create: (id: number): Promise<ReceiptLink> =>
    customFetch<ReceiptLink>(`/api/local-accounts/${id}/receipt`, { method: "POST" }),
  revoke: (id: number) =>
    customFetch<{ success: boolean }>(`/api/local-accounts/${id}/receipt`, { method: "DELETE" }),
  getPublic: (token: string) =>
    fetch(`${BASE}/api/local-accounts/receipt/${token}`).then(handlePublic),
  publicPdfUrl: (token: string) => `${BASE}/api/local-accounts/receipt/${token}/pdf`,
};

export const vaultEntityReceiptApi = {
  create: (id: number): Promise<ReceiptLink> =>
    customFetch<ReceiptLink>(`/api/vault/${id}/receipt`, { method: "POST" }),
  revoke: (id: number) =>
    customFetch<{ success: boolean }>(`/api/vault/${id}/receipt`, { method: "DELETE" }),
  getPublic: (token: string) =>
    fetch(`${BASE}/api/vault/receipt/${token}`).then(handlePublic),
  publicPdfUrl: (token: string) => `${BASE}/api/vault/receipt/${token}/pdf`,
};

export const projectPnlReceiptApi = {
  create: (projectId: number): Promise<ReceiptLink> =>
    customFetch<ReceiptLink>(`/api/projects/${projectId}/pnl-receipt`, { method: "POST" }),
  revoke: (projectId: number) =>
    customFetch<{ success: boolean }>(`/api/projects/${projectId}/pnl-receipt`, { method: "DELETE" }),
  getPublic: (token: string) =>
    fetch(`${BASE}/api/projects/pnl-receipt/${token}`).then(handlePublic),
  publicPdfUrl: (token: string) => `${BASE}/api/projects/pnl-receipt/${token}/pdf`,
};

// Task submission receipt — keyed by submission id. Minted automatically on
// submit, but can also be minted/re-fetched on demand here. Also supports
// emailing the link straight to the submitter (routes/tasks.ts).
export const taskReceiptApi = {
  create: (submissionId: number): Promise<ReceiptLink> =>
    customFetch<ReceiptLink>(`/api/tasks/submissions/${submissionId}/receipt`, { method: "POST" }),
  revoke: (submissionId: number) =>
    customFetch<{ success: boolean }>(`/api/tasks/submissions/${submissionId}/receipt`, { method: "DELETE" }),
  getPublic: (token: string) =>
    fetch(`${BASE}/api/tasks/submissions/receipt/${token}`).then(handlePublic),
  publicPdfUrl: (token: string) => `${BASE}/api/tasks/submissions/receipt/${token}/pdf`,
  sendEmail: (submissionId: number) =>
    customFetch<{ success: boolean }>(`/api/tasks/submissions/${submissionId}/receipt/email`, { method: "POST" }),
};

// Vault category receipt — an aggregate (count/avg age/avg followers/P&L)
// snapshot across every local account in one category, keyed by the category
// name itself rather than a single row id (routes/local-accounts.ts).
export const categoryReceiptApi = {
  create: (category: string): Promise<ReceiptLink> =>
    customFetch<ReceiptLink>(`/api/local-accounts/category-receipt/${encodeURIComponent(category)}`, { method: "POST" }),
  revoke: (category: string) =>
    customFetch<{ success: boolean }>(`/api/local-accounts/category-receipt/${encodeURIComponent(category)}`, { method: "DELETE" }),
  getPublic: (token: string) =>
    fetch(`${BASE}/api/local-accounts/category-receipt/${token}`).then(handlePublic),
  publicPdfUrl: (token: string) => `${BASE}/api/local-accounts/category-receipt/${token}/pdf`,
  sendEmail: (category: string) =>
    customFetch<{ success: boolean }>(`/api/local-accounts/category-receipt/${encodeURIComponent(category)}/email`, { method: "POST" }),
};
