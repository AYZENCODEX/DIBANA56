export type FinanceKind =
  | "receivable" | "payable" | "borrowed" | "lending"
  | "investment" | "expense" | "income";

export const KIND_LABELS: Record<FinanceKind, string> = {
  receivable: "Receivable",
  payable: "Payable",
  borrowed: "Borrowed Fund",
  lending: "Lending",
  investment: "Investment",
  expense: "Expense",
  income: "Income",
};

export type FinanceStatus = "pending" | "partial" | "paid" | "overdue" | "active" | "closed";

export const STATUS_STYLES: Record<string, string> = {
  pending: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  partial: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  paid: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  overdue: "text-red-400 border-red-400/30 bg-red-400/10",
  active: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  closed: "text-muted-foreground border-border bg-muted/10",
};

export const STATUS_OPTIONS: FinanceStatus[] = ["pending", "partial", "paid", "overdue", "active", "closed"];

export type AssetType = "cash" | "bank" | "online" | "mutual_fund" | "locked" | "other";

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  cash: "Cash",
  bank: "Bank Account",
  online: "Online / Digital Wallet",
  mutual_fund: "Mutual Fund",
  locked: "Locked / Fixed Deposit",
  other: "Other Resource",
};

export const ASSET_TYPE_LIQUIDITY_HINT: Record<AssetType, string> = {
  cash: "Instant",
  bank: "Instant",
  online: "Instant",
  mutual_fund: "Medium",
  locked: "Locked",
  other: "Varies",
};

export interface FinanceParty {
  id: number;
  userId: number;
  name: string;
  contact: string | null;
  notes: string | null;
}

export interface FinanceEntry {
  id: number;
  userId: number;
  kind: FinanceKind;
  title: string;
  amount: number;
  currency: string;
  partyId: number | null;
  projectId: number | null;
  category: string | null;
  interestRate: number | null;
  interestPaid: number;
  dueDate: string | null;
  occurredDate: string;
  status: FinanceStatus;
  notes: string | null;
  lateFeeType: string | null;
  lateFeeRate: number | null;
  lateFeeGraceDays: number;
  lateFeeAccrued: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceAssetOwner {
  id?: number;
  assetId?: number;
  partyId: number | null;
  ownerName: string;
  ownershipPercent: number;
}

export interface FinanceAsset {
  id: number;
  userId: number;
  assetType: AssetType;
  name: string;
  provider: string | null;
  totalValue: number;
  purchasedValue: number | null;
  interestRate: number | null;
  purchaseDate: string | null;
  maturityDate: string | null;
  liquidity: string | null;
  notes: string | null;
  owners: FinanceAssetOwner[];
  depreciationMethod: "straight_line" | "declining_balance" | null;
  usefulLifeMonths: number | null;
  salvageValue: number | null;
  depreciationStartDate: string | null;
}

export function fmtMoney(n: number, currency = "BDT") {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency + " ";
  return `${symbol}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function myShareOf(asset: FinanceAsset): number {
  const mine = asset.owners.filter(o => o.partyId == null);
  const pct = mine.length ? mine.reduce((s, o) => s + o.ownershipPercent, 0) : 100;
  return asset.totalValue * (pct / 100);
}

// ─── v2: Recurring, Budgets, Multi-currency ─────────────────────────────────

export type RecurringFrequency = "daily" | "weekly" | "monthly" | "yearly";

export const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
};

export interface FinanceRecurringRule {
  id: number;
  kind: FinanceKind;
  title: string;
  amount: number;
  currency: string;
  partyId: number | null;
  projectId: number | null;
  category: string | null;
  interestRate: number | null;
  frequency: RecurringFrequency;
  intervalCount: number;
  startDate: string;
  nextRunDate: string;
  endDate: string | null;
  active: boolean;
  lastRunAt: string | null;
  notes: string | null;
  autoInvoice: number;
  invoiceDebtorName: string | null;
  invoiceDebtorEmail: string | null;
  invoiceDebtorTelegramChatId: string | null;
  invoiceDueDays: number;
}

export interface FinanceBudget {
  id: number;
  category: string;
  monthlyLimit: number;
  spent: number;
  notes: string | null;
}

export interface FinanceCurrencyRate {
  currency: string;
  rateToBase: number;
  updatedAt: string | null;
}

export const CURRENCY_OPTIONS = ["BDT", "USD", "EUR", "GBP", "INR", "AED", "SGD"];

// Crypto token symbols the built-in wallet can deposit/withdraw (mirrors
// api-server/src/lib/tokens.ts SUPPORTED_TOKENS' unique symbols — duplicated
// here to avoid an ayzen -> api-server import; same reasoning as
// getRateMap/toBase in routes/finance.ts). These auto-post Finance ledger
// entries via lib/finance-wallet-bridge.ts with `currency` = the token
// symbol, so without a rate row for each one here, /finance/currencies/:currency
// has nothing to convert them with and every dashboard/analytics total
// silently falls back to treating 1 token = 1 BDT. Keep in sync if
// SUPPORTED_TOKENS ever gains a new symbol.
export const CRYPTO_CURRENCY_OPTIONS = ["ETH", "BNB", "POL", "XPL", "ARB", "USDT", "USDC"];

// Preset categories for Expense entries — used by the Expense dialog's
// Category dropdown, and also written automatically onto the Expense entry
// that's auto-posted when a task submission is approved (routes/tasks.ts
// postTaskFinanceEntries): "Cost" when the task carried a profit entry too
// (a spend expecting a return), "Loss" when it had cost only with no profit
// intended at all.
export const EXPENSE_CATEGORIES = [
  "Cost", "Investment", "Transport", "Courtesy", "Fee", "Loss", "Food", "Other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

// ─── v3: Attachments (receipts) + Smart Insights ────────────────────────────

export interface FinanceAttachment {
  id: number;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  note: string | null;
  uploadedAt: string;
}

export type InsightSeverity = "critical" | "warning" | "info";

export interface FinanceAlert {
  severity: InsightSeverity;
  title: string;
  detail: string;
  link?: string;
}

export interface FinanceBudgetStatus {
  category: string;
  spent: number;
  monthlyLimit: number;
  pct: number;
}

export interface FinanceCashflowPoint {
  days: number;
  netChange: number;
  projectedBalance: number;
}

export interface FinanceInsights {
  healthScore: number;
  healthLabel: string;
  alerts: FinanceAlert[];
  budgetStatus: FinanceBudgetStatus[];
  cashflowForecast: FinanceCashflowPoint[];
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹", AED: "د.إ", SGD: "S$",
};

// ─── v4: Double-entry Accounting + Loan Amortization ────────────────────────

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "Asset", liability: "Liability", equity: "Equity", income: "Income", expense: "Expense",
};

export interface FinanceAccount {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: "debit" | "credit";
  parentId: number | null;
  isSystem: number;
}

export interface JournalLine {
  id: number;
  journalEntryId: number;
  accountId: number;
  debit: number;
  credit: number;
  notes: string | null;
}

export interface JournalEntry {
  id: number;
  date: string;
  memo: string;
  sourceLedgerEntryId: number | null;
  isManual: number;
  lines: JournalLine[];
}

export interface TrialBalanceRow {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

export interface BalanceSheetReport {
  assets: TrialBalanceRow[];
  liabilities: TrialBalanceRow[];
  equity: TrialBalanceRow[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
}

export interface IncomeStatementReport {
  income: TrialBalanceRow[];
  expense: TrialBalanceRow[];
  totalIncome: number;
  totalExpense: number;
  netIncome: number;
}

export interface CashFlowLine {
  label: string;
  amount: number;
}

export interface CashFlowReport {
  from: string | null;
  to: string;
  operatingActivities: CashFlowLine[];
  netOperating: number;
  investingActivities: CashFlowLine[];
  netInvesting: number;
  financingActivities: CashFlowLine[];
  netFinancing: number;
  netChangeInCash: number;
  beginningCash: number;
  endingCash: number;
  reconciled: boolean;
}

export interface AmortizationRow {
  id: number;
  ledgerEntryId: number;
  installmentNo: number;
  dueDate: string;
  principalDue: number;
  interestDue: number;
  totalDue: number;
  remainingBalance: number;
  status: "upcoming" | "paid" | "overdue";
  paidAt: string | null;
}

export interface DepreciationRow {
  id: number;
  assetId: number;
  periodNo: number;
  periodDate: string;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  bookValue: number;
  status: "upcoming" | "posted";
  postedAt: string | null;
}

export interface InvoiceLine {
  id?: number;
  entryId?: number;
  description: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  sortOrder?: number;
}

// ─── v5: Financial Goals + Net Worth Tracker ────────────────────────────────

export type GoalType = "savings" | "debt_payoff" | "custom";
export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  savings: "Savings Goal", debt_payoff: "Debt Payoff", custom: "Custom Goal",
};

export type GoalStatus = "active" | "achieved" | "abandoned";
export const GOAL_STATUS_STYLES: Record<GoalStatus, string> = {
  active: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  achieved: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  abandoned: "text-muted-foreground border-border bg-muted/10",
};

export interface FinanceGoal {
  id: number;
  userId: number;
  title: string;
  goalType: GoalType;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  targetDate: string | null;
  linkedAssetId: number | null;
  status: GoalStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function goalProgressPct(goal: FinanceGoal): number {
  if (!goal.targetAmount) return 0;
  return Math.min(100, Math.max(0, (goal.currentAmount / goal.targetAmount) * 100));
}

export interface NetWorthBreakdown {
  netWorth: number;
  totalAssets: number;
  totalReceivable: number;
  totalPayable: number;
  totalBorrowed: number;
}

export interface NetWorthSnapshot {
  id: number;
  userId: number;
  snapshotDate: string;
  netWorth: number;
  totalAssets: number;
  totalReceivable: number;
  totalPayable: number;
  totalBorrowed: number;
}

// ─── Multi-book (Phase 3) ───────────────────────────────────────────────────
export type BookType = "personal" | "business" | "other";
export interface FinanceBook {
  id: number;
  userId: number;
  name: string;
  bookType: BookType;
  currency: string;
  isDefault: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Advanced reporting (Phase 4) ───────────────────────────────────────────
export type ReportGroupBy = "kind" | "category" | "party" | "month" | "status" | "currency";
export interface CustomReportGroup {
  label: string;
  count: number;
  total: number;
}
export interface CustomReportResult {
  groupBy: ReportGroupBy;
  baseCurrency: string;
  from: string | null;
  to: string | null;
  groups: CustomReportGroup[];
  grandTotal: number;
  entryCount: number;
}
export type ScheduledReportType = "income_statement" | "balance_sheet" | "trial_balance" | "cash_flow";
export interface FinanceReportSchedule {
  id: number;
  userId: number;
  bookId: number | null;
  reportType: ScheduledReportType;
  frequency: string;
  dayOfMonth: number;
  active: number;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Phase 5: Invoices, Peer Payment Gateway, Payment Agreements ────────────
export type PaymentMethodType = "bkash" | "nagad" | "rocket" | "bank" | "usdt";
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodType, string> = {
  bkash: "bKash", nagad: "Nagad", rocket: "Rocket", bank: "Bank Transfer", usdt: "USDT",
};
export interface FinancePaymentMethod {
  id: number;
  userId: number;
  methodType: PaymentMethodType;
  label: string | null;
  accountNumber: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
  usdtAddress: string | null;
  usdtNetwork: string | null;
  isDefault: number;
  active: number;
  createdAt: string;
  updatedAt: string;
  /** data: URL of a scan-to-pay QR (encodes the account number/address) — present on the public repay page, not the creditor's own list. */
  qrDataUrl?: string | null;
}

export type InvoiceStatus =
  | "sent" | "viewed" | "payment_submitted" | "agreement_confirmed"
  | "partially_paid" | "paid" | "creditor_verified" | "disputed" | "cancelled";
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  sent: "Sent", viewed: "Viewed", payment_submitted: "Payment Submitted",
  agreement_confirmed: "Agreement Confirmed", partially_paid: "Partially Paid",
  paid: "Paid", creditor_verified: "Verified & Repaid", disputed: "Disputed", cancelled: "Cancelled",
};
export const INVOICE_STATUS_STYLES: Record<InvoiceStatus, string> = {
  sent: "bg-info-muted text-info ring-info/20",
  viewed: "bg-muted text-muted-foreground ring-border",
  payment_submitted: "bg-warning-muted text-warning ring-warning/20",
  agreement_confirmed: "bg-secondary/10 text-secondary ring-secondary/20",
  partially_paid: "bg-warning-muted text-warning ring-warning/20",
  paid: "bg-success-muted text-success ring-success/20",
  creditor_verified: "bg-success-muted text-success ring-success/20",
  disputed: "bg-danger-muted text-danger ring-danger/20",
  cancelled: "bg-danger-muted text-danger ring-danger/20",
};
export interface FinanceInvoiceLineItem {
  id: number;
  invoiceId: number;
  description: string;
  quantity: number;
  unitPrice: number;
  sortOrder: number;
  createdAt: string;
}

export interface FinanceInvoice {
  id: number;
  userId: number;
  entryId: number | null;
  bookId: number | null;
  debtorName: string;
  debtorEmail: string | null;
  debtorTelegramChatId: string | null;
  amount: number;
  currency: string;
  dueDate: string | null;
  notes: string | null;
  status: InvoiceStatus;
  invoiceToken: string;
  sentViaEmail: number;
  sentViaTelegram: number;
  lastSentAt: string | null;
  cancelledAt: string | null;
  lastReminderAt: string | null;
  reminderCount: number;
  paidAmount: number;
  recurringRuleId: number | null;
  createdAt: string;
  updatedAt: string;
  /** Enterprise-grade fields (migration 034). */
  invoiceNumber: string | null;
  poNumber: string | null;
  discountType: "flat" | "percent" | null;
  discountValue: number;
  taxRate: number;
  taxLabel: string;
  terms: string | null;
  /** Present on the create/detail responses; the list endpoint doesn't include it. */
  lineItems?: FinanceInvoiceLineItem[];
}

/** Per-user invoice branding (logo/theme + enterprise business identity), reused on every invoice — see finance-invoice-branding settings. */
export interface FinanceInvoiceBranding {
  logoUrl: string | null;
  themeColor: string | null;
  businessName: string | null;
  businessAddress: string | null;
  footerNote: string | null;
  taxId: string | null;
  businessEmail: string | null;
  businessPhone: string | null;
  website: string | null;
  termsText: string | null;
  numberPrefix: string;
}

export type PaymentAgreementStatus = "submitted" | "passkey_confirmed" | "creditor_verified" | "disputed";
export interface FinancePaymentAgreement {
  id: number;
  invoiceId: number;
  payerUserId: number | null;
  methodType: PaymentMethodType;
  referenceId: string | null;
  amount: number;
  submittedAt: string | null;
  confirmedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  status: PaymentAgreementStatus;
  agreementToken: string;
  creditorVerifiedAt: string | null;
  creditorNotes: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  createdAt: string;
  updatedAt: string;
}
