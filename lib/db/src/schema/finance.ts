import { pgTable, serial, text, integer, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Finance Module ─────────────────────────────────────────────────────────
// Core design: one shared ledger table (financeLedgerEntriesTable) backs the
// Receivables / Payables / Borrowed Funds / Lending / Expenses / Ledger pages
// and (via projectId) the Investments module — differentiated by `kind`.
// Assets (Cash, Online Wallets, Mutual Funds, Locked Funds, Other) live in
// their own table since they track *holdings*, not money owed/expected, and
// support fractional joint-ownership via financeAssetOwnersTable.

// A "party" is any person/entity money moves to or from — a lender, a
// borrower, a co-owner of an asset, etc. Reused across the whole module.
export const financePartiesTable = pgTable("finance_parties", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  contact: text("contact"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinancePartySchema = createInsertSchema(financePartiesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceParty = z.infer<typeof insertFinancePartySchema>;
export type FinanceParty = typeof financePartiesTable.$inferSelect;

// kind: 'receivable' | 'payable' | 'borrowed' | 'lending' | 'investment' | 'expense' | 'income'
// status: 'pending' | 'partial' | 'paid' | 'overdue' | 'active' | 'closed'
export const financeLedgerEntriesTable = pgTable("finance_ledger_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // Which book (Personal/Business/...) this entry belongs to — see
  // financeBooksTable above. Nullable pre-migration; every write path
  // resolves a concrete value before insert.
  bookId: integer("book_id"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  amount: real("amount").notNull().default(0),
  currency: text("currency").notNull().default("BDT"),
  partyId: integer("party_id"),
  projectId: integer("project_id"),
  category: text("category"),
  interestRate: real("interest_rate"),
  interestPaid: real("interest_paid").notNull().default(0),
  dueDate: timestamp("due_date"),
  occurredDate: timestamp("occurred_date").notNull().defaultNow(),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  remindedAt: timestamp("reminded_at"),
  recurringRuleId: integer("recurring_rule_id"),
  // Public receipt link — null until the owner first requests one (POST
  // /finance/entries/:id/receipt). A random, unguessable, unique string; its
  // mere possession is the only "auth" for GET /finance/receipt/:token(/pdf),
  // same no-account-needed model as emergency-access tokens. Regenerating
  // (DELETE then re-POST) invalidates any previously shared link.
  receiptToken: text("receipt_token").unique(),
  // Wallet↔Finance bridge — set when this entry was auto-posted from an
  // on-chain vault deposit or an outbound wallet withdrawal, so the watcher
  // never double-posts on retry/restart and the UI can label it "auto".
  // Exactly one of the two is ever set (a deposit isn't also a withdrawal).
  sourceChainDepositId: integer("source_chain_deposit_id").unique(),
  sourceWalletTxHash: text("source_wallet_tx_hash").unique(),
  // Late fee / overdue interest auto-calc (lib/finance-late-fee-cron.ts).
  // lateFeeType null = disabled. Accrual increases both `amount` (what's
  // owed) and lateFeeAccrued (running total charged as fees so far);
  // distinct from interestPaid, which tracks interest actually collected.
  lateFeeType: text("late_fee_type"), // 'flat' | 'daily_percent' | 'monthly_percent' | null
  lateFeeRate: real("late_fee_rate"),
  lateFeeGraceDays: integer("late_fee_grace_days").notNull().default(0),
  lateFeeAccrued: real("late_fee_accrued").notNull().default(0),
  lateFeeLastCalcAt: timestamp("late_fee_last_calc_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceLedgerEntrySchema = createInsertSchema(financeLedgerEntriesTable).omit({
  id: true, createdAt: true, updatedAt: true, receiptToken: true,
  lateFeeAccrued: true, lateFeeLastCalcAt: true,
});
export type InsertFinanceLedgerEntry = z.infer<typeof insertFinanceLedgerEntrySchema>;
export type FinanceLedgerEntry = typeof financeLedgerEntriesTable.$inferSelect;

// Line items for an invoice built on top of a 'receivable' entry. When a
// receivable has lines, entry.amount is kept in sync as their computed total
// (see recomputeInvoiceTotal in routes/finance.ts) — the entry stays the
// single source of truth for status/due date/journal posting, lines are
// purely the itemized breakdown shown on the invoice PDF.
export const financeInvoiceLinesTable = pgTable("finance_invoice_lines", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull(),
  description: text("description").notNull(),
  quantity: real("quantity").notNull().default(1),
  unitPrice: real("unit_price").notNull().default(0),
  taxPercent: real("tax_percent").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceInvoiceLineSchema = createInsertSchema(financeInvoiceLinesTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceInvoiceLine = z.infer<typeof insertFinanceInvoiceLineSchema>;
export type FinanceInvoiceLine = typeof financeInvoiceLinesTable.$inferSelect;

// Partial payment history against any ledger entry (receivable collected in
// installments, payable/borrowed repaid in parts, etc).
export const financeRepaymentsTable = pgTable("finance_repayments", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull(),
  amount: real("amount").notNull(),
  isInterest: integer("is_interest").notNull().default(0), // 0 = principal, 1 = interest
  paidAt: timestamp("paid_at").notNull().defaultNow(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceRepaymentSchema = createInsertSchema(financeRepaymentsTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceRepayment = z.infer<typeof insertFinanceRepaymentSchema>;
export type FinanceRepayment = typeof financeRepaymentsTable.$inferSelect;

// assetType: 'cash' | 'bank' | 'online' | 'mutual_fund' | 'locked' | 'other'
export const financeAssetsTable = pgTable("finance_assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  assetType: text("asset_type").notNull(),
  name: text("name").notNull(),
  provider: text("provider"),
  totalValue: real("total_value").notNull().default(0),
  purchasedValue: real("purchased_value"),
  interestRate: real("interest_rate"),
  purchaseDate: timestamp("purchase_date"),
  maturityDate: timestamp("maturity_date"),
  liquidity: text("liquidity"),
  notes: text("notes"),
  // Depreciation — opt-in per asset (fixed assets: equipment, property, etc,
  // typically assetType 'other'). depreciationMethod null = not depreciated.
  depreciationMethod: text("depreciation_method"), // 'straight_line' | 'declining_balance' | null
  usefulLifeMonths: integer("useful_life_months"),
  salvageValue: real("salvage_value").default(0),
  depreciationStartDate: timestamp("depreciation_start_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceAssetSchema = createInsertSchema(financeAssetsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceAsset = z.infer<typeof insertFinanceAssetSchema>;
export type FinanceAsset = typeof financeAssetsTable.$inferSelect;

// One row per depreciation period for an asset (mirrors financeAmortizationTable).
// status: 'upcoming' | 'posted'. Posting a row writes the journal entry
// (Depreciation Expense / Accumulated Depreciation) — see postDepreciationJournal.
export const financeDepreciationTable = pgTable("finance_depreciation", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  assetId: integer("asset_id").notNull(),
  periodNo: integer("period_no").notNull(),
  periodDate: timestamp("period_date").notNull(),
  depreciationAmount: real("depreciation_amount").notNull().default(0),
  accumulatedDepreciation: real("accumulated_depreciation").notNull().default(0),
  bookValue: real("book_value").notNull().default(0),
  status: text("status").notNull().default("upcoming"),
  postedAt: timestamp("posted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceDepreciationSchema = createInsertSchema(financeDepreciationTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceDepreciation = z.infer<typeof insertFinanceDepreciationSchema>;
export type FinanceDepreciation = typeof financeDepreciationTable.$inferSelect;

// Ownership split for a joint asset. partyId = null means "me" (the account
// owner). ownershipPercent rows for one assetId should sum to ~100.
export const financeAssetOwnersTable = pgTable("finance_asset_owners", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull(),
  partyId: integer("party_id"),
  ownerName: text("owner_name").notNull(),
  ownershipPercent: real("ownership_percent").notNull().default(100),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceAssetOwnerSchema = createInsertSchema(financeAssetOwnersTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceAssetOwner = z.infer<typeof insertFinanceAssetOwnerSchema>;
export type FinanceAssetOwner = typeof financeAssetOwnersTable.$inferSelect;

// ─── Recurring rules ─────────────────────────────────────────────────────────
// frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
// Each sweep (see api-server/src/lib/finance-recurring-cron.ts) creates a real
// financeLedgerEntriesTable row (tagged via recurringRuleId) and advances
// nextRunDate — so recurring rules are a template, not a duplicate ledger.
export const financeRecurringRulesTable = pgTable("finance_recurring_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  amount: real("amount").notNull().default(0),
  currency: text("currency").notNull().default("BDT"),
  partyId: integer("party_id"),
  projectId: integer("project_id"),
  category: text("category"),
  interestRate: real("interest_rate"),
  frequency: text("frequency").notNull().default("monthly"),
  intervalCount: integer("interval_count").notNull().default(1),
  startDate: timestamp("start_date").notNull().defaultNow(),
  nextRunDate: timestamp("next_run_date").notNull().defaultNow(),
  endDate: timestamp("end_date"),
  active: integer("active").notNull().default(1),
  lastRunAt: timestamp("last_run_at"),
  notes: text("notes"),
  // Auto-invoice — rent/loan-EMI style: when a rule materializes an entry,
  // optionally also mint + auto-send a finance_invoices row against it (same
  // create+send path as a manual invoice — see createAndSendRuleInvoice in
  // lib/finance-invoice.ts), due invoiceDueDays after the entry's occurredDate.
  autoInvoice: integer("auto_invoice").notNull().default(0),
  invoiceDebtorName: text("invoice_debtor_name"),
  invoiceDebtorEmail: text("invoice_debtor_email"),
  invoiceDebtorTelegramChatId: text("invoice_debtor_telegram_chat_id"),
  invoiceDueDays: integer("invoice_due_days").notNull().default(7),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceRecurringRuleSchema = createInsertSchema(financeRecurringRulesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceRecurringRule = z.infer<typeof insertFinanceRecurringRuleSchema>;
export type FinanceRecurringRule = typeof financeRecurringRulesTable.$inferSelect;

// ─── Budgets ─────────────────────────────────────────────────────────────────
// period: 'monthly' (the only one for now — a monthly cap per expense category).
export const financeBudgetsTable = pgTable("finance_budgets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  category: text("category").notNull(),
  monthlyLimit: real("monthly_limit").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceBudgetSchema = createInsertSchema(financeBudgetsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceBudget = z.infer<typeof insertFinanceBudgetSchema>;
export type FinanceBudget = typeof financeBudgetsTable.$inferSelect;

// ─── Attachments (receipts) ──────────────────────────────────────────────────
// One or more files (receipt photo, invoice PDF, screenshot) attached to a
// single financeLedgerEntriesTable row. Same "no object storage wired in"
// situation as vault_attachments (see schema/vault-attachments.ts) — file
// bytes travel as base64 and are stored as-is in a TEXT column. Deliberately
// NOT run through vault-crypto's envelope encryption: these are receipts for
// day-to-day ledger entries (already stored in plaintext throughout this
// module), not Vault credentials, so reusing that key material here would
// blur the two very different trust boundaries for no real benefit. Sized
// for small documents only — see MAX_ATTACHMENT_BYTES in routes/finance.ts.
export const financeAttachmentsTable = pgTable("finance_attachments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  entryId: integer("entry_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  note: text("note"),
  // base64(file bytes) — not decoded further server-side, only re-emitted to
  // the client on single-attachment fetch. Never returned by the list route.
  contentBase64: text("content_base64").notNull(),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceAttachmentSchema = createInsertSchema(financeAttachmentsTable).omit({
  id: true, uploadedAt: true, updatedAt: true,
});
export type InsertFinanceAttachment = z.infer<typeof insertFinanceAttachmentSchema>;
export type FinanceAttachment = typeof financeAttachmentsTable.$inferSelect;

// ─── Currency rates ──────────────────────────────────────────────────────────
// Manually-maintained conversion rates to the user's base currency (BDT by
// default) — this environment has no outbound network access for a live FX
// feed, so rates are entered by the user and used for dashboard rollups only;
// each ledger entry/asset still stores its own original currency untouched.
export const financeCurrencyRatesTable = pgTable("finance_currency_rates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  currency: text("currency").notNull(),
  rateToBase: real("rate_to_base").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceCurrencyRateSchema = createInsertSchema(financeCurrencyRatesTable).omit({
  id: true, updatedAt: true,
});
export type InsertFinanceCurrencyRate = z.infer<typeof insertFinanceCurrencyRateSchema>;
export type FinanceCurrencyRate = typeof financeCurrencyRatesTable.$inferSelect;

// ─── v6: Multi-book (Business vs Personal separate ledgers) ────────────────
// A "book" is a separate ledger namespace within one user's account — e.g.
// "Personal" and "Business", each with its own Chart of Accounts, Journal,
// and Finance entries, so a freelancer/small-business owner never has to
// mix the two. Every user gets exactly one default book (see ensureDefault
// Book in finance-accounting.ts) auto-created on first use / backfilled by
// migrations/030_finance_multi_book.sql, so bookId is nullable on the
// tables below purely for pre-migration compatibility — every read/write
// path resolves a concrete bookId before touching them (falling back to the
// user's default book when the caller doesn't specify one). Deliberately
// scoped to just Accounts + Journal + Ledger entries (the tables that
// define "the books" in an accounting sense) — Assets, Budgets, Recurring
// rules, and Goals stay per-user/global across books, since those are
// naturally person-level rather than business-vs-personal concepts.
export const financeBooksTable = pgTable("finance_books", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  // bookType is a display hint only ('personal' | 'business' | 'other') —
  // it doesn't change any posting/report logic.
  bookType: text("book_type").notNull().default("personal"),
  currency: text("currency").notNull().default("BDT"),
  // 1 = the book new entries/accounts fall back to when no bookId is given
  // (exactly one per user; enforced in routes/finance.ts, not a DB constraint,
  // same convention as other "exactly one active X" flags in this module).
  isDefault: integer("is_default").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceBookSchema = createInsertSchema(financeBooksTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceBook = z.infer<typeof insertFinanceBookSchema>;
export type FinanceBook = typeof financeBooksTable.$inferSelect;

// ─── v6: Scheduled report delivery (Phase 4 — Advanced reporting) ──────────
// A recurring "email me this report" subscription — the monthly-P&L-auto-
// email use case, generalized to any of the existing report types. Kept
// separate from the daily digest (finance_last_digest_sent_at) since this is
// a formal document delivery (PDF attachment) on its own monthly cadence,
// not a daily activity rollup. See finance-report-schedule-cron.ts.
// reportType: 'income_statement' | 'balance_sheet' | 'trial_balance' | 'cash_flow'
// frequency: 'monthly' (only cadence for now — a report on a fixed day of month)
export const financeReportSchedulesTable = pgTable("finance_report_schedules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // Null bookId = "all books combined" (whatever the user's default book
  // resolves to today); set = scoped to that one book's figures only.
  bookId: integer("book_id"),
  reportType: text("report_type").notNull().default("income_statement"),
  frequency: text("frequency").notNull().default("monthly"),
  dayOfMonth: integer("day_of_month").notNull().default(1),
  active: integer("active").notNull().default(1),
  lastSentAt: timestamp("last_sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceReportScheduleSchema = createInsertSchema(financeReportSchedulesTable).omit({
  id: true, createdAt: true, updatedAt: true, lastSentAt: true,
});
export type InsertFinanceReportSchedule = z.infer<typeof insertFinanceReportScheduleSchema>;
export type FinanceReportSchedule = typeof financeReportSchedulesTable.$inferSelect;

// ─── Accounting v4: Double-entry Chart of Accounts + Journal + Amortization ──
// Every ledger entry / repayment keeps working exactly as before (kind-based
// tracker, unchanged above) — this layer sits *alongside* it as a proper
// double-entry books view: each user gets a seeded system Chart of Accounts
// (see SYSTEM_ACCOUNTS in routes/finance.ts), Finance entries/repayments
// auto-post a balanced journal entry against it, and users can also post
// manual journal entries directly. Trial Balance / Balance Sheet / Income
// Statement are all derived by summing financeJournalLinesTable per account.

// type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'
// normalBalance: 'debit' | 'credit' — which side increases this account.
export const financeAccountsTable = pgTable("finance_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // See financeBooksTable — a Chart of Accounts is per-book, so "Cash & Bank"
  // in the Business book and "Cash & Bank" in the Personal book are two
  // distinct rows/balances even though they share the same system code.
  bookId: integer("book_id"),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  normalBalance: text("normal_balance").notNull().default("debit"),
  parentId: integer("parent_id"),
  // 1 = seeded system account backing auto-posting (Cash, AR, AP, ...) and
  // therefore not user-deletable; 0 = user-created account.
  isSystem: integer("is_system").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceAccountSchema = createInsertSchema(financeAccountsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceAccount = z.infer<typeof insertFinanceAccountSchema>;
export type FinanceAccount = typeof financeAccountsTable.$inferSelect;

// A posting — either auto-generated from a Finance ledger entry/repayment
// (isManual = 0, sourceLedgerEntryId set) or entered by hand (isManual = 1).
export const financeJournalEntriesTable = pgTable("finance_journal_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  bookId: integer("book_id"),
  date: timestamp("date").notNull().defaultNow(),
  memo: text("memo").notNull(),
  sourceLedgerEntryId: integer("source_ledger_entry_id"),
  isManual: integer("is_manual").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceJournalEntrySchema = createInsertSchema(financeJournalEntriesTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceJournalEntry = z.infer<typeof insertFinanceJournalEntrySchema>;
export type FinanceJournalEntry = typeof financeJournalEntriesTable.$inferSelect;

// One debit or credit leg of a journal entry. A balanced entry has
// SUM(debit) === SUM(credit) across all its lines.
export const financeJournalLinesTable = pgTable("finance_journal_lines", {
  id: serial("id").primaryKey(),
  journalEntryId: integer("journal_entry_id").notNull(),
  accountId: integer("account_id").notNull(),
  debit: real("debit").notNull().default(0),
  credit: real("credit").notNull().default(0),
  notes: text("notes"),
});
export const insertFinanceJournalLineSchema = createInsertSchema(financeJournalLinesTable).omit({
  id: true,
});
export type InsertFinanceJournalLine = z.infer<typeof insertFinanceJournalLineSchema>;
export type FinanceJournalLine = typeof financeJournalLinesTable.$inferSelect;

// Loan amortization schedule for a single borrowed/lending ledger entry.
// status: 'upcoming' | 'paid' | 'overdue'
export const financeAmortizationTable = pgTable("finance_amortization", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ledgerEntryId: integer("ledger_entry_id").notNull(),
  installmentNo: integer("installment_no").notNull(),
  dueDate: timestamp("due_date").notNull(),
  principalDue: real("principal_due").notNull().default(0),
  interestDue: real("interest_due").notNull().default(0),
  totalDue: real("total_due").notNull().default(0),
  remainingBalance: real("remaining_balance").notNull().default(0),
  status: text("status").notNull().default("upcoming"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceAmortizationSchema = createInsertSchema(financeAmortizationTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceAmortization = z.infer<typeof insertFinanceAmortizationSchema>;
export type FinanceAmortization = typeof financeAmortizationTable.$inferSelect;

// ─── v5: Financial Goals + Net Worth Tracker ────────────────────────────────
// A goal tracks progress toward a target amount. currentAmount is either
// updated manually (contribute endpoint) or, when linkedAssetId is set,
// mirrors that asset's "my share" value on every read (see
// lib/finance-networth.ts syncGoalProgress) — same pattern as an asset's
// owners table driving myShareOf() rather than a second source of truth.
// goalType: 'savings' | 'debt_payoff' | 'custom'
// status: 'active' | 'achieved' | 'abandoned'
export const financeGoalsTable = pgTable("finance_goals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  goalType: text("goal_type").notNull().default("savings"),
  targetAmount: real("target_amount").notNull().default(0),
  currentAmount: real("current_amount").notNull().default(0),
  currency: text("currency").notNull().default("BDT"),
  targetDate: timestamp("target_date"),
  linkedAssetId: integer("linked_asset_id"),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceGoalSchema = createInsertSchema(financeGoalsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceGoal = z.infer<typeof insertFinanceGoalSchema>;
export type FinanceGoal = typeof financeGoalsTable.$inferSelect;

// One row per user per calendar month (see migration's expression-based
// unique index) — a trend point for the Net Worth chart. Snapshotted by
// lib/finance-networth-cron.ts on a monthly sweep, or on-demand via
// POST /finance/net-worth/snapshot, using the exact same formula as
// GET /finance/summary's netWorth field (lib/finance-networth.ts) so the
// dashboard figure and the trend's latest point never disagree.
export const financeNetWorthSnapshotsTable = pgTable("finance_net_worth_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  snapshotDate: timestamp("snapshot_date").notNull().defaultNow(),
  netWorth: real("net_worth").notNull().default(0),
  totalAssets: real("total_assets").notNull().default(0),
  totalReceivable: real("total_receivable").notNull().default(0),
  totalPayable: real("total_payable").notNull().default(0),
  totalBorrowed: real("total_borrowed").notNull().default(0),
  totalLending: real("total_lending").notNull().default(0),
  totalInvested: real("total_invested").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceNetWorthSnapshotSchema = createInsertSchema(financeNetWorthSnapshotsTable).omit({
  id: true, createdAt: true,
});
export type InsertFinanceNetWorthSnapshot = z.infer<typeof insertFinanceNetWorthSnapshotSchema>;
export type FinanceNetWorthSnapshot = typeof financeNetWorthSnapshotsTable.$inferSelect;

// ─── Phase 5: Invoices, Peer Payment Gateway, Payment Agreements ────────────
// A "payment method" is a receiving destination a user publishes on their
// invoices — their own bKash/Nagad/Rocket number, bank account, or USDT
// address — so a debtor knows exactly where to send money. Purely
// informational (no gateway API integration); the debtor pays manually
// outside AYZEN and then submits the reference/txn ID as proof.
// methodType: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'usdt'
export const financePaymentMethodsTable = pgTable("finance_payment_methods", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  methodType: text("method_type").notNull(),
  label: text("label"),
  accountNumber: text("account_number"),       // bKash/Nagad/Rocket number
  bankName: text("bank_name"),
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankRoutingNumber: text("bank_routing_number"),
  usdtAddress: text("usdt_address"),
  usdtNetwork: text("usdt_network").default("TRC20"),
  isDefault: integer("is_default").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinancePaymentMethodSchema = createInsertSchema(financePaymentMethodsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertFinancePaymentMethod = z.infer<typeof insertFinancePaymentMethodSchema>;
export type FinancePaymentMethod = typeof financePaymentMethodsTable.$inferSelect;

// An invoice sent to a debtor (usually the counterparty on a 'receivable' or
// 'lending' entry) asking them to repay. Distinct from the existing
// receiptToken on financeLedgerEntriesTable — that's a read-only "view this
// entry" link the creditor shares; this is an actionable "pay me" document
// with its own public page (payment method list + a Repay flow) and its own
// lifecycle (sent → viewed → payment_submitted → agreement_confirmed →
// creditor_verified). Optionally linked to a ledger entry so a verified
// payment can auto-post a real repayment (see finance-invoice.ts); can also
// stand alone (entryId null) for a one-off invoice with no tracked entry.
// status: 'sent' | 'viewed' | 'payment_submitted' | 'agreement_confirmed' |
// 'partially_paid' | 'paid' | 'creditor_verified' | 'disputed' | 'cancelled'
// partially_paid/paid are derived from paidAmount (sum of creditor_verified
// agreements) vs amount as each agreement is verified — see the verify route
// in routes/finance-invoices.ts. creditor_verified is kept as a legacy alias
// reached the same way pre-partial-payments; new code prefers paid.
export const financeInvoicesTable = pgTable("finance_invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),        // creditor — the AYZEN account that owns this invoice
  entryId: integer("entry_id"),                 // optional linked finance_ledger_entries row
  bookId: integer("book_id"),
  debtorName: text("debtor_name").notNull(),
  debtorEmail: text("debtor_email"),
  debtorTelegramChatId: text("debtor_telegram_chat_id"),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("BDT"),
  dueDate: timestamp("due_date"),
  notes: text("notes"),
  status: text("status").notNull().default("sent"),
  invoiceToken: text("invoice_token").notNull().unique(),
  sentViaEmail: integer("sent_via_email").notNull().default(0),
  sentViaTelegram: integer("sent_via_telegram").notNull().default(0),
  lastSentAt: timestamp("last_sent_at"),
  cancelledAt: timestamp("cancelled_at"),
  // Overdue reminder cron (lib/finance-invoice-reminder-cron.ts) dedup —
  // re-nudges every FINANCE_INVOICE_REMINDER_INTERVAL_DAYS while overdue.
  lastReminderAt: timestamp("last_reminder_at"),
  reminderCount: integer("reminder_count").notNull().default(0),
  // Running total across every creditor_verified payment agreement on this
  // invoice — lets one invoice be settled via several partial payments.
  paidAmount: real("paid_amount").notNull().default(0),
  // Set when this invoice was auto-minted by a recurring rule's sweep
  // (lib/finance-recurring-cron.ts, rule.autoInvoice) rather than created manually.
  recurringRuleId: integer("recurring_rule_id"),
  // Enterprise-grade fields (migration 034). invoiceNumber is a human,
  // sequential-looking number (<prefix>-<year>-<5-digit id>, see
  // finance-invoice.ts's formatInvoiceNumber) shown instead of the raw id
  // everywhere it's customer-facing. amount stays the grand total —
  // subtotal (SUM of line items) minus discountAmount plus taxAmount — so
  // every existing reader of `amount` keeps working unchanged; tax/discount
  // are just how that total is now composed. See computeInvoiceTotals().
  invoiceNumber: text("invoice_number"),
  poNumber: text("po_number"),
  discountType: text("discount_type"),        // 'flat' | 'percent' | null
  discountValue: real("discount_value").notNull().default(0),
  taxRate: real("tax_rate").notNull().default(0), // percent, applied to (subtotal - discount)
  taxLabel: text("tax_label").notNull().default("Tax"),
  terms: text("terms"),                        // per-invoice override of the user's default T&Cs
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinanceInvoiceSchema = createInsertSchema(financeInvoicesTable).omit({
  id: true, invoiceToken: true, invoiceNumber: true, status: true, sentViaEmail: true, sentViaTelegram: true,
  lastSentAt: true, cancelledAt: true, lastReminderAt: true, reminderCount: true,
  paidAmount: true, createdAt: true, updatedAt: true,
});
export type InsertFinanceInvoice = z.infer<typeof insertFinanceInvoiceSchema>;
export type FinanceInvoice = typeof financeInvoicesTable.$inferSelect;

// Itemized lines on an invoice — finance_invoices.amount is a denormalized
// total = SUM(quantity * unit_price) over these, recomputed by
// lib/finance-invoice.ts's replaceInvoiceLineItems() whenever lines change,
// so every existing reader of invoice.amount (reminders, late fees,
// partial-payment math) keeps working unchanged.
export const financeInvoiceLineItemsTable = pgTable("finance_invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull(),
  description: text("description").notNull(),
  quantity: real("quantity").notNull().default(1),
  unitPrice: real("unit_price").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFinanceInvoiceLineItemSchema = createInsertSchema(financeInvoiceLineItemsTable).omit({
  id: true, invoiceId: true, createdAt: true,
});
export type InsertFinanceInvoiceLineItem = z.infer<typeof insertFinanceInvoiceLineItemSchema>;
export type FinanceInvoiceLineItem = typeof financeInvoiceLineItemsTable.$inferSelect;

// An append-only trail on an invoice — sent/viewed/submitted/confirmed/
// verified — each row capturing the IP + device at the time, so the full
// history (not just the latest state) is preserved as evidence.
export const financeInvoiceEventsTable = pgTable("finance_invoice_events", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull(),
  eventType: text("event_type").notNull(),
  meta: text("meta"),                           // JSON string — event-specific detail
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type FinanceInvoiceEvent = typeof financeInvoiceEventsTable.$inferSelect;

// The debtor's claim of having paid, escalating through: they submit a
// method + reference/txn ID (submitted) → they cryptographically confirm it
// with their own AYZEN passkey, which stamps IP + device as evidence
// (passkey_confirmed) → the creditor reviews and verifies it, which
// auto-posts a real repayment against the linked entry (creditor_verified).
// The passkey step is the "I attest, as evidence, that I sent this money"
// signature the debtor asked for — it's tied to their own registered
// passkey_credentials row, not a new credential type.
// status: 'submitted' | 'passkey_confirmed' | 'creditor_verified' | 'disputed'
export const financePaymentAgreementsTable = pgTable("finance_payment_agreements", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull(),
  payerUserId: integer("payer_user_id"),        // the debtor's own AYZEN account, if they have/create one
  methodType: text("method_type").notNull(),
  referenceId: text("reference_id"),            // txn ID / reference the debtor submitted
  amount: real("amount").notNull(),
  submittedAt: timestamp("submitted_at"),
  passkeyCredentialId: integer("passkey_credential_id"),
  confirmedAt: timestamp("confirmed_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  status: text("status").notNull().default("submitted"),
  agreementToken: text("agreement_token").notNull().unique(),
  creditorVerifiedAt: timestamp("creditor_verified_at"),
  creditorVerifiedBy: integer("creditor_verified_by"),
  creditorNotes: text("creditor_notes"),
  // Dispute — creditor rejects a passkey-confirmed claim instead of
  // verifying it (routes/finance-invoices.ts POST .../:id/dispute).
  disputedAt: timestamp("disputed_at"),
  disputeReason: text("dispute_reason"),
  disputedBy: integer("disputed_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertFinancePaymentAgreementSchema = createInsertSchema(financePaymentAgreementsTable).omit({
  id: true, agreementToken: true, status: true, confirmedAt: true, ipAddress: true,
  userAgent: true, creditorVerifiedAt: true, creditorVerifiedBy: true,
  disputedAt: true, disputeReason: true, disputedBy: true, createdAt: true, updatedAt: true,
});
export type InsertFinancePaymentAgreement = z.infer<typeof insertFinancePaymentAgreementSchema>;
export type FinancePaymentAgreement = typeof financePaymentAgreementsTable.$inferSelect;
