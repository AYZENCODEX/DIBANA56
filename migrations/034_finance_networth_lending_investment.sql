-- 034_finance_networth_lending_investment.sql
-- Bug fix: computeNetWorthBreakdown (lib/finance-networth.ts) only ever
-- folded in receivable/payable/borrowed + the Assets table — kind 'lending'
-- (money lent out) and kind 'investment' (money invested) were silently
-- excluded from both the live Net Worth / Current Balance figures and the
-- monthly trend snapshot, even though both are real assets already tracked
-- in the double-entry Chart of Accounts (1200 Loans Receivable, 1300
-- Investments) and treated as asset-like elsewhere (e.g. Insights'
-- totalReceivableLike). Adds the two missing columns so the monthly
-- snapshot can carry them alongside the existing breakdown fields.
ALTER TABLE finance_net_worth_snapshots ADD COLUMN IF NOT EXISTS total_lending REAL NOT NULL DEFAULT 0;
ALTER TABLE finance_net_worth_snapshots ADD COLUMN IF NOT EXISTS total_invested REAL NOT NULL DEFAULT 0;
