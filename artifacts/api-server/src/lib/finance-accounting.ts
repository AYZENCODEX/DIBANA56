/**
 * lib/finance-accounting.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Double-entry accounting layer on top of the existing Finance module.
 * The kind-based tracker (finance_ledger_entries / finance_repayments) is
 * completely unchanged and remains the source of truth for the day-to-day
 * Finance UI — this module just mirrors every entry/repayment into a proper
 * balanced Chart of Accounts + Journal, so Trial Balance / Balance Sheet /
 * Income Statement can be derived from real double-entry postings instead of
 * being hand-rolled per report.
 *
 * Every user gets a seeded system Chart of Accounts on first use (see
 * SYSTEM_ACCOUNTS below) — these are the only accounts auto-posting knows
 * how to hit, and they're not user-deletable (isSystem = 1). Users can also
 * add their own accounts and post fully manual journal entries.
 */
import {
  db,
  financeAccountsTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeAmortizationTable,
  financeDepreciationTable,
  financeLedgerEntriesTable,
  financeBooksTable,
  type FinanceAccount,
  type FinanceLedgerEntry,
  type FinanceAsset,
  type FinanceBook,
} from "@workspace/db";
import { eq, and, lte, gte, sql } from "drizzle-orm";
import crypto from "crypto";

// ─── Books (Phase 3 — Multi-book) ───────────────────────────────────────────

/** List every book for a user, default book first. Never empty once resolveDefaultBookId has run for them. */
export async function listBooks(userId: number): Promise<FinanceBook[]> {
  const rows = await db.select().from(financeBooksTable).where(eq(financeBooksTable.userId, userId));
  return rows.sort((a, b) => (b.isDefault - a.isDefault) || a.id - b.id);
}

/**
 * Resolve the concrete bookId a request should operate on: the caller's
 * explicit choice if given (and it's actually theirs), otherwise the user's
 * default book — lazily creating a "Personal" default book on first-ever
 * use so every user always has exactly one to fall back to, without needing
 * a signup-time hook. Mirrors ensureSystemAccounts' "ensure on first use"
 * pattern below.
 */
export async function resolveBookId(userId: number, requestedBookId?: number | null): Promise<number> {
  if (requestedBookId != null) {
    const [owned] = await db.select({ id: financeBooksTable.id }).from(financeBooksTable)
      .where(and(eq(financeBooksTable.id, requestedBookId), eq(financeBooksTable.userId, userId))).limit(1);
    if (owned) return owned.id;
    // Requested book doesn't exist or isn't theirs — fall through to default
    // rather than erroring, so a stale bookId in a bookmarked URL degrades
    // gracefully instead of breaking the page.
  }
  const [existingDefault] = await db.select({ id: financeBooksTable.id }).from(financeBooksTable)
    .where(and(eq(financeBooksTable.userId, userId), eq(financeBooksTable.isDefault, 1))).limit(1);
  if (existingDefault) return existingDefault.id;

  const [anyBook] = await db.select({ id: financeBooksTable.id }).from(financeBooksTable)
    .where(eq(financeBooksTable.userId, userId)).limit(1);
  if (anyBook) {
    await db.update(financeBooksTable).set({ isDefault: 1 }).where(eq(financeBooksTable.id, anyBook.id));
    return anyBook.id;
  }

  const [created] = await db.insert(financeBooksTable).values({
    userId, name: "Personal", bookType: "personal", isDefault: 1,
  }).returning();
  return created.id;
}

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const SYSTEM_ACCOUNTS: { code: string; name: string; type: AccountType; normalBalance: "debit" | "credit" }[] = [
  { code: "1000", name: "Cash & Bank",                    type: "asset",     normalBalance: "debit" },
  { code: "1100", name: "Accounts Receivable",            type: "asset",     normalBalance: "debit" },
  { code: "1200", name: "Loans Receivable (Lending)",     type: "asset",     normalBalance: "debit" },
  { code: "1300", name: "Investments",                    type: "asset",     normalBalance: "debit" },
  { code: "1350", name: "Accumulated Depreciation",        type: "asset",     normalBalance: "credit" }, // contra-asset
  { code: "2000", name: "Accounts Payable",               type: "liability", normalBalance: "credit" },
  { code: "2100", name: "Loans Payable (Borrowed Funds)", type: "liability", normalBalance: "credit" },
  { code: "3000", name: "Owner's Equity",                 type: "equity",    normalBalance: "credit" },
  { code: "4000", name: "Income",                         type: "income",    normalBalance: "credit" },
  { code: "4100", name: "Interest Income",                type: "income",    normalBalance: "credit" },
  { code: "5000", name: "Expenses",                       type: "expense",   normalBalance: "debit" },
  { code: "5100", name: "Interest Expense",               type: "expense",   normalBalance: "debit" },
  { code: "5200", name: "Depreciation Expense",           type: "expense",   normalBalance: "debit" },
];

// kind -> the two system accounts a new Finance entry auto-posts against.
const KIND_POSTING: Record<string, { debit: string; credit: string }> = {
  receivable: { debit: "1100", credit: "4000" }, // AR up, Income earned
  payable:    { debit: "5000", credit: "2000" }, // Expense incurred, AP up
  borrowed:   { debit: "1000", credit: "2100" }, // Cash in, Loans Payable up
  lending:    { debit: "1200", credit: "1000" }, // Loans Receivable up, Cash out
  investment: { debit: "1300", credit: "1000" }, // Investments up, Cash out
  expense:    { debit: "5000", credit: "1000" }, // Expense incurred, Cash out
  income:     { debit: "1000", credit: "4000" }, // Cash in, Income earned
};

// kind -> accounts hit when principal is repaid against an existing entry.
// 'investment' added: getting invested money back (a partial/full divestment)
// is Cash in / Investments down — the mirror of its KIND_POSTING opening
// entry, same relationship borrowed/lending already have with their own
// repayment postings. 'expense'/'income' are deliberately absent — they're
// immediate cash transactions with no "outstanding balance" concept, and are
// rejected before reaching here (see the requireRepayableKind check in
// routes/finance.ts's POST /finance/entries/:id/repayments).
const KIND_REPAYMENT_POSTING: Record<string, { debit: string; credit: string }> = {
  receivable: { debit: "1000", credit: "1100" }, // Cash collected, AR down
  payable:    { debit: "2000", credit: "1000" }, // AP paid down, Cash out
  borrowed:   { debit: "2100", credit: "1000" }, // Loans Payable paid down, Cash out
  lending:    { debit: "1000", credit: "1200" }, // Cash collected, Loans Receivable down
  investment: { debit: "1000", credit: "1300" }, // Cash collected, Investments down
};

// kind -> accounts hit when interest is repaid/received against an entry.
// 'investment' added: interest/dividend received on an investment is Cash
// in / Interest Income — same accounts 'lending' already uses, since both
// represent interest earned on money that's out working for you.
const KIND_INTEREST_POSTING: Record<string, { debit: string; credit: string }> = {
  borrowed: { debit: "5100", credit: "1000" }, // Interest Expense, Cash out
  lending:  { debit: "1000", credit: "4100" }, // Cash in, Interest Income
  payable:  { debit: "5100", credit: "1000" },
  receivable: { debit: "1000", credit: "4100" },
  investment: { debit: "1000", credit: "4100" }, // Cash in, Interest Income
};

// Kinds that represent an "outstanding balance" someone can pay down over
// time — the only ones POST /finance/entries/:id/repayments should accept.
// 'expense'/'income' are immediate cash transactions (fully settled the
// moment they're recorded — see KIND_POSTING above, both credit/debit Cash
// directly), so there's nothing to "repay" against them; letting a repayment
// through would silently corrupt entry.amount and the double-entry books
// since neither KIND_REPAYMENT_POSTING nor KIND_INTEREST_POSTING map them.
export const REPAYABLE_KINDS = new Set(["receivable", "payable", "borrowed", "lending", "investment"]);

/** Ensure the calling user's book has every system account seeded; returns code -> account. bookId omitted resolves to the user's default book. */
export async function ensureSystemAccounts(userId: number, bookId?: number | null): Promise<Map<string, FinanceAccount>> {
  const resolvedBookId = await resolveBookId(userId, bookId);
  const existing = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.bookId, resolvedBookId)));
  const byCode = new Map(existing.map(a => [a.code, a]));
  const missing = SYSTEM_ACCOUNTS.filter(sa => !byCode.has(sa.code));
  if (missing.length > 0) {
    const inserted = await db.insert(financeAccountsTable).values(
      missing.map(sa => ({ userId, bookId: resolvedBookId, code: sa.code, name: sa.name, type: sa.type, normalBalance: sa.normalBalance, isSystem: 1 })),
    ).returning();
    for (const row of inserted) byCode.set(row.code, row);
  }
  return byCode;
}

/** Post a balanced journal entry. Lines with a zero/blank amount are dropped. Returns null if not balanced. bookId omitted resolves to the user's default book. */
export async function postJournal(
  userId: number,
  opts: {
    memo: string;
    date?: Date;
    lines: { accountCode: string; debit: number; credit: number }[];
    sourceLedgerEntryId?: number | null;
    isManual?: boolean;
    bookId?: number | null;
  },
): Promise<typeof financeJournalEntriesTable.$inferSelect | null> {
  const lines = opts.lines.filter(l => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  if (lines.length < 2) return null;
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) return null;

  const resolvedBookId = await resolveBookId(userId, opts.bookId);
  const accounts = await ensureSystemAccounts(userId, resolvedBookId);
  const [je] = await db.insert(financeJournalEntriesTable).values({
    userId,
    bookId: resolvedBookId,
    date: opts.date ?? new Date(),
    memo: opts.memo,
    sourceLedgerEntryId: opts.sourceLedgerEntryId ?? null,
    isManual: opts.isManual ? 1 : 0,
  }).returning();

  const lineRows = lines
    .map(l => ({ account: accounts.get(l.accountCode), debit: l.debit || 0, credit: l.credit || 0 }))
    .filter(l => !!l.account)
    .map(l => ({ journalEntryId: je.id, accountId: l.account!.id, debit: l.debit, credit: l.credit, notes: null as string | null }));
  if (lineRows.length > 0) await db.insert(financeJournalLinesTable).values(lineRows);
  return je;
}

/** Auto-post the opening journal entry for a freshly created Finance ledger entry, if its kind is mapped. */
export async function postEntryJournal(entry: FinanceLedgerEntry): Promise<void> {
  const mapping = KIND_POSTING[entry.kind];
  if (!mapping || !(entry.amount > 0)) return;
  await postJournal(entry.userId, {
    memo: `${entry.title} (${entry.kind})`,
    date: entry.occurredDate ?? new Date(),
    lines: [
      { accountCode: mapping.debit, debit: entry.amount, credit: 0 },
      { accountCode: mapping.credit, debit: 0, credit: entry.amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
}

/**
 * Post an adjustment journal for a change to an already-posted entry's
 * amount (e.g. the user corrects it via PUT /finance/entries/:id after the
 * opening entry was already posted by postEntryJournal). Uses the same
 * accounts as the opening posting (KIND_POSTING) but only for the delta —
 * NOT a delete-and-repost of the opening entry — because
 * deleteJournalForEntry removes every journal entry sourced from this
 * ledger entry, including repayment/interest postings already recorded
 * against it, which a naive repost would silently destroy.
 */
export async function postEntryAdjustmentJournal(entry: FinanceLedgerEntry, delta: number): Promise<void> {
  const mapping = KIND_POSTING[entry.kind];
  if (!mapping || Math.abs(delta) < 0.01) return;
  const amount = Math.abs(delta);
  // delta > 0 (amount went up): same debit/credit direction as the opening
  // entry. delta < 0 (amount went down): reversed, to bring both accounts
  // back down by the difference.
  const lines = delta > 0
    ? [{ accountCode: mapping.debit, debit: amount, credit: 0 }, { accountCode: mapping.credit, debit: 0, credit: amount }]
    : [{ accountCode: mapping.credit, debit: amount, credit: 0 }, { accountCode: mapping.debit, debit: 0, credit: amount }];
  await postJournal(entry.userId, {
    memo: `Adjustment — ${entry.title} (${delta > 0 ? "+" : ""}${delta.toLocaleString(undefined, { maximumFractionDigits: 2 })})`,
    date: new Date(),
    lines,
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
}

/** Auto-post a journal entry for a principal or interest repayment against an existing Finance entry. */
export async function postRepaymentJournal(entry: FinanceLedgerEntry, amount: number, isInterest: boolean): Promise<void> {
  const mapping = isInterest ? KIND_INTEREST_POSTING[entry.kind] : KIND_REPAYMENT_POSTING[entry.kind];
  if (!mapping || !(amount > 0)) return;
  await postJournal(entry.userId, {
    memo: `${isInterest ? "Interest" : "Repayment"} — ${entry.title}`,
    date: new Date(),
    lines: [
      { accountCode: mapping.debit, debit: amount, credit: 0 },
      { accountCode: mapping.credit, debit: 0, credit: amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
}

// kind -> accounts hit when a late fee/overdue-interest amount is *accrued*
// (added to what's owed, not yet collected) — mirrors KIND_POSTING's debit
// side (AR/AP/Loans) but credits Interest Income/Expense instead of the
// entry's normal income/expense account, same accounts KIND_INTEREST_POSTING
// uses for collection.
const KIND_LATE_FEE_ACCRUAL_POSTING: Record<string, { debit: string; credit: string }> = {
  receivable: { debit: "1100", credit: "4100" }, // AR up, Interest Income
  lending:    { debit: "1200", credit: "4100" }, // Loans Receivable up, Interest Income
  payable:    { debit: "5100", credit: "2000" }, // Interest Expense, AP up
  borrowed:   { debit: "5100", credit: "2100" }, // Interest Expense, Loans Payable up
};

/** Auto-post the journal entry for a newly-accrued late fee/overdue-interest amount (lib/finance-late-fee-cron.ts). */
export async function postLateFeeAccrualJournal(entry: FinanceLedgerEntry, amount: number): Promise<void> {
  const mapping = KIND_LATE_FEE_ACCRUAL_POSTING[entry.kind];
  if (!mapping || !(amount > 0)) return;
  await postJournal(entry.userId, {
    memo: `Late fee — ${entry.title}`,
    date: new Date(),
    lines: [
      { accountCode: mapping.debit, debit: amount, credit: 0 },
      { accountCode: mapping.credit, debit: 0, credit: amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
}

/** Delete every journal entry (and its lines) sourced from a given ledger entry — used when the entry itself is deleted. */
export async function deleteJournalForEntry(entryId: number): Promise<void> {
  const rows = await db.select({ id: financeJournalEntriesTable.id })
    .from(financeJournalEntriesTable)
    .where(eq(financeJournalEntriesTable.sourceLedgerEntryId, entryId));
  for (const r of rows) {
    await db.delete(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, r.id));
  }
  if (rows.length > 0) {
    await db.delete(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.sourceLedgerEntryId, entryId));
  }
}

export interface AccountBalanceRow {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

/** Sum journal lines per account for a user's book, optionally bounded by a date range. Only returns accounts with activity. bookId omitted resolves to the user's default book. */
export async function computeAccountBalances(userId: number, opts: { from?: Date; to?: Date; bookId?: number | null } = {}): Promise<AccountBalanceRow[]> {
  const resolvedBookId = await resolveBookId(userId, opts.bookId);
  const conditions = [eq(financeJournalEntriesTable.userId, userId), eq(financeJournalEntriesTable.bookId, resolvedBookId)];
  if (opts.from) conditions.push(gte(financeJournalEntriesTable.date, opts.from));
  if (opts.to) conditions.push(lte(financeJournalEntriesTable.date, opts.to));

  const sums = await db.select({
    accountId: financeJournalLinesTable.accountId,
    totalDebit: sql<number>`COALESCE(SUM(${financeJournalLinesTable.debit}), 0)`,
    totalCredit: sql<number>`COALESCE(SUM(${financeJournalLinesTable.credit}), 0)`,
  })
    .from(financeJournalLinesTable)
    .innerJoin(financeJournalEntriesTable, eq(financeJournalLinesTable.journalEntryId, financeJournalEntriesTable.id))
    .where(and(...conditions))
    .groupBy(financeJournalLinesTable.accountId);

  if (sums.length === 0) return [];
  const accounts = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.bookId, resolvedBookId)));
  const accountsById = new Map(accounts.map(a => [a.id, a]));

  return sums
    .map(s => {
      const acc = accountsById.get(s.accountId);
      if (!acc) return null;
      const totalDebit = Number(s.totalDebit) || 0;
      const totalCredit = Number(s.totalCredit) || 0;
      const balance = acc.normalBalance === "debit" ? totalDebit - totalCredit : totalCredit - totalDebit;
      const row: AccountBalanceRow = { accountId: acc.id, code: acc.code, name: acc.name, type: acc.type as AccountType, totalDebit, totalCredit, balance };
      return row;
    })
    .filter((r): r is AccountBalanceRow => !!r && (r.totalDebit > 0 || r.totalCredit > 0))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ─── Amortization ────────────────────────────────────────────────────────────

// BUG FIX: `d.setMonth(d.getMonth() + n)` on a day-of-month that doesn't
// exist in the target month rolls over into the *following* month instead
// of clamping — e.g. Jan 31 + 1 month lands on Mar 2/3, not Feb 28/29,
// because JS Date silently overflows. For a loan/amortization or
// depreciation schedule anchored on the 29th–31st, that pushed every
// subsequent installment/period date later and later (or skipped a month
// outright), instead of landing on the last day of the intended month.
// Clamp to the last valid day of the target month so schedules stay on a
// regular monthly cadence regardless of which day they started on.
function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1); // avoid overflow while shifting the month
  d.setMonth(d.getMonth() + n);
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTargetMonth));
  return d;
}

export interface AmortizationRowShape {
  id: number;
  ledgerEntryId: number;
  installmentNo: number;
  dueDate: string;
  principalDue: number;
  interestDue: number;
  totalDue: number;
  remainingBalance: number;
  status: string;
  paidAt: string | null;
}

function fmtAmortRow(r: typeof financeAmortizationTable.$inferSelect): AmortizationRowShape {
  return {
    id: r.id,
    ledgerEntryId: r.ledgerEntryId,
    installmentNo: r.installmentNo,
    dueDate: r.dueDate.toISOString(),
    principalDue: r.principalDue,
    interestDue: r.interestDue,
    totalDue: r.totalDue,
    remainingBalance: r.remainingBalance,
    status: r.status,
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  };
}

/** Equal-principal amortization schedule. Wipes any existing schedule for the entry (including paid rows). */
export async function generateAmortizationSchedule(entry: FinanceLedgerEntry, termMonths: number): Promise<AmortizationRowShape[]> {
  await db.delete(financeAmortizationTable).where(eq(financeAmortizationTable.ledgerEntryId, entry.id));

  const principal = entry.amount || 0;
  const annualRate = entry.interestRate || 0;
  const monthlyPrincipal = principal / termMonths;
  const monthlyRate = annualRate / 100 / 12;
  // Anchor the schedule to when the loan originated, not its (single) final
  // due date — occurredDate is when the principal changed hands, so
  // installment #1 should land one period after that. Using dueDate first
  // would start counting installments from the loan's final due date
  // forward, pushing every generated installment date months/years past
  // where it belongs whenever an entry has both fields set (the normal
  // case for borrowed/lending entries).
  const startDate = entry.occurredDate ?? entry.dueDate ?? new Date();

  let remaining = principal;
  const rows: (typeof financeAmortizationTable.$inferInsert)[] = [];
  for (let i = 1; i <= termMonths; i++) {
    const interestDue = Math.max(0, remaining * monthlyRate);
    const principalDue = i === termMonths ? remaining : monthlyPrincipal;
    remaining = Math.max(0, remaining - principalDue);
    rows.push({
      userId: entry.userId,
      ledgerEntryId: entry.id,
      installmentNo: i,
      dueDate: addMonths(startDate, i),
      principalDue,
      interestDue,
      totalDue: principalDue + interestDue,
      remainingBalance: remaining,
      status: "upcoming",
    });
  }
  const inserted = await db.insert(financeAmortizationTable).values(rows).returning();
  return inserted.map(fmtAmortRow);
}

export async function listAmortizationForEntry(entryId: number): Promise<AmortizationRowShape[]> {
  const rows = await db.select().from(financeAmortizationTable)
    .where(eq(financeAmortizationTable.ledgerEntryId, entryId))
    .orderBy(financeAmortizationTable.installmentNo);
  return rows.map(fmtAmortRow);
}

// ─── Depreciation ────────────────────────────────────────────────────────────

export interface DepreciationRowShape {
  id: number;
  assetId: number;
  periodNo: number;
  periodDate: string;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  bookValue: number;
  status: string;
  postedAt: string | null;
}

function fmtDeprecRow(r: typeof financeDepreciationTable.$inferSelect): DepreciationRowShape {
  return {
    id: r.id,
    assetId: r.assetId,
    periodNo: r.periodNo,
    periodDate: r.periodDate.toISOString(),
    depreciationAmount: r.depreciationAmount,
    accumulatedDepreciation: r.accumulatedDepreciation,
    bookValue: r.bookValue,
    status: r.status,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
  };
}

/**
 * Monthly depreciation schedule for an asset. Wipes any existing (unposted or
 * posted) schedule for the asset — same "regenerate from scratch" behavior as
 * generateAmortizationSchedule. Caller is responsible for not calling this
 * again after periods have already been posted unless they mean to redo it
 * (posted journal entries from the old schedule are left as-is; only the
 * schedule rows themselves are replaced).
 *
 * straight_line: (cost - salvage) / usefulLifeMonths every period.
 * declining_balance: 2x straight-line rate applied to the *current* book
 * value each period (double-declining balance), floored so book value never
 * drops below salvage. Double-declining balance is asymptotic by nature —
 * left alone it approaches but never actually reaches salvage — so, same as
 * straight_line, the final period absorbs whatever book value remains
 * rather than the formula amount, ensuring the asset is fully depreciated
 * to salvage by the end of its usefulLifeMonths instead of being stuck
 * permanently above it.
 */
export async function generateDepreciationSchedule(asset: FinanceAsset): Promise<DepreciationRowShape[]> {
  if (!asset.depreciationMethod || !asset.usefulLifeMonths || asset.usefulLifeMonths <= 0) return [];
  await db.delete(financeDepreciationTable).where(eq(financeDepreciationTable.assetId, asset.id));

  const cost = asset.purchasedValue ?? asset.totalValue ?? 0;
  const salvage = asset.salvageValue ?? 0;
  const months = asset.usefulLifeMonths;
  const startDate = asset.depreciationStartDate ?? asset.purchaseDate ?? new Date();
  const depreciableBase = Math.max(0, cost - salvage);
  const straightLineAmount = depreciableBase / months;
  const doubleRate = (2 / months);

  let bookValue = cost;
  let accumulated = 0;
  const rows: (typeof financeDepreciationTable.$inferInsert)[] = [];
  for (let i = 1; i <= months; i++) {
    let amount: number;
    if (asset.depreciationMethod === "declining_balance") {
      // BUG FIX: double-declining-balance applies the rate to the current
      // *book value* each period (amount = bookValue * (2 / usefulLife)) —
      // salvage value is only meant to act as a floor the schedule can't
      // depreciate below, not something subtracted from the base before
      // the rate is applied. The previous formula computed
      // `(bookValue - salvage) * doubleRate`, which understates every
      // period's depreciation (and, compounded over the schedule,
      // understates accumulated depreciation) versus the standard method
      // any accountant/auditor would expect from "declining balance".
      amount = i === months
        ? Math.max(0, bookValue - salvage) // last period absorbs whatever's left so book value lands exactly on salvage
        : Math.min(Math.max(0, bookValue) * doubleRate, Math.max(0, bookValue - salvage));
    } else {
      amount = i === months ? Math.max(0, depreciableBase - accumulated) : straightLineAmount; // last period absorbs rounding
    }
    accumulated += amount;
    bookValue = Math.max(salvage, cost - accumulated);
    rows.push({
      userId: asset.userId,
      assetId: asset.id,
      periodNo: i,
      periodDate: addMonths(startDate, i),
      depreciationAmount: amount,
      accumulatedDepreciation: accumulated,
      bookValue,
      status: "upcoming",
    });
  }
  const inserted = await db.insert(financeDepreciationTable).values(rows).returning();
  return inserted.map(fmtDeprecRow);
}

export async function listDepreciationForAsset(assetId: number): Promise<DepreciationRowShape[]> {
  const rows = await db.select().from(financeDepreciationTable)
    .where(eq(financeDepreciationTable.assetId, assetId))
    .orderBy(financeDepreciationTable.periodNo);
  return rows.map(fmtDeprecRow);
}

/** Post one depreciation period's journal entry: Depreciation Expense (dr) / Accumulated Depreciation (cr). */
export async function postDepreciationJournal(userId: number, assetName: string, periodDate: Date, amount: number): Promise<void> {
  if (!(amount > 0)) return;
  await postJournal(userId, {
    memo: `Depreciation — ${assetName}`,
    date: periodDate,
    lines: [
      { accountCode: "5200", debit: amount, credit: 0 },
      { accountCode: "1350", debit: 0, credit: amount },
    ],
    isManual: false,
  });
}

export { fmtAmortRow };

// ─── Public receipt/invoice link (shared by the manual "Share receipt"
// button in routes/finance.ts and the auto-invoice-on-create flow in
// lib/finance-notify.ts) ───────────────────────────────────────────────────

/** Random, unguessable, url-safe token — possession is the only "auth" for GET /finance/receipt/:token(/pdf). */
export function generateReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function financeReceiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/finance/receipt/${receiptToken}`;
}

/** Idempotently ensure a ledger entry has a public receipt/invoice token, minting one if missing. Returns null if the entry doesn't exist or minting failed after retries. */
export async function ensureReceiptToken(entryId: number, userId: number): Promise<string | null> {
  const [entry] = await db.select({ receiptToken: financeLedgerEntriesTable.receiptToken })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  if (!entry) return null;
  if (entry.receiptToken) return entry.receiptToken;

  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = generateReceiptToken();
    try {
      const [row] = await db.update(financeLedgerEntriesTable)
        .set({ receiptToken: candidate, updatedAt: new Date() })
        .where(eq(financeLedgerEntriesTable.id, entryId))
        .returning({ receiptToken: financeLedgerEntriesTable.receiptToken });
      if (row?.receiptToken) return row.receiptToken;
    } catch { /* unique collision — loop and retry */ }
  }
  return null;
}
