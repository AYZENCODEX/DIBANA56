const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function authHeaders(token: string | null) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` };
}

async function handle(r: Response) {
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error ?? `Request failed (${r.status})`);
  }
  return r.json();
}

export const financeApi = {
  // Parties
  listParties: (token: string | null) => fetch(`${BASE}/api/finance/parties`, { headers: authHeaders(token) }).then(handle),
  createParty: (token: string | null, data: any) => fetch(`${BASE}/api/finance/parties`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),

  // Entries
  listEntries: (token: string | null, params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
    return fetch(`${BASE}/api/finance/entries${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) }).then(handle);
  },
  createEntry: (token: string | null, data: any) => fetch(`${BASE}/api/finance/entries`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateEntry: (token: string | null, id: number, data: any) => fetch(`${BASE}/api/finance/entries/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteEntry: (token: string | null, id: number) => fetch(`${BASE}/api/finance/entries/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),
  addRepayment: (token: string | null, id: number, data: any) => fetch(`${BASE}/api/finance/entries/${id}/repayments`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  listRepayments: (token: string | null, id: number) => fetch(`${BASE}/api/finance/entries/${id}/repayments`, { headers: authHeaders(token) }).then(handle),

  // Assets
  listAssets: (token: string | null, assetType?: string) => fetch(`${BASE}/api/finance/assets${assetType ? `?assetType=${assetType}` : ""}`, { headers: authHeaders(token) }).then(handle),
  createAsset: (token: string | null, data: any) => fetch(`${BASE}/api/finance/assets`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateAsset: (token: string | null, id: number, data: any) => fetch(`${BASE}/api/finance/assets/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteAsset: (token: string | null, id: number) => fetch(`${BASE}/api/finance/assets/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  // Attachments (receipts / invoices) on a ledger entry
  listAttachments: (token: string | null, entryId: number) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/attachments`, { headers: authHeaders(token) }).then(handle),
  uploadAttachment: (token: string | null, entryId: number, data: { fileName: string; mimeType: string; note?: string; dataBase64: string }) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/attachments`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteAttachment: (token: string | null, entryId: number, attachmentId: number) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/attachments/${attachmentId}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  // Public receipt link — mint/revoke require the owner's token; the receipt
  // itself (JSON + PDF) is unauthenticated, so those two never send a token.
  createReceiptLink: (token: string | null, entryId: number): Promise<{ token: string; url: string }> =>
    fetch(`${BASE}/api/finance/entries/${entryId}/receipt`, { method: "POST", headers: authHeaders(token) }).then(handle),
  revokeReceiptLink: (token: string | null, entryId: number) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/receipt`, { method: "DELETE", headers: authHeaders(token) }).then(handle),
  getPublicReceipt: (receiptToken: string) =>
    fetch(`${BASE}/api/finance/receipt/${receiptToken}`).then(handle),
  publicReceiptPdfUrl: (receiptToken: string) => `${BASE}/api/finance/receipt/${receiptToken}/pdf`,
  // The download route needs a bearer token, which an <a href>/<img src> can't
  // send — fetch as a blob and hand the browser an object URL instead (same
  // pattern as downloadExport below).
  viewAttachment: async (token: string | null, entryId: number, attachmentId: number, fileName: string) => {
    const r = await fetch(`${BASE}/api/finance/entries/${entryId}/attachments/${attachmentId}?raw=1`, { headers: { Authorization: `Bearer ${token ?? ""}` } });
    if (!r.ok) throw new Error(`Couldn't load attachment (${r.status})`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (blob.type.startsWith("image/") || blob.type === "application/pdf") {
      window.open(url, "_blank");
    } else {
      const a = document.createElement("a");
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  },

  // Smart alerts & insights (health score, overdue/budget alerts, cashflow forecast)
  insights: (token: string | null) => fetch(`${BASE}/api/finance/insights`, { headers: authHeaders(token) }).then(handle),

  // Aggregates
  summary: (token: string | null) => fetch(`${BASE}/api/finance/summary`, { headers: authHeaders(token) }).then(handle),
  investments: (token: string | null) => fetch(`${BASE}/api/finance/investments`, { headers: authHeaders(token) }).then(handle),
  projections: (token: string | null) => fetch(`${BASE}/api/finance/projections`, { headers: authHeaders(token) }).then(handle),
  analytics: (token: string | null) => fetch(`${BASE}/api/finance/analytics`, { headers: authHeaders(token) }).then(handle),

  // Recurring
  listRecurring: (token: string | null) => fetch(`${BASE}/api/finance/recurring`, { headers: authHeaders(token) }).then(handle),
  createRecurring: (token: string | null, data: any) => fetch(`${BASE}/api/finance/recurring`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateRecurring: (token: string | null, id: number, data: any) => fetch(`${BASE}/api/finance/recurring/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteRecurring: (token: string | null, id: number) => fetch(`${BASE}/api/finance/recurring/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),
  runRecurringNow: (token: string | null) => fetch(`${BASE}/api/finance/recurring/run-now`, { method: "POST", headers: authHeaders(token) }).then(handle),

  // Budgets
  listBudgets: (token: string | null) => fetch(`${BASE}/api/finance/budgets`, { headers: authHeaders(token) }).then(handle),
  saveBudget: (token: string | null, data: any) => fetch(`${BASE}/api/finance/budgets`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteBudget: (token: string | null, id: number) => fetch(`${BASE}/api/finance/budgets/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  // Currencies
  listCurrencies: (token: string | null) => fetch(`${BASE}/api/finance/currencies`, { headers: authHeaders(token) }).then(handle),
  setCurrencyRate: (token: string | null, currency: string, rateToBase: number) =>
    fetch(`${BASE}/api/finance/currencies/${currency}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ rateToBase }) }).then(handle),

  // Import / Export
  importCsv: (token: string | null, csv: string) => fetch(`${BASE}/api/finance/entries/import`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ csv }) }).then(handle),
  downloadExport: async (token: string | null, kind: string | undefined, format: "csv" | "pdf") => {
    const qs = new URLSearchParams({ ...(kind ? { kind } : {}), format }).toString();
    const r = await fetch(`${BASE}/api/finance/export?${qs}`, { headers: authHeaders(token) });
    if (!r.ok) throw new Error(`Export failed (${r.status})`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ayzen-finance-${kind ?? "all"}-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // ─── Accounting (Chart of Accounts / Journal / Reports / Amortization) ────
  listAccounts: (token: string | null, params: { bookId?: string | number } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return fetch(`${BASE}/api/finance/accounts${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) }).then(handle);
  },
  createAccount: (token: string | null, data: any) => fetch(`${BASE}/api/finance/accounts`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateAccount: (token: string | null, id: number, data: any) => fetch(`${BASE}/api/finance/accounts/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteAccount: (token: string | null, id: number) => fetch(`${BASE}/api/finance/accounts/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  listJournal: (token: string | null, params: { accountId?: number; bookId?: string | number } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return fetch(`${BASE}/api/finance/journal${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) }).then(handle);
  },
  getJournalEntry: (token: string | null, id: number) => fetch(`${BASE}/api/finance/journal/${id}`, { headers: authHeaders(token) }).then(handle),
  createJournalEntry: (token: string | null, data: any) => fetch(`${BASE}/api/finance/journal`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteJournalEntry: (token: string | null, id: number) => fetch(`${BASE}/api/finance/journal/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  trialBalance: (token: string | null, asOf?: string) =>
    fetch(`${BASE}/api/finance/reports/trial-balance${asOf ? `?asOf=${asOf}` : ""}`, { headers: authHeaders(token) }).then(handle),
  balanceSheet: (token: string | null, asOf?: string) =>
    fetch(`${BASE}/api/finance/reports/balance-sheet${asOf ? `?asOf=${asOf}` : ""}`, { headers: authHeaders(token) }).then(handle),
  incomeStatement: (token: string | null, from?: string, to?: string) => {
    const qs = new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v) as [string, string][]).toString();
    return fetch(`${BASE}/api/finance/reports/income-statement${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) }).then(handle);
  },
  cashFlow: (token: string | null, from?: string, to?: string) => {
    const qs = new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v) as [string, string][]).toString();
    return fetch(`${BASE}/api/finance/reports/cash-flow${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) }).then(handle);
  },

  listAmortization: (token: string | null, entryId: number) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/amortization`, { headers: authHeaders(token) }).then(handle),
  generateAmortization: (token: string | null, entryId: number, termMonths: number) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/amortization/generate`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ termMonths }) }).then(handle),
  payAmortizationInstallment: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/amortization/${id}/pay`, { method: "PUT", headers: authHeaders(token) }).then(handle),

  // ─── Depreciation (fixed assets) ──────────────────────────────────────────
  listDepreciation: (token: string | null, assetId: number) =>
    fetch(`${BASE}/api/finance/assets/${assetId}/depreciation`, { headers: authHeaders(token) }).then(handle),
  generateDepreciation: (token: string | null, assetId: number, data: { method: "straight_line" | "declining_balance"; usefulLifeMonths: number; salvageValue?: number; startDate?: string }) =>
    fetch(`${BASE}/api/finance/assets/${assetId}/depreciation/generate`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  postDepreciationPeriod: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/depreciation/${id}/post`, { method: "PUT", headers: authHeaders(token) }).then(handle),

  // ─── Invoicing (line items on a receivable entry) ─────────────────────────
  listInvoiceLines: (token: string | null, entryId: number) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/invoice-lines`, { headers: authHeaders(token) }).then(handle),
  saveInvoiceLines: (token: string | null, entryId: number, lines: { description: string; quantity?: number; unitPrice?: number; taxPercent?: number }[]) =>
    fetch(`${BASE}/api/finance/entries/${entryId}/invoice-lines`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ lines }) }).then(handle),

  // ─── Net Worth (breakdown + trend) ─────────────────────────────────────────
  netWorth: (token: string | null) => fetch(`${BASE}/api/finance/net-worth`, { headers: authHeaders(token) }).then(handle),
  netWorthHistory: (token: string | null, months = 12) =>
    fetch(`${BASE}/api/finance/net-worth/history?months=${months}`, { headers: authHeaders(token) }).then(handle),
  snapshotNetWorthNow: (token: string | null) =>
    fetch(`${BASE}/api/finance/net-worth/snapshot`, { method: "POST", headers: authHeaders(token) }).then(handle),

  // ─── Financial Goals ────────────────────────────────────────────────────────
  listGoals: (token: string | null) => fetch(`${BASE}/api/finance/goals`, { headers: authHeaders(token) }).then(handle),
  createGoal: (token: string | null, data: any) => fetch(`${BASE}/api/finance/goals`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateGoal: (token: string | null, id: number, data: any) => fetch(`${BASE}/api/finance/goals/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteGoal: (token: string | null, id: number) => fetch(`${BASE}/api/finance/goals/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),
  contributeToGoal: (token: string | null, id: number, amount: number) =>
    fetch(`${BASE}/api/finance/goals/${id}/contribute`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ amount }) }).then(handle),

  // ─── AI Assist (Phase 2 — Smart Entry) ─────────────────────────────────────
  quickEntryPreview: (token: string | null, text: string, currency?: string) =>
    fetch(`${BASE}/api/finance/ai/quick-entry/preview`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ text, currency }) }).then(handle),
  quickEntryCommit: (token: string | null, entries: any[]) =>
    fetch(`${BASE}/api/finance/ai/quick-entry/commit`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ entries }) }).then(handle),
  aiQuery: (token: string | null, question: string) =>
    fetch(`${BASE}/api/finance/ai/query`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ question }) }).then(handle),
  aiAnomalies: (token: string | null) =>
    fetch(`${BASE}/api/finance/ai/anomalies`, { headers: authHeaders(token) }).then(handle),
  aiRecurringSuggestions: (token: string | null) =>
    fetch(`${BASE}/api/finance/ai/recurring-suggestions`, { headers: authHeaders(token) }).then(handle),
  scanReceipt: (token: string | null, imageBase64: string, currency?: string) =>
    fetch(`${BASE}/api/finance/ai/receipt-scan`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ imageBase64, currency }) }).then(handle),
  getSmsWebhook: (token: string | null) =>
    fetch(`${BASE}/api/finance/ai/sms-webhook-token`, { headers: authHeaders(token) }).then(handle),
  rotateSmsWebhook: (token: string | null) =>
    fetch(`${BASE}/api/finance/ai/sms-webhook-token/rotate`, { method: "POST", headers: authHeaders(token) }).then(handle),

  // ─── Books (Phase 3 — Multi-book: Business vs Personal separate ledgers) ──
  listBooks: (token: string | null) => fetch(`${BASE}/api/finance/books`, { headers: authHeaders(token) }).then(handle),
  createBook: (token: string | null, data: { name: string; bookType?: string; currency?: string; notes?: string }) =>
    fetch(`${BASE}/api/finance/books`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateBook: (token: string | null, id: number, data: any) =>
    fetch(`${BASE}/api/finance/books/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  setDefaultBook: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/books/${id}/set-default`, { method: "PUT", headers: authHeaders(token) }).then(handle),
  deleteBook: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/books/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  // ─── Custom report builder + scheduled reports (Phase 4 — Advanced reporting) ─
  customReport: (token: string | null, params: { groupBy?: string; from?: string; to?: string; kind?: string; category?: string; bookId?: number }) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    return fetch(`${BASE}/api/finance/reports/custom${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) }).then(handle);
  },
  downloadCustomReport: async (token: string | null, params: Record<string, string | number | undefined>, format: "csv" | "pdf") => {
    const qs = new URLSearchParams({ ...(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))), format }).toString();
    const r = await fetch(`${BASE}/api/finance/reports/custom?${qs}`, { headers: authHeaders(token) });
    if (!r.ok) throw new Error(`Export failed (${r.status})`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finance-report.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  listReportSchedules: (token: string | null) => fetch(`${BASE}/api/finance/report-schedules`, { headers: authHeaders(token) }).then(handle),
  createReportSchedule: (token: string | null, data: { bookId?: number; reportType?: string; dayOfMonth?: number }) =>
    fetch(`${BASE}/api/finance/report-schedules`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updateReportSchedule: (token: string | null, id: number, data: { active?: boolean; dayOfMonth?: number }) =>
    fetch(`${BASE}/api/finance/report-schedules/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deleteReportSchedule: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/report-schedules/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),
};

// ─── Phase 5: Invoices, Peer Payment Gateway, Payment Agreements ────────────
export const financeInvoiceApi = {
  // Payment methods (creditor's own receiving destinations)
  listPaymentMethods: (token: string | null) => fetch(`${BASE}/api/finance/payment-methods`, { headers: authHeaders(token) }).then(handle),
  createPaymentMethod: (token: string | null, data: any) =>
    fetch(`${BASE}/api/finance/payment-methods`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  updatePaymentMethod: (token: string | null, id: number, data: any) =>
    fetch(`${BASE}/api/finance/payment-methods/${id}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  deletePaymentMethod: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/payment-methods/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),

  // Invoices (creditor side)
  listInvoices: (token: string | null, entryId?: number) =>
    fetch(`${BASE}/api/finance/invoices${entryId ? `?entryId=${entryId}` : ""}`, { headers: authHeaders(token) }).then(handle),
  createInvoice: (token: string | null, data: any) =>
    fetch(`${BASE}/api/finance/invoices`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  getInvoice: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/invoices/${id}`, { headers: authHeaders(token) }).then(handle),
  updateInvoiceLineItems: (token: string | null, id: number, lineItems: { description: string; quantity: number; unitPrice: number }[]) =>
    fetch(`${BASE}/api/finance/invoices/${id}/line-items`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ lineItems }) }).then(handle),
  sendInvoice: (token: string | null, id: number, channels?: string[]) =>
    fetch(`${BASE}/api/finance/invoices/${id}/send`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ channels }) }).then(handle),
  cancelInvoice: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/invoices/${id}`, { method: "DELETE", headers: authHeaders(token) }).then(handle),
  reopenInvoice: (token: string | null, id: number) =>
    fetch(`${BASE}/api/finance/invoices/${id}/reopen`, { method: "POST", headers: authHeaders(token) }).then(handle),
  invoicePdfUrl: (id: number) => `${BASE}/api/finance/invoices/${id}/pdf`,

  // Invoice branding (per-user logo/theme, reused on every invoice)
  getInvoiceBranding: (token: string | null) => fetch(`${BASE}/api/finance/invoice-branding`, { headers: authHeaders(token) }).then(handle),
  updateInvoiceBranding: (token: string | null, data: Partial<{
    logoUrl: string; themeColor: string; businessName: string; businessAddress: string; footerNote: string;
    taxId: string; businessEmail: string; businessPhone: string; website: string; termsText: string; numberPrefix: string;
  }>) =>
    fetch(`${BASE}/api/finance/invoice-branding`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),

  // Public "Repay" page
  getPublicInvoice: (invoiceToken: string) => fetch(`${BASE}/api/finance/invoices/public/${invoiceToken}`).then(handle),
  submitPayment: (token: string | null, invoiceToken: string, data: { methodType: string; referenceId?: string; amount?: number }) =>
    fetch(`${BASE}/api/finance/invoices/public/${invoiceToken}/submit-payment`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  publicInvoicePdfUrl: (invoiceToken: string) => `${BASE}/api/finance/invoices/public/${invoiceToken}/pdf`,

  // Public "Payment Agreement" page
  getPublicAgreement: (agreementToken: string) => fetch(`${BASE}/api/finance/payment-agreements/public/${agreementToken}`).then(handle),
  agreementPasskeyOptions: (token: string | null, agreementToken: string) =>
    fetch(`${BASE}/api/finance/payment-agreements/public/${agreementToken}/passkey/options`, { method: "POST", headers: authHeaders(token) }).then(handle),
  agreementPasskeyVerify: (token: string | null, agreementToken: string, data: { challengeKey: string; response: any }) =>
    fetch(`${BASE}/api/finance/payment-agreements/public/${agreementToken}/passkey/verify`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) }).then(handle),
  evidencePdfUrl: (agreementToken: string) => `${BASE}/api/finance/payment-agreements/public/${agreementToken}/evidence-pdf`,

  // Creditor review
  verifyAgreement: (token: string | null, agreementId: number, notes?: string) =>
    fetch(`${BASE}/api/finance/payment-agreements/${agreementId}/verify`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ notes }) }).then(handle),
  disputeAgreement: (token: string | null, agreementId: number, reason: string) =>
    fetch(`${BASE}/api/finance/payment-agreements/${agreementId}/dispute`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ reason }) }).then(handle),
};
